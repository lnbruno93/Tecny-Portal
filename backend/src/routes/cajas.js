const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const requireCapability = require('../middleware/requireCapability');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { round2, assertMonedaValidaParaPais } = require('../lib/money');
const { createTenantScopedCache } = require('../lib/cacheTtl');
const { CAJAS_RESUMEN } = require('../lib/cacheConfig');
const { getCajasList, invalidateCajas } = require('../lib/cajasCache');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const {
  createDeudaSchema, queryDeudasSchema,
  createInversionSchema, queryInversionesSchema,
  cajaSchema, updateCajaSchema, cajaAjusteSchema, cajaRelevoSchema, queryLedgerSchema,
} = require('../schemas/cajas');
const { requiereTc } = require('../schemas/_common');


// ─── DEUDAS ─────────────────────────────────────────────────

router.get('/deudas', validate(queryDeudasSchema, 'query'), async (req, res, next) => {
  try {
    const { contacto_id } = req.query;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    let where = 'WHERE c.deleted_at IS NULL AND m.deleted_at IS NULL';
    const params = [];
    if (contacto_id) { params.push(contacto_id); where += ` AND m.contacto_id = $${params.length}`; }

    const baseQuery = `
      FROM movimientos_deudas m
      JOIN contactos c ON c.id = m.contacto_id
      ${where}
    `;

    // 2026-06-15 multi-tenant (PR 4.5): count + data en una sola withTenant.
    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(`SELECT COUNT(*) ${baseQuery}`, params);
      const dataRes = await client.query(
        `SELECT m.id, m.fecha, m.contacto_id, m.tipo AS mov_tipo,
                m.monto_ars, m.monto_usd, m.concepto, m.created_at,
                m.caja_id, m.tc,
                c.nombre, c.apellido, c.tipo AS contacto_tipo
         ${baseQuery}
         ORDER BY m.fecha DESC, m.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });

    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/deudas', requireCapability('cajas.crear'), validate(createDeudaSchema), async (req, res, next) => {
  // Mega-form transaccional (post-auditoría TANDA 0): si viene `contacto_nuevo`,
  // se crea el contacto + el movimiento en una sola tx. Si falla el INSERT del
  // movimiento, el contacto se revierte → no quedan contactos huérfanos. Antes
  // el frontend hacía 2 requests separados y un error en el 2do dejaba data inconsistente.
  //
  // 2026-08-03 (task caja trazabilidad): además, si viene `caja_id`, creamos
  // atomicamente un caja_movimiento reflejando el flujo real del dinero:
  //   - tipo=pago  → caja recibe cash (ingreso). REQUERIDO por Zod refine.
  //   - tipo=debe  → caja entrega cash (egreso). OPCIONAL — el user puede
  //     omitir si es una deuda "en el aire" (ej. prometí pagar Netflix).
  // Todo en la misma tx: si postCajaMovimiento falla (saldo insuf, moneda
  // mismatch, caja borrada), se rollback la deuda también. Nada de estado
  // inconsistente.
  const client = await db.connect();
  try {
    const { fecha, contacto_id, contacto_nuevo, tipo, monto_ars, monto_usd, concepto, caja_id, tc } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    // Resolver contacto: usar el id existente, o crear uno nuevo en la misma tx.
    let cid = contacto_id;
    if (contacto_nuevo) {
      const { rows: c } = await client.query(
        `INSERT INTO contactos (nombre, apellido, tipo, origen)
         VALUES ($1, $2, $3, 'manual')
         RETURNING *`,
        [contacto_nuevo.nombre, contacto_nuevo.apellido ?? null, contacto_nuevo.tipo ?? 'amigo']
      );
      cid = c[0].id;
      await audit(client, 'contactos', 'INSERT', cid, { despues: c[0], _origen: 'mega_form_deuda', user_id: req.user.id });
    }

    const { rows } = await client.query(
      `INSERT INTO movimientos_deudas (fecha, contacto_id, tipo, monto_ars, monto_usd, concepto, caja_id, tc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [fecha, cid, tipo, monto_ars, monto_usd, concepto ?? null, caja_id ?? null, tc ?? null]
    );
    await audit(client, 'movimientos_deudas', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });

    // Espejar en caja_movimientos si el user linkeó una caja. El helper
    // postCajaMovimiento valida moneda/saldo/lock; si falla, rollback total.
    if (caja_id) {
      const { rows: cajaRows } = await client.query(
        'SELECT moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL',
        [caja_id]
      );
      if (!cajaRows[0]) {
        const e = new Error('La caja seleccionada no existe.'); e.status = 400; throw e;
      }
      const cajaMoneda = cajaRows[0].moneda;
      // Elegir monto según moneda de la caja. `movimientos_deudas` solo tiene
      // monto_ars y monto_usd (no monto_uyu) — si caja es UYU, no hay match
      // posible. Rechazamos explícitamente para no dejar caja_movimiento
      // "invisible" (silent no-op sería data inconsistency: la deuda se
      // cierra pero la caja no crece).
      let monto = 0;
      if (cajaMoneda === 'ARS') {
        monto = Number(monto_ars || 0);
      } else if (cajaMoneda === 'USD' || cajaMoneda === 'USDT') {
        monto = Number(monto_usd || 0);
      } else {
        const e = new Error(`La moneda de la caja (${cajaMoneda}) no está soportada en pagos de deuda. Usá una caja ARS o USD/USDT.`);
        e.status = 400; throw e;
      }
      if (monto <= 0) {
        const e = new Error(`Elegiste una caja ${cajaMoneda} pero el monto ${cajaMoneda === 'ARS' ? 'ARS' : 'USD'} es 0. Poné el monto o cambiá de caja.`);
        e.status = 400; throw e;
      }
      await postCajaMovimiento(client, {
        caja_id,
        fecha,
        tipo:     tipo === 'pago' ? 'ingreso' : 'egreso',
        monto,
        moneda:   cajaMoneda,
        tc:       tc ?? null,
        origen:   'deuda',
        ref_tabla:'movimientos_deudas',
        ref_id:   rows[0].id,
        concepto: concepto ?? (tipo === 'pago' ? 'Cobro de deuda' : 'Préstamo entregado'),
        user_id:  req.user.id,
      });
    }

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/deudas/:id', requireCapability('cajas.crear'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // 2026-08-03 (task caja trazabilidad): además del soft-delete de la
    // deuda, revertimos el caja_movimiento asociado (si existe) para que
    // el saldo de la caja se restaure. `reverseCajaMovimientos` valida que
    // el reverse no deje la caja en negativo (409 si sí) — protección
    // contra "anular un cobro histórico dejaría la caja quebrada porque
    // ya se gastó ese dinero".
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE movimientos_deudas SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
        [id]
      );
      if (!rows[0]) return null;
      // Revert caja_movimiento (si la deuda tenía caja linkeada). No-op
      // silencioso para deudas legacy (caja_id NULL → 0 movimientos que reversar).
      await reverseCajaMovimientos(client, 'movimientos_deudas', id);
      await audit(client, 'movimientos_deudas', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Movimiento no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── INVERSIONES ────────────────────────────────────────────

router.get('/inversiones', validate(queryInversionesSchema, 'query'), async (req, res, next) => {
  try {
    const { contacto_id } = req.query;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    let where = 'WHERE c.deleted_at IS NULL AND m.deleted_at IS NULL';
    const params = [];
    if (contacto_id) { params.push(contacto_id); where += ` AND m.contacto_id = $${params.length}`; }

    const baseQuery = `
      FROM movimientos_inversiones m
      JOIN contactos c ON c.id = m.contacto_id
      ${where}
    `;

    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(`SELECT COUNT(*) ${baseQuery}`, params);
      const dataRes = await client.query(
        `SELECT m.id, m.fecha, m.contacto_id, m.monto, m.tasa, m.created_at,
                m.caja_id, m.tc,
                c.nombre, c.apellido, c.tipo AS contacto_tipo
         ${baseQuery}
         ORDER BY m.fecha DESC, m.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });

    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/inversiones', requireCapability('cajas.crear'), validate(createInversionSchema), async (req, res, next) => {
  // Mega-form transaccional (ver comentario equivalente en POST /deudas).
  //
  // 2026-08-03 (task caja trazabilidad): caja_id es REQUERIDO por Zod
  // (createInversionSchema) — una inversión SIEMPRE alimenta una caja
  // concreta (el capital del inversor entra a algún lado: efectivo,
  // banco, USDT, etc.). Espejamos un caja_movimiento tipo=ingreso
  // atomicamente en la misma tx.
  const client = await db.connect();
  try {
    const { fecha, contacto_id, contacto_nuevo, monto, tasa, caja_id, tc } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    let cid = contacto_id;
    if (contacto_nuevo) {
      const { rows: c } = await client.query(
        `INSERT INTO contactos (nombre, apellido, tipo, origen)
         VALUES ($1, $2, $3, 'manual')
         RETURNING *`,
        [contacto_nuevo.nombre, contacto_nuevo.apellido ?? null, contacto_nuevo.tipo ?? 'inversor']
      );
      cid = c[0].id;
      await audit(client, 'contactos', 'INSERT', cid, { despues: c[0], _origen: 'mega_form_inversion', user_id: req.user.id });
    }

    const { rows } = await client.query(
      `INSERT INTO movimientos_inversiones (fecha, contacto_id, monto, tasa, caja_id, tc)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [fecha, cid, monto, tasa ?? null, caja_id, tc ?? null]
    );
    await audit(client, 'movimientos_inversiones', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });

    // Espejar en caja_movimientos. Las inversiones son USD por diseño del
    // modal (createInversionSchema.monto es 1 solo número USD-nominal). Si
    // la caja destino es de otra moneda (ARS/UYU), el helper falla con
    // moneda mismatch — el frontend debe forzar caja USD/USDT en el select.
    const { rows: cajaRows } = await client.query(
      'SELECT moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL',
      [caja_id]
    );
    if (!cajaRows[0]) {
      const e = new Error('La caja seleccionada no existe.'); e.status = 400; throw e;
    }
    await postCajaMovimiento(client, {
      caja_id,
      fecha,
      tipo:     'ingreso',
      monto:    Number(monto),
      moneda:   cajaRows[0].moneda,
      tc:       tc ?? null,
      origen:   'inversion',
      ref_tabla:'movimientos_inversiones',
      ref_id:   rows[0].id,
      concepto: tasa ? `Inversión (${tasa})` : 'Inversión',
      user_id:  req.user.id,
    });

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/inversiones/:id', requireCapability('cajas.crear'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // 2026-08-03: revertir caja_movimiento asociado (si existe). Ver
    // comentario equivalente en DELETE /deudas/:id.
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE movimientos_inversiones SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
        [id]
      );
      if (!rows[0]) return null;
      await reverseCajaMovimientos(client, 'movimientos_inversiones', id);
      await audit(client, 'movimientos_inversiones', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Inversión no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── CAJAS (cuentas de dinero = metodos_pago) ───────────────
// Gestión central de las cajas donde caen los pagos. La lista de ventas
// (GET /api/ventas/metodos-pago) lee solo las activas; acá se administran todas.

router.get('/cajas', async (req, res, next) => {
  // Perf H3 auditoría 2026-06-06: lectura cacheada (15s TTL) — la query
  // hace LEFT JOIN + GROUP BY sobre caja_movimientos (saldo_actual), pesada
  // y se llama mucho desde dropdowns de pago en varios módulos. Invalidación
  // explícita en escrituras a metodos_pago / caja_movimientos. Ver
  // backend/src/lib/cajasCache.js para detalles del trade-off multi-instance.
  //
  // PR 4.9 (2026-06-15): cache ahora es per-tenant — getCajasList(req.tenantId).
  try {
    res.json(await getCajasList(req.tenantId));
  } catch (err) { next(err); }
});

// Reporte de cajas con saldo negativo — útil para regularizar datos viejos
// antes de que el lock de "no negativo" empezara a aplicarse en POST.
// Devuelve lista plana: { id, nombre, moneda, saldo_actual }.
//
// 2026-07-12 (auditoría TOTAL Financiero P3-4): requireCapability('cajas.crear').
// Antes solo gate por `cajas.ver` del app.js (que tienen vendedores). Este
// reporte es info sensible (data hygiene interna) — un vendedor no debería
// ver el estado de saldos negativos internos.
router.get('/cajas/negativas', requireCapability('cajas.crear'), async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT mp.id, mp.nombre, mp.moneda,
                mp.saldo_inicial + COALESCE(SUM(CASE WHEN cm.tipo='ingreso' THEN cm.monto ELSE -cm.monto END), 0) AS saldo_actual
           FROM metodos_pago mp
           LEFT JOIN caja_movimientos cm ON cm.caja_id = mp.id AND cm.deleted_at IS NULL
          WHERE mp.deleted_at IS NULL
          GROUP BY mp.id
         HAVING mp.saldo_inicial + COALESCE(SUM(CASE WHEN cm.tipo='ingreso' THEN cm.monto ELSE -cm.monto END), 0) < 0
          ORDER BY (mp.saldo_inicial + COALESCE(SUM(CASE WHEN cm.tipo='ingreso' THEN cm.monto ELSE -cm.monto END), 0)) ASC`
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

// 2026-06-23 F5a: gate inline. Crear una caja nueva (método de pago) es
// config sensible — capability propia `cajas.crear`. Owner/admin del
// tenant bypassean. El resto de los roles NO la tienen en default.
router.post('/cajas', requireCapability('cajas.crear'), validate(cajaSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { nombre, moneda, activo, orden, saldo_inicial, es_financiera, es_tarjeta, comision_pct } = req.body;
    // Multi-país F2: la caja no puede tener una moneda no habilitada para el
    // país del tenant (tenant AR no abre caja UYU, tenant UY no abre caja ARS).
    assertMonedaValidaParaPais(moneda, req.tenantPais, 'moneda');
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );
    if (es_financiera) await client.query('UPDATE metodos_pago SET es_financiera = false WHERE es_financiera = true');
    // Cast explícito de saldo_inicial (2026-07-05): el `COALESCE($5, 0)` sin
    // cast infería `$5` como int4 (por el literal `0`), lo que:
    //   1) truncaba decimales silenciosamente (saldo_inicial=100.5 → 100),
    //   2) overflow "value out of range for type integer" cuando el operador
    //      cargaba montos > 2_147_483_647 (INT_MAX), llegando como 500 crudo
    //      al frontend (Sentry P2).
    // `COALESCE($5::numeric, 0)` fuerza la inferencia hacia numeric(14,2) que
    // es el tipo real de la columna, respetando los decimales. Mismo cambio
    // aplicado en el UPDATE de más abajo.
    const { rows } = await client.query(
      `INSERT INTO metodos_pago (nombre, moneda, activo, orden, saldo_inicial, es_financiera, es_tarjeta, comision_pct)
       VALUES ($1, $2, COALESCE($3, true), COALESCE($4, 0), COALESCE($5::numeric, 0), COALESCE($6, false), COALESCE($7, false), $8)
       RETURNING id, nombre, moneda, activo, orden, saldo_inicial, es_financiera, es_tarjeta, comision_pct`,
      [nombre, moneda, activo ?? null, orden ?? null, saldo_inicial ?? null, es_financiera ?? null, es_tarjeta ?? null, es_tarjeta ? (comision_pct ?? null) : null]
    );
    // audit dentro de la tx con SAVEPOINT — antes corría post-COMMIT con el pool
    // global, lo que dejaba una ventana de "cambio commiteado pero audit no" si
    // el proceso moría entre las dos llamadas. Mismo patrón en cajas.js (PUT),
    // cambios.js, egresos.js, cuentas.js, proveedores.js y tarjetas.js (Ola 3).
    await audit(client, 'metodos_pago', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    invalidateCajas(req.tenantId);  // Perf H3: forzar refresh del cache tras crear caja
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una caja con ese nombre' });
    next(err);
  } finally { client.release(); }
});

// Auditoría 2026-06-30 D-01: cambiar `comision_pct` de un método tarjeta SOLO
// afecta cobros NUEVOS. Las ventas históricas tienen el % snapshoteado en
// venta_pagos.comision_pct_snapshot — syncTarjetaCobros lo lee de ahí, no de
// metodos_pago. Eliminamos cualquier "propagación retroactiva".
router.put('/cajas/:id', requireCapability('cajas.crear'), validate(updateCajaSchema), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  // Multi-país F2: si el PUT trae `moneda`, validar país-aware.
  if (req.body.moneda !== undefined) {
    try {
      assertMonedaValidaParaPais(req.body.moneda, req.tenantPais, 'moneda');
    } catch (err) {
      return next(err);
    }
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );
    const before = await client.query('SELECT * FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Caja no encontrada' }); }

    const { nombre, moneda, activo, orden, saldo_inicial, es_financiera, es_tarjeta, comision_pct } = req.body;
    // Solo una caja puede ser la financiera: desmarcar las demás
    if (es_financiera === true) await client.query('UPDATE metodos_pago SET es_financiera = false WHERE es_financiera = true AND id <> $1', [id]);
    // Valores finales del flag/comisión de tarjeta (evita borrarlos en updates parciales).
    // Si se marca es_tarjeta=false, se limpia la comisión.
    const b0 = before.rows[0];
    const finalEsTarjeta = es_tarjeta ?? b0.es_tarjeta;
    const finalComision = finalEsTarjeta === false ? null : (comision_pct !== undefined ? comision_pct : b0.comision_pct);
    const { rows } = await client.query(
      // Cast explícito ::numeric del saldo_inicial — ver comentario en el POST
      // (línea ~267). Preserva decimales y evita overflow silencioso.
      `UPDATE metodos_pago SET
         nombre        = COALESCE($1, nombre),
         moneda        = COALESCE($2, moneda),
         activo        = COALESCE($3, activo),
         orden         = COALESCE($4, orden),
         saldo_inicial = COALESCE($5::numeric, saldo_inicial),
         es_financiera = COALESCE($6, es_financiera),
         es_tarjeta    = $7,
         comision_pct  = $8
       WHERE id = $9 RETURNING id, nombre, moneda, activo, orden, saldo_inicial, es_financiera, es_tarjeta, comision_pct`,
      [nombre ?? null, moneda ?? null, activo ?? null, orden ?? null, saldo_inicial ?? null, es_financiera ?? null,
       finalEsTarjeta, finalComision, id]
    );
    await audit(client, 'metodos_pago', 'UPDATE', id, { antes: before.rows[0], despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    invalidateCajas(req.tenantId);  // Perf H3: refresh cache (cambió nombre/saldo_inicial/flags)
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una caja con ese nombre' });
    next(err);
  } finally { client.release(); }
});

router.delete('/cajas/:id', requireCapability('cajas.crear'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // 2026-06-15 multi-tenant (PR 4.5): toda la cadena (lookup + checks +
    // UPDATE + audit) en una sola withTenant para que comparta el SET LOCAL
    // y el audit corra in-tx (antes audit('metodos_pago', ...) sin client
    // iba con el pool global, sin tenant context).
    const result = await db.withTenant(req.tenantId, async (client) => {
      const { rows: caja } = await client.query('SELECT * FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!caja[0]) return { notFound: true };
      // No permitir borrar una caja en uso: perdería trazabilidad de dinero ya registrado.
      if (caja[0].es_financiera) return { conflict: 'No se puede borrar: es la caja Financiera. Desmarcala primero.' };
      if (caja[0].es_tarjeta)    return { conflict: 'No se puede borrar: es un método tarjeta. Desmarcá "Es tarjeta" primero.' };
      const { rows: mov } = await client.query('SELECT 1 FROM caja_movimientos WHERE caja_id = $1 AND deleted_at IS NULL LIMIT 1', [id]);
      const { rows: egr } = await client.query("SELECT 1 FROM egresos WHERE metodo_pago_id = $1 AND estado = 'pendiente' AND deleted_at IS NULL LIMIT 1", [id]);
      if (mov[0]) return { conflict: 'No se puede borrar: tiene movimientos registrados. Desactivala en su lugar.' };
      if (egr[0]) return { conflict: 'No se puede borrar: tiene egresos pendientes asociados.' };

      const { rows } = await client.query(
        'UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
      );
      if (!rows[0]) return { notFound: true };
      await audit(client, 'metodos_pago', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return { ok: true };
    });
    if (result.notFound) return res.status(404).json({ error: 'Caja no encontrada' });
    if (result.conflict) return res.status(409).json({ error: result.conflict });
    invalidateCajas(req.tenantId);  // Perf H3: caja soft-deleted desaparece del listado
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── MOVIMIENTOS DE CAJA (ledger) ───────────────────────────

// Ledger global: movimientos de TODAS las cajas con filtros + totales (vista dedicada).
// Totales en USD (denominador común; movimientos ARS sin TC aportan 0 USD).
router.get('/movimientos', validate(queryLedgerSchema, 'query'), async (req, res, next) => {
  try {
    const { caja_id, desde, hasta, origen, tipo } = req.query;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });

    const conditions = ['cm.deleted_at IS NULL'];
    const params = [];
    if (caja_id) { params.push(caja_id); conditions.push(`cm.caja_id = $${params.length}`); }
    if (desde)   { params.push(desde);   conditions.push(`cm.fecha >= $${params.length}`); }
    if (hasta)   { params.push(hasta);   conditions.push(`cm.fecha <= $${params.length}`); }
    if (origen)  { params.push(origen);  conditions.push(`cm.origen = $${params.length}`); }
    if (tipo)    { params.push(tipo);    conditions.push(`cm.tipo = $${params.length}`); }
    const where = conditions.join(' AND ');
    const baseFrom = `FROM caja_movimientos cm JOIN metodos_pago mp ON mp.id = cm.caja_id WHERE ${where}`;

    const { count, ingresos_usd_raw, egresos_usd_raw, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(`SELECT COUNT(*) ${baseFrom}`, params);
      const totRes = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN cm.tipo = 'ingreso' THEN cm.monto_usd ELSE 0 END), 0) AS ingresos_usd,
           COALESCE(SUM(CASE WHEN cm.tipo = 'egreso'  THEN cm.monto_usd ELSE 0 END), 0) AS egresos_usd
         ${baseFrom}`, params);
      const dataRes = await client.query(
        `SELECT cm.id, cm.fecha, cm.caja_id, mp.nombre AS caja_nombre, mp.moneda,
                cm.tipo, cm.monto, cm.monto_usd, cm.origen, cm.ref_tabla, cm.ref_id, cm.concepto, cm.created_at
         ${baseFrom}
         ORDER BY cm.fecha DESC, cm.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]);
      return {
        count: parseInt(countRes.rows[0].count),
        ingresos_usd_raw: totRes.rows[0].ingresos_usd,
        egresos_usd_raw: totRes.rows[0].egresos_usd,
        dataRows: dataRes.rows,
      };
    });

    const ingresos_usd = round2(Number(ingresos_usd_raw));
    const egresos_usd  = round2(Number(egresos_usd_raw));
    res.json({
      ...paginatedResponse(dataRows, count, { page, limit }),
      totales: { ingresos_usd, egresos_usd, neto_usd: round2(ingresos_usd - egresos_usd), count },
    });
  } catch (err) { next(err); }
});

// Historial de movimientos de una caja (paginado — esta tabla crece rápido)
router.get('/cajas/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query('SELECT COUNT(*) FROM caja_movimientos WHERE caja_id = $1 AND deleted_at IS NULL', [id]);
      const dataRes = await client.query(
        `SELECT id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, created_at
           FROM caja_movimientos
          WHERE caja_id = $1 AND deleted_at IS NULL
          ORDER BY fecha DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      );
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });
    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) { next(err); }
});

// Ajuste manual de caja (ingreso/egreso suelto). Para correcciones / arqueo.
//
// H4 auditoría 2026-06: ahora envuelto en una tx con `postCajaMovimiento`
// (FOR UPDATE sobre metodos_pago + validación atómica de saldo). Antes era:
//   SELECT saldo → (gap TOCTOU) → INSERT
// Dos egresos concurrentes contra una caja con saldo justo podían ambos
// pasar el check y dejarla en negativo. Ahora el lock serializa.
router.post('/cajas/:id/movimientos', requireCapability('cajas.crear'), validate(cajaAjusteSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // 2026-06-15 multi-tenant (PR 4.5): pre-check + tx en una sola withTenant.
    // Antes el pre-check usaba db.query (sin tenant context) y la tx usaba
    // withTx (que no setea SET LOCAL). Ahora todo bajo el mismo SET LOCAL —
    // RLS bloquea el pre-check si la caja es de otro tenant.
    //
    // Nota: usamos db.withTenant en lugar de withTx para tener BEGIN+SET LOCAL
    // automáticos. La validación 400 de moneda ARS sin TC sigue ANTES del
    // withTenant para que un error de input no abra una tx innecesaria.
    const { fecha, tipo, monto, tc, concepto } = req.body;

    try {
      const result = await db.withTenant(req.tenantId, async (client) => {
        const { rows: cajaRows } = await client.query(
          'SELECT id, moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL',
          [id]
        );
        if (!cajaRows[0]) return { notFound: true };

        const moneda = cajaRows[0].moneda;
        // 2026-07-08 Multi-país F2 backfill: antes solo cubría ARS; UYU tenía
        // el mismo bug (ajuste manual UYU sin TC → monto_usd=0 → saldo caja
        // en USD equiv. mentiroso en historiales cross-moneda).
        if (requiereTc(moneda) && !(tc && tc > 0)) {
          return { badRequest: `Para una caja en ${moneda} se requiere el tipo de cambio (tc)` };
        }

        const mov = await postCajaMovimiento(client, {
          caja_id: id,
          fecha,
          tipo,
          monto,
          moneda,
          tc,
          origen: 'ajuste',
          ref_tabla: null,
          ref_id:    null,
          concepto:  concepto ?? null,
          user_id:   req.user.id,
        });
        // Audit dentro de la tx (con SAVEPOINT) — atómico con el INSERT.
        if (mov) {
          await audit(client, 'caja_movimientos', 'INSERT', mov.id, {
            despues: mov, user_id: req.user.id,
          });
        }
        return { mov };
      });
      if (result.notFound)   return res.status(404).json({ error: 'Caja no encontrada' });
      if (result.badRequest) return res.status(400).json({ error: result.badRequest });
      if (!result.mov)       return res.status(400).json({ error: 'No se pudo crear el movimiento.' });
      invalidateCajas(req.tenantId);  // Perf H3: nuevo movimiento mueve saldo_actual
      res.status(201).json(result.mov);
    } catch (err) {
      // postCajaMovimiento usa err.status (400 para saldo insuficiente,
      // moneda mal, etc.). Si trae status, devolverlo; sino propagar.
      if (err.status) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  } catch (err) { next(err); }
});

// Borrar un movimiento manual (solo ajustes; los de otros módulos se revierten desde su módulo)
router.delete('/cajas/movimientos/:id', requireCapability('cajas.crear'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE caja_movimientos SET deleted_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL AND origen = 'ajuste' RETURNING *`, [id]
      );
      if (!rows[0]) return null;
      await audit(client, 'caja_movimientos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Movimiento de ajuste no encontrado' });
    invalidateCajas(req.tenantId);  // Perf H3: reversión recalcula saldo_actual
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── RELEVO ────────────────────────────────────────────────────────
//
// POST /cajas/:id/relevo — ajuste manual del saldo real (arqueo).
//
// Feature 2026-07-29: el user con capability `cajas.relevar` (owner/admin
// por default) ajusta el saldo de una caja al valor real. Casos de uso:
//   - Arqueo físico revela diferencia (más o menos plata que la del sistema).
//   - Pago olvidado (le pagué al proveedor en efectivo, nunca cargué).
//   - Gasto fuera del sistema (compré algo, no lo anoté).
//   - Devolución recibida no registrada.
//   - Cierre de cuenta con ajuste final.
//
// UX: el user ingresa `saldo_nuevo` (lo que ES la caja). El server calcula
// `delta = saldo_nuevo - saldo_actual`, deriva `tipo` (+/-) y `monto`
// (abs), y crea un caja_movimientos con `origen='relevo'`.
//
// Diferencia con POST /cajas/:id/movimientos (ajuste manual):
//   - Ajuste manual: user ingresa monto + tipo directamente.
//   - Relevo: user ingresa saldo_nuevo, server deriva monto + tipo.
//   - Ajuste: nota opcional. Relevo: nota OBLIGATORIA (min 10 chars).
//   - Ajuste: capability `cajas.crear`. Relevo: `cajas.relevar` (más
//     restrictiva — solo owner/admin por default via role bypass).
//   - Ajuste: cuenta en Dashboard (cobrado/pagado). Relevo: NO
//     (Dashboard queries filtran `origen <> 'relevo'` — ver el bloque
//     Dashboard exclusion para queries afectadas).
//
// El endpoint NO usa `postCajaMovimiento()`: ese helper tiene guarda
// "no permitir egreso que deje caja en negativo". Válida para el flujo
// operacional pero rompe relevos legítimos (ej. adelanto entregado no
// registrado que legítimamente lleva la caja a negativo). El relevo ES
// el ajuste — su propósito es aceptar la realidad, no rechazarla por
// reglas de saldo operacional. INSERT directo con FOR UPDATE lock
// para prevenir races con movimientos concurrentes.
//
// Audit snapshot completo (saldo_anterior, saldo_nuevo, delta, nota,
// user_id) en `audit_logs.despues` — no requiere columna nueva en la
// tabla. Ver `backend/src/schemas/cajas.js:cajaRelevoSchema` para
// validation del body.
//
// Reverte: no hay endpoint dedicado. El user hace OTRO relevo con el
// delta opuesto (input saldo_nuevo = saldo original). El historial
// muestra ambos relevos con sus notas — trail forense completo.
router.post('/cajas/:id/relevo', requireCapability('cajas.relevar'),
  validate(cajaRelevoSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { fecha, saldo_nuevo, nota, tc } = req.body;

    const result = await db.withTenant(req.tenantId, async (client) => {
      // Postgres no permite `FOR UPDATE` con `GROUP BY` — hay que separar
      // en 2 queries: primero lock la caja (SELECT FOR UPDATE simple),
      // después SUM del ledger para calcular saldo_actual. El lock
      // sigue aplicando para prevenir race conditions con movimientos
      // concurrentes (mismo pattern que postCajaMovimiento).
      const { rows: cajaRows } = await client.query(
        `SELECT id, moneda, saldo_inicial
           FROM metodos_pago
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [id]
      );
      if (!cajaRows[0]) return { notFound: true };

      const { rows: sumRows } = await client.query(
        `SELECT COALESCE(SUM(
                  CASE WHEN tipo='ingreso' THEN monto ELSE -monto END
                ), 0) AS delta_movs
           FROM caja_movimientos
          WHERE caja_id = $1 AND deleted_at IS NULL`,
        [id]
      );

      const moneda      = cajaRows[0].moneda;
      const saldoInicial = Number(cajaRows[0].saldo_inicial);
      const deltaMovs   = Number(sumRows[0].delta_movs);
      const saldoActual = round2(saldoInicial + deltaMovs);
      const saldoNuevo  = Number(saldo_nuevo);

      // Cajas ARS/UYU necesitan tc para calcular monto_usd equivalente
      // (mismo criterio multi-país que postCajaMovimiento existente).
      if (requiereTc(moneda) && !(tc && tc > 0)) {
        return { badRequest: `Para una caja en ${moneda} se requiere el tipo de cambio (tc).` };
      }

      const delta = round2(saldoNuevo - saldoActual);
      if (delta === 0) {
        return { badRequest: 'El saldo nuevo es igual al actual — no hay ajuste que registrar.' };
      }

      const tipo     = delta > 0 ? 'ingreso' : 'egreso';
      const monto    = Math.abs(delta);
      const montoUsd = requiereTc(moneda) ? round2(monto / tc) : monto;

      // INSERT directo — bypass guardas de postCajaMovimiento (ver comentario
      // del endpoint arriba). Columnas alineadas con schema real de
      // caja_movimientos (ver migration original 20260525000005).
      const { rows: movRows } = await client.query(
        `INSERT INTO caja_movimientos
           (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, user_id)
         VALUES ($1, $2, $3, $4, $5, 'relevo', NULL, NULL, $6, $7)
         RETURNING *`,
        [id, fecha, tipo, monto, montoUsd, nota, req.user.id]
      );
      const mov = movRows[0];

      // Audit con snapshot completo. El campo `accion_negocio: 'relevo_caja'`
      // permite distinguir en el historial de auditoría entre INSERT de
      // relevo vs INSERT de otros tipos (Dashboard actividad reciente lo
      // renderiza distinto — badge naranja + nota visible).
      await audit(client, 'caja_movimientos', 'INSERT', mov.id, {
        despues: {
          ...mov,
          accion_negocio: 'relevo_caja',
          saldo_anterior: saldoActual,
          saldo_nuevo:    saldoNuevo,
          delta,
          nota,
        },
        user_id: req.user.id,
      });

      return { mov, saldo_anterior: saldoActual, saldo_nuevo: saldoNuevo, delta };
    });

    if (result.notFound)   return res.status(404).json({ error: 'Caja no encontrada' });
    if (result.badRequest) return res.status(400).json({ error: result.badRequest });

    invalidateCajas(req.tenantId);  // Perf H3: relevo cambia saldo_actual
    res.status(201).json({
      ok:              true,
      movimiento:      result.mov,
      saldo_anterior:  result.saldo_anterior,
      saldo_nuevo:     result.saldo_nuevo,
      delta:           result.delta,
    });
  } catch (err) { next(err); }
});

// ─── RESUMEN ────────────────────────────────────────────────

// Resumen agregado por contacto. Cacheado 20s — la vista Capital lo recarga al
// montar y los saldos no cambian al segundo. Ventana corta para reflejar
// movimientos nuevos sin sentir lag.
//
// PR 4.9 (2026-06-15): cache per-tenant. Mismo pattern que getCajasList y
// fetchMetricas en lib/{cajas,inventario}Cache.js. Cada tenant tiene su
// propio fetcher memoizado; query corre bajo db.withTenant(tenantId, ...).
const RESUMEN_DEUDAS_SQL = `
  SELECT m.contacto_id,
    SUM(CASE WHEN m.tipo='debe' THEN m.monto_ars ELSE -m.monto_ars END) AS saldo_ars,
    SUM(CASE WHEN m.tipo='debe' THEN m.monto_usd ELSE -m.monto_usd END) AS saldo_usd,
    COUNT(*) AS movimientos
  FROM movimientos_deudas m
  JOIN contactos c ON c.id = m.contacto_id AND c.deleted_at IS NULL
  WHERE m.deleted_at IS NULL
  GROUP BY m.contacto_id
  HAVING ABS(SUM(CASE WHEN m.tipo='debe' THEN m.monto_ars ELSE -m.monto_ars END))
       + ABS(SUM(CASE WHEN m.tipo='debe' THEN m.monto_usd ELSE -m.monto_usd END)) > 0
`;
const RESUMEN_INV_SQL = `
  WITH ultima_tasa AS (
    SELECT DISTINCT ON (contacto_id)
      contacto_id, tasa
    FROM movimientos_inversiones
    WHERE tasa IS NOT NULL AND deleted_at IS NULL
    ORDER BY contacto_id, fecha DESC, id DESC
  )
  SELECT m.contacto_id,
    SUM(m.monto) AS total_invertido,
    COUNT(*) AS movimientos,
    ut.tasa AS ultima_tasa
  FROM movimientos_inversiones m
  JOIN contactos c ON c.id = m.contacto_id AND c.deleted_at IS NULL
  LEFT JOIN ultima_tasa ut ON ut.contacto_id = m.contacto_id
  WHERE m.deleted_at IS NULL
  GROUP BY m.contacto_id, ut.tasa
`;
// Cache resumen (Inversiones + Deudas).
//
// Migrado a createTenantScopedCache (Redis) — antes era createCachedFetcher
// local. Beneficios cross-instance:
//   - Las 2 réplicas Railway comparten el cache → menos queries duplicadas.
//   - El jitter ±20% del wrapper Redis previene stampede en el TTL boundary.
//   - Key Redis preservada (`cache:cajas:resumen:t${tenantId}`) para no
//     invalidar entries activos al deploy.
//
// Naming nota: el keyPrefix anterior era `cajas:resumen:t` (sin `cache:`
// prefix por inconsistencia histórica — flagged como LOW H6-Hyg en el
// audit). El nuevo prefix sí incluye `cache:` para alinear con el resto
// de los caches Redis del sistema. Esto invalida el cache local previo
// la próxima vez que se llame, pero NO causa downtime — el primer hit
// post-deploy hace MISS y refetchea desde Postgres en <100ms.
const resumenCache = createTenantScopedCache({
  ...CAJAS_RESUMEN,
  fetcher: async (tenantId) => {
    const id = Number(tenantId);
    return db.withTenant(id, async (client) => {
      const { rows: deudas } = await client.query(RESUMEN_DEUDAS_SQL);
      const { rows: inv } = await client.query(RESUMEN_INV_SQL);
      return { deudas, inversiones: inv };
    });
  },
});

router.get('/resumen', async (req, res, next) => {
  try { res.json(await resumenCache.get(req.tenantId)); } catch (err) { next(err); }
});

module.exports = router;
