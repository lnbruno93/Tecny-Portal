const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { round2 } = require('../lib/money');
const { createCachedFetcher } = require('../lib/cacheTtl');
const { getCajasList, invalidateCajas } = require('../lib/cajasCache');
const { postCajaMovimiento } = require('../lib/cajaLedger');
const {
  createDeudaSchema, queryDeudasSchema,
  createInversionSchema, queryInversionesSchema,
  cajaSchema, updateCajaSchema, cajaAjusteSchema, queryLedgerSchema,
} = require('../schemas/cajas');


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
      const [countRes, dataRes] = await Promise.all([
        client.query(`SELECT COUNT(*) ${baseQuery}`, params),
        client.query(
          `SELECT m.id, m.fecha, m.contacto_id, m.tipo AS mov_tipo,
                  m.monto_ars, m.monto_usd, m.concepto, m.created_at,
                  c.nombre, c.apellido, c.tipo AS contacto_tipo
           ${baseQuery}
           ORDER BY m.fecha DESC, m.id DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
      ]);
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });

    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/deudas', validate(createDeudaSchema), async (req, res, next) => {
  // Mega-form transaccional (post-auditoría TANDA 0): si viene `contacto_nuevo`,
  // se crea el contacto + el movimiento en una sola tx. Si falla el INSERT del
  // movimiento, el contacto se revierte → no quedan contactos huérfanos. Antes
  // el frontend hacía 2 requests separados y un error en el 2do dejaba data inconsistente.
  const client = await db.connect();
  try {
    const { fecha, contacto_id, contacto_nuevo, tipo, monto_ars, monto_usd, concepto } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

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
      `INSERT INTO movimientos_deudas (fecha, contacto_id, tipo, monto_ars, monto_usd, concepto)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [fecha, cid, tipo, monto_ars, monto_usd, concepto ?? null]
    );
    await audit(client, 'movimientos_deudas', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/deudas/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE movimientos_deudas SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
        [id]
      );
      if (!rows[0]) return null;
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
      const [countRes, dataRes] = await Promise.all([
        client.query(`SELECT COUNT(*) ${baseQuery}`, params),
        client.query(
          `SELECT m.id, m.fecha, m.contacto_id, m.monto, m.tasa, m.created_at,
                  c.nombre, c.apellido, c.tipo AS contacto_tipo
           ${baseQuery}
           ORDER BY m.fecha DESC, m.id DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
      ]);
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });

    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/inversiones', validate(createInversionSchema), async (req, res, next) => {
  // Mega-form transaccional (ver comentario equivalente en POST /deudas).
  const client = await db.connect();
  try {
    const { fecha, contacto_id, contacto_nuevo, monto, tasa } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

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
      `INSERT INTO movimientos_inversiones (fecha, contacto_id, monto, tasa)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [fecha, cid, monto, tasa ?? null]
    );
    await audit(client, 'movimientos_inversiones', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/inversiones/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE movimientos_inversiones SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
        [id]
      );
      if (!rows[0]) return null;
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
router.get('/cajas/negativas', async (req, res, next) => {
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

router.post('/cajas', validate(cajaSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { nombre, moneda, activo, orden, saldo_inicial, es_financiera, es_tarjeta, comision_pct } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    if (es_financiera) await client.query('UPDATE metodos_pago SET es_financiera = false WHERE es_financiera = true');
    const { rows } = await client.query(
      `INSERT INTO metodos_pago (nombre, moneda, activo, orden, saldo_inicial, es_financiera, es_tarjeta, comision_pct)
       VALUES ($1, $2, COALESCE($3, true), COALESCE($4, 0), COALESCE($5, 0), COALESCE($6, false), COALESCE($7, false), $8)
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

router.put('/cajas/:id', validate(updateCajaSchema), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
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
      `UPDATE metodos_pago SET
         nombre        = COALESCE($1, nombre),
         moneda        = COALESCE($2, moneda),
         activo        = COALESCE($3, activo),
         orden         = COALESCE($4, orden),
         saldo_inicial = COALESCE($5, saldo_inicial),
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

router.delete('/cajas/:id', async (req, res, next) => {
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
      const [{ rows: mov }, { rows: egr }] = await Promise.all([
        client.query('SELECT 1 FROM caja_movimientos WHERE caja_id = $1 AND deleted_at IS NULL LIMIT 1', [id]),
        client.query("SELECT 1 FROM egresos WHERE metodo_pago_id = $1 AND estado = 'pendiente' AND deleted_at IS NULL LIMIT 1", [id]),
      ]);
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
      const [countRes, totRes, dataRes] = await Promise.all([
        client.query(`SELECT COUNT(*) ${baseFrom}`, params),
        client.query(
          `SELECT
             COALESCE(SUM(CASE WHEN cm.tipo = 'ingreso' THEN cm.monto_usd ELSE 0 END), 0) AS ingresos_usd,
             COALESCE(SUM(CASE WHEN cm.tipo = 'egreso'  THEN cm.monto_usd ELSE 0 END), 0) AS egresos_usd
           ${baseFrom}`, params),
        client.query(
          `SELECT cm.id, cm.fecha, cm.caja_id, mp.nombre AS caja_nombre, mp.moneda,
                  cm.tipo, cm.monto, cm.monto_usd, cm.origen, cm.ref_tabla, cm.ref_id, cm.concepto, cm.created_at
           ${baseFrom}
           ORDER BY cm.fecha DESC, cm.id DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]),
      ]);
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
      const [countRes, dataRes] = await Promise.all([
        client.query('SELECT COUNT(*) FROM caja_movimientos WHERE caja_id = $1 AND deleted_at IS NULL', [id]),
        client.query(
          `SELECT id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, created_at
             FROM caja_movimientos
            WHERE caja_id = $1 AND deleted_at IS NULL
            ORDER BY fecha DESC, id DESC
            LIMIT $2 OFFSET $3`,
          [id, limit, offset]
        ),
      ]);
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
router.post('/cajas/:id/movimientos', validate(cajaAjusteSchema), async (req, res, next) => {
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
        if (moneda === 'ARS' && !(tc && tc > 0)) {
          return { badRequest: 'Para una caja en ARS se requiere el tipo de cambio (tc)' };
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
router.delete('/cajas/movimientos/:id', async (req, res, next) => {
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
const RESUMEN_MAX_FETCHERS = 256;
const resumenFetchers = new Map();
function getResumenFetcher(tenantId) {
  let fn = resumenFetchers.get(tenantId);
  if (fn) {
    resumenFetchers.delete(tenantId);
    resumenFetchers.set(tenantId, fn);
    return fn;
  }
  fn = createCachedFetcher(`cajas:resumen:t${tenantId}`, 20_000, async () =>
    db.withTenant(tenantId, async (client) => {
      const [{ rows: deudas }, { rows: inv }] = await Promise.all([
        client.query(RESUMEN_DEUDAS_SQL),
        client.query(RESUMEN_INV_SQL),
      ]);
      return { deudas, inversiones: inv };
    })
  );
  resumenFetchers.set(tenantId, fn);
  if (resumenFetchers.size > RESUMEN_MAX_FETCHERS) {
    resumenFetchers.delete(resumenFetchers.keys().next().value);
  }
  return fn;
}

router.get('/resumen', async (req, res, next) => {
  try { res.json(await getResumenFetcher(req.tenantId)()); } catch (err) { next(err); }
});

module.exports = router;
