/**
 * Rutas del módulo Cuentas Corrientes (CC)
 *
 * Clientes:
 *   GET    /clientes            — lista con saldo calculado
 *   GET    /clientes/:id        — detalle + saldo
 *   POST   /clientes            — crear
 *   PUT    /clientes/:id        — actualizar
 *   DELETE /clientes/:id        — soft delete
 *
 * Movimientos:
 *   GET    /clientes/:id/movimientos  — historial de un cliente (con items)
 *   POST   /movimientos               — crear movimiento (+ items para compra/devolucion)
 *   DELETE /movimientos/:id           — soft delete (items se eliminan en cascada)
 *
 * Saldo = SUM(compra) - SUM(pago + devolucion + parte_de_pago + entrega_mercaderia)
 * Saldo positivo → el cliente nos debe dinero.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const router  = require('express').Router();
const db      = require('../config/database');
const validate  = require('../lib/validate');
const audit     = require('../lib/audit');
const parseId   = require('../lib/parseId');
const requireCapability = require('../middleware/requireCapability');
const { toUsd, round2, assertMonedaValidaParaPais } = require('../lib/money');
// 2026-07-12 (auditoría TOTAL P0-2 Financiero): import el helper canónico de
// cajaLedger (3 grupos: ARS/UYU/USD) en vez de definir una versión local con
// solo 2 grupos (ARS/todo-lo-demás). El local hacía que UYU cayera al grupo
// "USD" y una cobranza UYU contra caja USDT pasara validación con montos
// corruptos × 40.
const { grupoMoneda } = require('../lib/cajaLedger');
// 2026-07-24 (cache audit P1): invalidateCajas post-cobranza masiva. Ver
// comment en el endpoint POST /cobranzas-masivas más abajo.
const { invalidateCajas } = require('../lib/cajasCache');
const logger = require('../lib/logger');
// 2026-07-24 (cache follow-up): DASHBOARD_VENTAS suma movimientos_cc tipo
// 'compra' + 'devolucion' al calcular KPIs B2B (ventas_count, ingresos B2B,
// ganancia). Sin invalidate post-COMMIT, dashboard stale hasta 30s TTL.
// Ver comment en ventas.js:1912 sobre por qué el helper está attached al
// router — es un compromise pragmático.
const { invalidateDashboardVentas } = require('./ventas');

// 2026-08-03 (task #300 Fase B): rate-limit dedicado para PUT /movimientos/:id.
// El edit reprocesa items (INSERT/UPDATE/DELETE en items_movimiento_cc), toca
// stock (UPDATE productos con guard de stock + revert), y potencialmente
// re-postea caja (reverse + post). Es write-heavy con locks — mismo perfil
// que POST movimientos proveedor. 30 edits / 15 min por user es generoso
// para uso humano (el modal es de detalle, no bulk).
const editMovimientoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id != null
    ? `cc-mov-edit:${req.user.id}`
    : `cc-mov-edit:ip:${ipKeyGenerator(req)}`,
  message: { error: 'Demasiadas ediciones de movimientos B2B en poco tiempo. Probá en unos minutos.' },
  skip: () => process.env.NODE_ENV === 'test',
});

// Rate-limit específico para cobranza masiva: 10 req / 15 min por user.
// Cada lote puede ser de hasta 100 cobranzas → write-heavy y mantiene
// locks de cajas un tiempo. Bloquea DoS interno (auditoría #H-07).
const cobranzaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id != null
    ? `cobranza-masiva:${req.user.id}`
    : `cobranza-masiva:ip:${ipKeyGenerator(req)}`,
  message: { error: 'Demasiadas cobranzas masivas. Probá de nuevo en unos minutos.' },
  // #T-1: en tests skipeamos el rate-limit. La suite hace >10 requests al
  // endpoint para cubrir todos los error paths (cliente inválido, caja
  // inválida, schema, rollbacks). Mismo patrón que el helmet+rateLimit
  // global en app.js:205.
  skip: () => process.env.NODE_ENV === 'test',
});
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const {
  createClienteCCSchema,
  updateClienteCCSchema,
  createMovimientoCCSchema,
  updateMovimientoCCSchema,
  updateEstadoMovimientoCCSchema,
  cobranzaMasivaSchema,
} = require('../schemas/cuentas');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { invalidateMetricas } = require('../lib/inventarioCache');
const {
  parseIdempotencyKey,
  findExistingByIdempotencyKey,
  isIdempotencyConflict,
} = require('../lib/idempotency');
const { cancelMovimientoCC } = require('../lib/cancelMovimientoCC');
const { syncContactoSafe } = require('../lib/contactosSync');

// Expresión CASE compartida para calcular el aporte de cada movimiento al saldo.
//
// Regla (mayo-2026, paralelo a Proveedores): una 'compra' con caja_id es
// contado (entró el dinero al instante) y NO suma deuda. Sin caja_id queda
// como deuda del cliente (el caso clásico de venta a CC).
//
// 2026-06-11 S-03: promovido a `src/lib/saldoCC.js` para que el dashboard
// mensual (y futuras pantallas) usen la MISMA fórmula que el listado de
// clientes y el detalle. Antes el dashboard tenía su propia copia con regla
// distinta → cifras de deuda CC inconsistentes entre módulos.
const { SALDO_CASE, SALDO_CASE_M } = require('../lib/saldoCC');

// Helper: SQL para calcular saldo de un cliente (subquery reutilizable — usada solo en GET /:id)
// Para el listado usamos un JOIN en lugar de subquery correlacionada (ver abajo).
const SALDO_SQL = `
  COALESCE((
    SELECT SUM(${SALDO_CASE})
    FROM movimientos_cc
    WHERE cliente_cc_id = c.id AND deleted_at IS NULL
  ), 0)
`;

// ─── CLIENTES ────────────────────────────────────────────────────────────────

// #P-05 endpoint dedicado para autocomplete del picker — devuelve pocos
// clientes que matchean el query string (nombre/apellido), opcionalmente
// solo deudores. Mucho más rápido que cargar 500 clientes al abrir el modal
// y filtrar client-side (no escala a 2k+ clientes).
router.get('/clientes/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const conSaldo = req.query.con_saldo === 'true';
    if (q.length < 2) return res.json({ data: [] });
    const params = [`%${q}%`];
    let extraSaldo = '';
    if (conSaldo) {
      // Subquery del saldo aplicada como having: solo con deuda > 0.
      extraSaldo = ` AND COALESCE(s.saldo, 0) > 0`;
    }
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.nombre, c.apellido, c.categoria, COALESCE(s.saldo, 0) AS saldo
           FROM clientes_cc c
           LEFT JOIN (
             SELECT cliente_cc_id, SUM(${SALDO_CASE_M.replace(/m\./g, '')}) AS saldo
               FROM movimientos_cc m
              WHERE deleted_at IS NULL
              GROUP BY cliente_cc_id
           ) s ON s.cliente_cc_id = c.id
          WHERE c.deleted_at IS NULL
            AND (c.nombre ILIKE $1 OR c.apellido ILIKE $1)
            ${extraSaldo}
          ORDER BY c.nombre, c.apellido
          LIMIT 15`,
        params
      );
      return rows;
    });
    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.get('/clientes', async (req, res, next) => {
  try {
    const { buscar, categoria } = req.query;
    const params  = [];
    const filters = ['c.deleted_at IS NULL'];

    if (buscar) {
      params.push(`%${buscar}%`);
      filters.push(`(c.nombre ILIKE $${params.length} OR c.apellido ILIKE $${params.length} OR c.contacto ILIKE $${params.length})`);
    }
    if (categoria) {
      params.push(categoria);
      filters.push(`c.categoria = $${params.length}`);
    }

    const where = filters.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    // JOIN en lugar de subquery correlacionada — calcula todos los saldos en un solo pase
    // antes: 1 + N queries (una por cliente). Ahora: siempre 1 query total.
    //
    // 2026-06-15 multi-tenant (PR 4.3): count + data en una sola withTenant
    // → comparten el SET LOCAL. RLS filtra clientes_cc y movimientos_cc.
    //
    // 2026-07-20 (bug Tek Haus): la fórmula acá estaba INLINE y no incluía los
    // tipos agregados el 2026-07-17 (`pago_a_cliente` + `entrega_dinero`).
    // Consecuencia: el saldo de la lista discrepaba del saldo de la ficha
    // (que usa SALDO_CASE canónico) por 2× el monto de esos movimientos.
    // Reportado por Tek Haus con captura del cliente "pato" mostrando USD 17.706
    // (ficha) vs USD 11.766 (lista), diff = 5.940 = 2 × USD 2.970 (`Le pago`).
    // Reemplazado por SALDO_CASE de lib/saldoCC.js — misma fórmula usada por
    // el resto del backend (dashboard mensual, chat-tools, endpoint search,
    // stats agregados de línea 1392). No debería haber otra fórmula inline;
    // si aparece, refactorear igual.
    const { SALDO_CASE } = require('../lib/saldoCC');
    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(`SELECT COUNT(*) FROM clientes_cc c WHERE ${where}`, params);
      const dataRes = await client.query(
        `SELECT c.*,
                COALESCE(s.saldo, 0) AS saldo
         FROM clientes_cc c
         LEFT JOIN (
           SELECT cliente_cc_id,
                  SUM(${SALDO_CASE}) AS saldo
           FROM movimientos_cc
           WHERE deleted_at IS NULL
           GROUP BY cliente_cc_id
         ) s ON s.cliente_cc_id = c.id
         WHERE ${where}
         ORDER BY c.nombre, c.apellido
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

router.get('/clientes/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.*, ${SALDO_SQL} AS saldo
         FROM clientes_cc c
         WHERE c.id = $1 AND c.deleted_at IS NULL`,
        [id]
      );
      return rows[0] || null;
    });
    if (!row) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/clientes', validate(createClienteCCSchema), async (req, res, next) => {
  const { nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas, saldo_inicial } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );
    const { rows } = await client.query(
      `INSERT INTO clientes_cc
         (nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [nombre, apellido ?? null, contacto ?? null, marca_redes ?? null,
       provincia ?? null, localidad ?? null, direccion ?? null, categoria, notas ?? null]
    );
    const cliente = rows[0];

    // Saldo de apertura: movimiento 'saldo_inicial' (suma como compra → el cliente nos debe)
    const saldo = Number(saldo_inicial) || 0;
    if (saldo > 0) {
      await client.query(
        `INSERT INTO movimientos_cc (cliente_cc_id, fecha, tipo, descripcion, monto_total)
         VALUES ($1, CURRENT_DATE, 'saldo_inicial', 'Saldo inicial', $2)`,
        [cliente.id, saldo]
      );
    }
    await audit(client, 'clientes_cc', 'INSERT', cliente.id, { despues: { ...cliente, saldo_inicial: saldo }, user_id: req.user.id });
    await client.query('COMMIT');
    // Agenda central (best-effort, fuera de la tx principal).
    // 2026-06-15 multi-tenant: dentro de withTenant para que el INSERT en
    // contactos respete el tenant_id correcto (la lib lee app.current_tenant).
    await db.withTenant(req.tenantId, async (c) => syncContactoSafe(c, {
      origen: 'b2b', ref_tabla: 'clientes_cc', ref_id: cliente.id,
      nombre: cliente.nombre, apellido: cliente.apellido, telefono: cliente.contacto,
    }));
    res.status(201).json({ ...cliente, saldo });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/clientes/:id', validate(updateClienteCCSchema), async (req, res, next) => {
  // #H-09: envolver UPDATE + audit en una TX para que si el audit falla el
  // UPDATE haga rollback (antes el audit corría fuera con db, dejando
  // updates sin rastro auditable).
  const client = await db.connect();
  try {
    const id = parseId(req.params.id);
    // 2026-06-10 P-15: el finally release ya cubre — el doble-release tiraba
    // warning de node-pg y podía botar la conexión.
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );
    const { rows: before } = await client.query(
      'SELECT * FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Cliente no encontrado' }); }

    const { nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas } = req.body;
    const { rows } = await client.query(
      `UPDATE clientes_cc SET
         nombre      = COALESCE($1,  nombre),
         apellido    = COALESCE($2,  apellido),
         contacto    = COALESCE($3,  contacto),
         marca_redes = COALESCE($4,  marca_redes),
         provincia   = COALESCE($5,  provincia),
         localidad   = COALESCE($6,  localidad),
         direccion   = COALESCE($7,  direccion),
         categoria   = COALESCE($8,  categoria),
         notas       = COALESCE($9,  notas)
       WHERE id = $10 RETURNING *`,
      [nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas, id]
    );
    await audit(client, 'clientes_cc', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    // Agenda central (best-effort, fuera de la TX principal).
    // 2026-06-15 multi-tenant: ver comentario en POST /clientes.
    await db.withTenant(req.tenantId, async (c) => syncContactoSafe(c, {
      origen: 'b2b', ref_tabla: 'clientes_cc', ref_id: rows[0].id,
      nombre: rows[0].nombre, apellido: rows[0].apellido, telefono: rows[0].contacto,
    }));
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ─── GET /clientes/:id/delete-preview ───────────────────────────────────────
// Devuelve el "diff" de lo que va a pasar si el operador borra este cliente:
//   - cantidad de movimientos vivos que serán cancelados
//   - productos a restaurar al stock (sumando cantidades por flow B2B)
//   - total a revertir en caja_movimientos (USD)
// Lo usa el frontend para mostrar un confirm con números concretos. Antes la
// UI solo mostraba "se borrará el cliente; su histórico queda guardado", lo
// cual era engañoso — Lucas borró iConnect el 2026-06-09 esperando que el
// stock volviera, y los 7 movs huérfanos quedaron afectando inventario y caja
// invisiblemente. No invocable si el cliente ya está borrado.
router.get('/clientes/:id/delete-preview', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // 2026-06-15 multi-tenant (PR 4.3): cliente lookup + 3 agregaciones en una
    // sola withTenant. RLS filtra clientes_cc, movimientos_cc, caja_movimientos
    // y items_movimiento_cc.
    const data = await db.withTenant(req.tenantId, async (client) => {
      const { rows: cli } = await client.query(
        'SELECT id, nombre, apellido FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
      );
      if (!cli[0]) return { notFound: true };

      const { rows: movsAgg } = await client.query(
        `SELECT COUNT(*)::int AS n,
                COALESCE(SUM(CASE WHEN tipo IN ('compra','entrega_mercaderia') THEN monto_total ELSE 0 END), 0) AS deuda_a_revertir
           FROM movimientos_cc
          WHERE cliente_cc_id = $1 AND deleted_at IS NULL`,
        [id]
      );
      const { rows: cajaAgg } = await client.query(
        `SELECT COALESCE(SUM(cm.monto), 0)::numeric AS total
           FROM caja_movimientos cm
           JOIN movimientos_cc m ON m.id = cm.ref_id
          WHERE cm.ref_tabla = 'movimientos_cc'
            AND cm.deleted_at IS NULL
            AND m.cliente_cc_id = $1 AND m.deleted_at IS NULL`,
        [id]
      );
      const { rows: itemsAgg } = await client.query(
        `SELECT COUNT(*)::int AS n
           FROM items_movimiento_cc i
           JOIN movimientos_cc m ON m.id = i.movimiento_cc_id
          WHERE m.cliente_cc_id = $1 AND m.deleted_at IS NULL
            AND i.producto_id IS NOT NULL
            AND m.tipo IN ('compra','entrega_mercaderia','devolucion')`,
        [id]
      );
      return {
        cliente: cli[0],
        movimientos_a_cancelar: movsAgg[0].n,
        caja_a_revertir_usd: Number(cajaAgg[0].total) || 0,
        productos_a_restaurar: itemsAgg[0].n,
      };
    });
    if (data.notFound) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.delete('/clientes/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  // 2026-06-09: cascada. Antes el DELETE solo soft-deleteaba la fila de
  // clientes_cc, dejando movimientos_cc huérfanos (vivos en DB, invisibles en
  // listados, afectando stock y caja). Hoy en la misma TX: cancela todos los
  // movimientos vivos del cliente (revierte caja + restaura stock + audit
  // con _origen='cliente_cascade') y después soft-deletea el cliente.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    // 1. Lockear cliente.
    const { rows: cliRows } = await client.query(
      'SELECT * FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!cliRows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // 2. Listar movimientos vivos a cancelar (ordenado por id para evitar deadlock
    //    si dos requests intentan borrar clientes con movs solapados — ej. el
    //    cleanup admin de huérfanos corriendo al mismo tiempo).
    const { rows: movs } = await client.query(
      `SELECT id FROM movimientos_cc
         WHERE cliente_cc_id = $1 AND deleted_at IS NULL
         ORDER BY id`,
      [id]
    );

    // 3. Cancelar cada uno con el helper compartido. Si alguno falla (#B-06 de
    //    devolución revendida), el throw rompe el loop y el catch hace ROLLBACK
    //    de TODO — el cliente NO queda borrado a medias.
    let productosRestaurados = 0;
    for (const m of movs) {
      const r = await cancelMovimientoCC(client, {
        movimientoId: m.id,
        userId: req.user.id,
        origen: 'cliente_cascade',
      });
      productosRestaurados += r.productos_restaurados;
    }

    // 4. Soft-delete del cliente.
    await client.query(
      'UPDATE clientes_cc SET deleted_at = NOW() WHERE id = $1',
      [id]
    );
    await audit(client, 'clientes_cc', 'DELETE', id, {
      antes: cliRows[0],
      user_id: req.user.id,
      _cascade: {
        movimientos_cancelados: movs.length,
        productos_restaurados: productosRestaurados,
      },
    });

    await client.query('COMMIT');
    if (productosRestaurados > 0) invalidateMetricas(req.tenantId);
    res.json({
      ok: true,
      cascade: {
        movimientos_cancelados: movs.length,
        productos_restaurados: productosRestaurados,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// ─── MOVIMIENTOS ─────────────────────────────────────────────────────────────

router.get('/clientes/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    // 2026-06-15 multi-tenant (PR 4.3): cliente lookup + count + page + items en
    // una sola withTenant. Comparten SET LOCAL para que RLS filtre todas las
    // tablas por el mismo tenant.
    const data = await db.withTenant(req.tenantId, async (client) => {
      const { rows: c } = await client.query(
        'SELECT id FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
      );
      if (!c[0]) return { notFound: true };

      const { rows: countRows } = await client.query(
        'SELECT COUNT(*) FROM movimientos_cc WHERE cliente_cc_id = $1 AND deleted_at IS NULL', [id]
      );
      const { rows: movs } = await client.query(
        `SELECT * FROM movimientos_cc
         WHERE cliente_cc_id = $1 AND deleted_at IS NULL
         ORDER BY fecha DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      );

      // Items de todos los movimientos, traídos en una sola query
      const movIds = movs.map(m => m.id);
      let items = [];
      if (movIds.length) {
        const { rows } = await client.query(
          `SELECT * FROM items_movimiento_cc
           WHERE movimiento_cc_id = ANY($1)
           ORDER BY id`,
          [movIds]
        );
        items = rows;
      }

      // Adjuntar items a cada movimiento
      const itemsByMov = {};
      items.forEach(item => {
        if (!itemsByMov[item.movimiento_cc_id]) itemsByMov[item.movimiento_cc_id] = [];
        itemsByMov[item.movimiento_cc_id].push(item);
      });

      const result = movs.map(m => ({ ...m, items: itemsByMov[m.id] || [] }));
      return { result, count: parseInt(countRows[0].count) };
    });
    if (data.notFound) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(paginatedResponse(data.result, data.count, { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/movimientos', validate(createMovimientoCCSchema), async (req, res, next) => {
  // 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G): Idempotency-Key.
  // Sin header → duplicados intencionales OK. Con header → double-click devuelve
  // el mismo movimiento sin re-descontar stock ni re-postear caja.
  const idem = parseIdempotencyKey(req);
  if (idem.error) {
    return res.status(400).json({ error: idem.error, reason: 'idempotency_key_invalid' });
  }

  const client = await db.connect();
  try {
    const {
      cliente_cc_id, fecha, tipo, descripcion, monto_total, notas,
      caja_id, items = [],
      // 2026-06-10: estado por defecto 'acreditado' para venta B2B.
      // El schema ya lo defaulta — destructuring igual por consistencia.
      estado = 'acreditado',
      // 2026-07-12 (auditoría TOTAL Financiero P0-1): moneda + tc para
      // multi-país. Ver comment del schema para el bug histórico.
      moneda = 'USD',
      tc = null,
    } = req.body;

    // 2026-07-12: validar que la moneda sea compatible con el país del tenant.
    // Idem `assertMonedaValidaParaPais` que usan ventas, cajas, egresos y
    // cambios (5/9 rutas del track financiero cubiertas por este helper — este
    // PR cierra la sexta). Un tenant AR NO puede recibir cobros UYU, y un
    // tenant UY NO puede recibir cobros ARS. USDT es válido para ambos.
    try {
      assertMonedaValidaParaPais(moneda, req.tenantPais, 'moneda');
    } catch (err) {
      return next(err);
    }

    // Convertir el monto a USD para persistir en movimientos_cc.monto_total.
    // `SALDO_CASE` asume que monto_total está en USD. La moneda + tc originales
    // los pasamos a `postCajaMovimiento` para que la caja quede con el saldo
    // nativo correcto en su propia moneda.
    const montoUsd = round2(toUsd(monto_total, moneda, tc));

    // #H-05 cross-module: si la venta/devolución toca stock de inventario
    // (producto_id en algún item) O si estamos creando productos nuevos
    // (mercaderia_recibida con producto_stock), exigir permiso `inventario`.
    // 2026-07-17 (task #155): mercaderia_recibida agregado al set. También
    // considera el nuevo camino de creación (producto_stock).
    const tocaStock = (
      (['compra', 'devolucion', 'entrega_mercaderia', 'mercaderia_recibida'].includes(tipo)
        && items.some(it => it.producto_id))
      || (tipo === 'mercaderia_recibida' && items.some(it => it.producto_stock))
    );
    if (tocaStock) {
      // 2026-06-23 F4: cutover a requireCapability. hasCapability mantiene
      // la misma semántica para checks cross-módulo inline.
      const { hasCapability } = require('../middleware/requireCapability');
      const ok = await hasCapability(req.user, 'inventario.ver');
      if (!ok) {
        return res.status(403).json({
          error: 'Para registrar un movimiento que descuenta stock necesitás también permiso de Inventario.',
        });
      }
    }

    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    // Idempotency replay: si el caller ya intentó con esta key y triunfó,
    // devolvemos el movimiento original SIN reejecutar caja + stock.
    if (idem.key) {
      const existing = await findExistingByIdempotencyKey(client, 'movimientos_cc', idem.key);
      if (existing) {
        await client.query('ROLLBACK');
        return res.status(200).json({ ...existing, idempotent_replay: true });
      }
    }

    // Verificar que el cliente existe (dentro de la tx, con FOR UPDATE para evitar race condition)
    const { rows: c } = await client.query(
      'SELECT id FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [cliente_cc_id]
    );
    if (!c[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Insertar movimiento (con auditoría de creador para #B-07).
    // estado: solo aplica visualmente a tipo='compra' (venta B2B). El default
    // 'acreditado' del schema cubre todos los demás (pago, devolución, etc.).
    //
    // 2026-07-12 P0-1: `monto_total` se persiste en USD (`montoUsd`) para que
    // SALDO_CASE compute el saldo del cliente correctamente. El `monto_total`
    // que envía el frontend (en su moneda original) se convierte usando
    // `toUsd` — ver arriba del handler.
    const { rows: movRows } = await client.query(
      `INSERT INTO movimientos_cc
         (cliente_cc_id, fecha, tipo, descripcion, monto_total, notas, caja_id, created_by_user_id, estado, client_generated_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [cliente_cc_id, fecha, tipo, descripcion ?? null, montoUsd, notas ?? null, caja_id ?? null, req.user.id, estado, idem.key]
    );
    const mov = movRows[0];

    // Flujo "sale stock, entra dinero" (analogía inversa a Proveedores):
    //   - tipo 'compra' del cliente B2B (= venta nuestra a ese cliente):
    //       · con caja_id → ingreso al instante en esa caja (contado, no suma deuda)
    //       · sin caja_id → queda como deuda del cliente
    //   - tipo 'pago' / 'parte_de_pago' → siempre ingreso a la caja indicada
    //   - tipo 'devolucion' → reverso de venta, NO mueve caja en esta versión
    //     (la devolución cae en CC del cliente como menos deuda)
    if (caja_id && ['pago', 'parte_de_pago', 'compra'].includes(tipo)) {
      // 2026-07-12 P0-1: pasar la moneda + tc REALES en vez de hardcodear
      // 'USD'/null. Impacto histórico del hardcode:
      //   · Tenant UY cobrando UYU contra caja UYU: rebotaba 400 ("moneda
      //     del pago (USD) no coincide con la de la caja (UYU)")
      //   · Tenant AR cobrando ARS contra caja ARS: idéntico rebote
      //   · Tenant AR con caja USDT: pasaba validación (mismo grupo) pero
      //     saldo nativo se corrompía × 1400 si el operador cargó ARS por
      //     error creyendo USD
      //
      // postCajaMovimiento se encarga internamente de:
      //   · Validar `grupoMoneda(moneda) === grupoMoneda(cajaMoneda)` (SOL-1)
      //   · Persistir `caja_movimientos.monto` en la moneda nativa
      //   · Persistir `caja_movimientos.monto_usd` = toUsd(monto, moneda, tc)
      //   · Persistir `caja_movimientos.tc` = tc del pago
      // Todo esto conserva el saldo nativo de la caja correcto y también
      // permite reporting cross-moneda.
      await postCajaMovimiento(client, {
        caja_id, fecha, tipo: 'ingreso', monto: monto_total, moneda, tc,
        origen: 'b2b', ref_tabla: 'movimientos_cc', ref_id: mov.id,
        concepto: tipo === 'compra' ? `Venta B2B (contado) cliente #${cliente_cc_id}` : `Pago B2B #${cliente_cc_id}`,
        user_id: req.user.id,
      });
    }

    // 2026-07-17: pago_a_cliente + entrega_dinero comparten efecto contable
    // (EGRESO de caja + suma al saldo del cliente). Se diferencian solo por
    // el tipo persistido y el concepto de la caja — reportes filtran.
    //   · pago_a_cliente = reintegro / devolución de un anticipo
    //   · entrega_dinero = cambio / adelanto / favor puntual
    if (caja_id && ['pago_a_cliente', 'entrega_dinero'].includes(tipo)) {
      const concepto = tipo === 'entrega_dinero'
        ? `Entrega de dinero al cliente #${cliente_cc_id}`
        : `Pago al cliente #${cliente_cc_id}`;
      await postCajaMovimiento(client, {
        caja_id, fecha, tipo: 'egreso', monto: monto_total, moneda, tc,
        origen: 'b2b', ref_tabla: 'movimientos_cc', ref_id: mov.id,
        concepto,
        user_id: req.user.id,
      });
    }

    // Insertar items y, si tienen `producto_id`, validar stock y descontar.
    //   - compra / entrega_mercaderia → salida de stock (descuenta cantidad).
    //   - devolucion → entrada de stock (suma cantidad).
    //   - mercaderia_recibida (task #155) → entrada de stock. Los items pueden
    //     traer producto_id (referencia a producto existente) o producto_stock
    //     (crea uno nuevo con la info del cliente).
    //
    // #P-02 bulkificado: antes era loop con N SELECT FOR UPDATE + N INSERT
    // items + N UPDATE productos = ~3N round-trips. Ahora: 1 SELECT batch
    // ordenado + 1 INSERT bulk + 1 UPDATE bulk = 3 RTT total.
    let insertedItems = [];
    let productosCreados = [];
    const tiposConItems = ['compra', 'devolucion', 'entrega_mercaderia', 'mercaderia_recibida'];
    if (tiposConItems.includes(tipo) && items.length > 0) {
      const esSalida = tipo === 'compra' || tipo === 'entrega_mercaderia';

      // Items con producto_id (ordenados por id ASC para evitar deadlock,
      // #H-01) vs items sin (texto libre, no tocan stock).
      const itemsConProd = items
        .filter(it => it.producto_id)
        .sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
      const prodIds = itemsConProd.map(it => Number(it.producto_id));

      // Detección temprana de producto_id duplicados ANTES de tocar nada.
      // Antes, el bulk UPDATE con UNNEST devolvía rowCount=1 cuando había 2
      // items con el mismo producto_id (PG dedupea) y caíamos a un 500 opaco
      // "Inconsistencia al actualizar stock" que confundía al operador.
      // Ahora devolvemos 409 con la lista exacta de IDs duplicados.
      const dupIds = [];
      const seenIds = new Set();
      for (const pid of prodIds) {
        if (seenIds.has(pid)) dupIds.push(pid);
        else seenIds.add(pid);
      }
      if (dupIds.length > 0) {
        await client.query('ROLLBACK');
        // Resolver nombres/IMEIs para que el frontend muestre algo útil.
        // 2026-06-15 multi-tenant: post-ROLLBACK la tx terminó → SET LOCAL ya no
        // aplica. Usamos withTenant separado para que RLS filtre por el tenant
        // del request (en vez de db.query que correría sin contexto y leería
        // todos los tenants en role super, o nada en role no-super).
        const dupRows = await db.withTenant(req.tenantId, async (c) => {
          const r = await c.query(
            `SELECT id, nombre, imei FROM productos
               WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
            [[...new Set(dupIds)]]
          );
          return r.rows;
        });
        return res.status(409).json({
          error: 'Hay productos repetidos en la venta — no se puede vender el mismo unitario dos veces',
          duplicados: dupRows.map(p => ({ id: p.id, nombre: p.nombre, imei: p.imei })),
        });
      }

      // 1) Batch SELECT de productos para (a) validar existencia con error
      //    user-friendly (Producto #X no existe), y (b) snapshot de costo
      //    congelado en items_movimiento_cc (junio 2026 — desglose B2B).
      //
      //    P-13 (auditoría 2026-06-10): se eliminó el FOR UPDATE. Antes
      //    tomábamos row locks aquí + en el UPDATE posterior, lo que
      //    serializaba ventas concurrentes que tocaban el mismo producto
      //    (caso típico B2B: cliente A y cliente B compran al mismo SKU).
      //    Ahora la atomicidad la garantiza el UPDATE condicional (paso 3),
      //    que rechaza la venta si otro thread ya consumió el stock en el
      //    intervalo entre SELECT y UPDATE. El pre-check de stock que sigue
      //    es para devolver un 409 con mensaje amistoso en el caso común
      //    (sin contención); el UPDATE es el guard real ante la race.
      let prodMap = new Map();
      if (prodIds.length > 0) {
        const { rows: prodRows } = await client.query(
          `SELECT id, nombre, cantidad, estado, costo, costo_moneda FROM productos
             WHERE id = ANY($1::int[]) AND deleted_at IS NULL
             ORDER BY id`,
          [prodIds]
        );
        prodMap = new Map(prodRows.map(p => [Number(p.id), p]));

        // Validación: existencia + stock suficiente (best-effort pre-check).
        // El UPDATE condicional al final es el verdadero guard transaccional.
        for (const item of itemsConProd) {
          const p = prodMap.get(Number(item.producto_id));
          if (!p) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `Producto #${item.producto_id} no existe` });
          }
          if (esSalida && Number(p.cantidad) < Number(item.cantidad || 1)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `Stock insuficiente para "${p.nombre}": disponible ${p.cantidad}, pedido ${item.cantidad}`,
              producto_id: item.producto_id,
            });
          }
        }
      }

      // 2) Bulk INSERT de los items en una sola query con UNNEST.
      //    costo_unit + costo_moneda: snapshot congelado del producto al
      //    momento de la venta. Items sin producto_id (texto libre) → NULL.
      //    Ventas históricas pre-migración → NULL también.
      const costoSnap = (it) => {
        if (!it.producto_id) return { unit: null, moneda: null };
        const p = prodMap.get(Number(it.producto_id));
        if (!p) return { unit: null, moneda: null };
        return { unit: Number(p.costo) || 0, moneda: p.costo_moneda || 'USD' };
      };
      const itemRes = await client.query(
        `INSERT INTO items_movimiento_cc
           (movimiento_cc_id, producto, modelo, tamano, color, imei_serial, valor, verificado, notas, producto_id, cantidad, costo_unit, costo_moneda)
         SELECT $1, p, m, t, c, i, v, vf, n, pid, cant, cu, cm
           FROM UNNEST(
             $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
             $7::numeric[], $8::boolean[], $9::text[], $10::int[], $11::int[],
             $12::numeric[], $13::text[]
           ) AS u(p, m, t, c, i, v, vf, n, pid, cant, cu, cm)
         RETURNING *`,
        [
          mov.id,
          items.map(it => it.producto ?? null),
          items.map(it => it.modelo ?? null),
          items.map(it => it.tamano ?? null),
          items.map(it => it.color ?? null),
          items.map(it => it.imei_serial ?? null),
          items.map(it => it.valor ?? null),
          items.map(it => it.verificado ?? false),
          items.map(it => it.notas ?? null),
          items.map(it => it.producto_id ?? null),
          items.map(it => Number(it.cantidad || 1)),
          items.map(it => costoSnap(it).unit),
          items.map(it => costoSnap(it).moneda),
        ]
      );
      insertedItems = itemRes.rows;

      // 3) Bulk UPDATE del stock con un solo round-trip. Usa FROM UNNEST + JOIN.
      //    P-13 (auditoría 2026-06-10): para ventas (esSalida=true) la cláusula
      //    WHERE incluye `p.cantidad >= u.cant`. Si otra venta concurrente ya
      //    drenó el stock entre nuestro SELECT y este UPDATE, la fila NO se
      //    actualiza → rowCount queda corto y devolvemos 409 con info. Esto
      //    es lo que reemplaza al SELECT FOR UPDATE: la atomicidad del UPDATE
      //    PostgreSQL serializa por fila a este nivel sin row lock previo.
      //    Para devoluciones (esSalida=false) no hay guard de stock — siempre
      //    se puede sumar.
      if (itemsConProd.length > 0) {
        const sign = esSalida ? '-' : '+';
        const stockGuard = esSalida ? 'AND p.cantidad >= u.cant' : '';
        // arrays paralelos para FROM UNNEST
        const updateRes = await client.query(
          `UPDATE productos p SET
             cantidad = p.cantidad ${sign} u.cant,
             estado = CASE
               WHEN p.cantidad ${sign} u.cant <= 0 THEN 'vendido'
               WHEN p.cantidad ${sign} u.cant > 0 AND p.estado = 'vendido' THEN 'disponible'
               ELSE p.estado
             END
           FROM UNNEST($1::int[], $2::int[]) AS u(pid, cant)
           WHERE p.id = u.pid ${stockGuard}`,
          [
            itemsConProd.map(it => Number(it.producto_id)),
            itemsConProd.map(it => Number(it.cantidad || 1)),
          ]
        );
        // Sanity check: deberíamos haber afectado N filas únicas. Si no:
        //   · esSalida=true: race condition — otra venta concurrente drenó
        //     stock entre SELECT y este UPDATE. Devolvemos 409 (no 500),
        //     pidiendo reintentar. El frontend muestra "Stock insuficiente
        //     por concurrencia, reintentá".
        //   · esSalida=false: solo puede pasar si un producto se soft-deletó
        //     entre SELECT y UPDATE (race extrema). 500 sigue siendo correcto.
        // Los duplicados de producto_id ya fueron filtrados arriba.
        if (updateRes.rowCount !== itemsConProd.length) {
          await client.query('ROLLBACK');
          if (esSalida) {
            return res.status(409).json({
              error: 'Stock insuficiente por concurrencia — otra venta consumió el stock al mismo tiempo. Reintentá.',
              esperado: itemsConProd.length,
              afectado: updateRes.rowCount,
            });
          }
          return res.status(500).json({
            error: 'No se pudo actualizar el stock de todos los productos. Reintentá; si persiste, contactá soporte.',
            esperado: itemsConProd.length,
            afectado: updateRes.rowCount,
          });
        }
      }

      // 2026-07-17 (task #155): creación de productos nuevos para
      // `mercaderia_recibida`. El cliente entrega productos que NO están en
      // nuestro catálogo — los creamos en la misma transacción con IMEI
      // validation + audit-lote. Mismo pattern que `routes/proveedores.js`
      // POST /movimientos con producto_stock. Sólo aplica cuando tipo es
      // `mercaderia_recibida` (los demás tipos ignoran producto_stock).
      if (tipo === 'mercaderia_recibida') {
        const stockItems = items.filter(it => it.producto_stock);
        if (stockItems.length > 0) {
          // Pre-validación IMEI: primero interno al lote, después vs stock vivo.
          const imeisACrear = stockItems
            .map(it => String(it.producto_stock.imei || '').trim())
            .filter(Boolean);
          if (imeisACrear.length > 0) {
            const seenImei = new Set();
            for (const im of imeisACrear) {
              if (seenImei.has(im)) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: `IMEI duplicado dentro del mismo lote: ${im}` });
              }
              seenImei.add(im);
            }
            // Lock por IMEI (#H-04) — hashes ordenados evitan deadlock entre
            // lotes concurrentes que compartan IMEIs.
            const hashes = [...new Set(imeisACrear)].sort();
            for (const imei of hashes) {
              await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [imei]);
            }
            const { rows: exist } = await client.query(
              `SELECT imei FROM productos WHERE imei = ANY($1::text[]) AND deleted_at IS NULL`,
              [imeisACrear]
            );
            if (exist.length > 0) {
              await client.query('ROLLBACK');
              return res.status(409).json({
                error: `IMEI ya existe${exist.length > 1 ? 's' : ''} en Inventario: ${exist.map(r => r.imei).join(', ')}`,
                imeis_existentes: exist.map(r => r.imei),
              });
            }
          }

          // Bulk INSERT de productos. `movimiento_cc_id` = mov.id para trazar
          // cascade en el DELETE del movimiento.
          const STOCK_COLS = [
            'tipo_carga', 'clase_id', 'nombre', 'imei', 'gb', 'color', 'bateria',
            'categoria_id', 'deposito_id', 'proveedor', 'costo', 'costo_moneda',
            // 2026-08-01 (task #273): costo_tc para mercaderia_recibida
            // (cliente entrega productos como pago). Se propaga desde el
            // TC del movimiento (mov.tc) si moneda coincide.
            'costo_tc',
            'precio_venta', 'precio_moneda', 'trackear_stock', 'cantidad', 'estado',
            'observaciones', 'condicion', 'oculto', 'movimiento_cc_id',
          ];
          const PRODUCT_COL_TYPES = {
            tipo_carga: 'text', clase_id: 'uuid', nombre: 'text', imei: 'text',
            gb: 'text', color: 'text', bateria: 'int',
            categoria_id: 'int', deposito_id: 'int', proveedor: 'text',
            costo: 'numeric', costo_moneda: 'text',
            costo_tc: 'numeric',
            precio_venta: 'numeric', precio_moneda: 'text',
            trackear_stock: 'boolean', cantidad: 'int', estado: 'text',
            observaciones: 'text', condicion: 'text', oculto: 'boolean',
            movimiento_cc_id: 'int',
          };
          const params = STOCK_COLS.map((col, i) => `$${i + 1}::${PRODUCT_COL_TYPES[col]}[]`).join(', ');
          const colsAlias = STOCK_COLS.map((_, i) => `c${i + 1}`).join(', ');
          const insertCols = STOCK_COLS.join(', ');
          const arrays = STOCK_COLS.map(col => stockItems.map(it => {
            const ps = it.producto_stock;
            if (col === 'condicion')        return ps.condicion ?? 'nuevo';
            if (col === 'oculto')           return ps.oculto    ?? false;
            if (col === 'movimiento_cc_id') return mov.id;
            // 2026-08-01 (task #273): costo_tc — override > mov.tc > null.
            if (col === 'costo_tc') {
              if (ps.costo_tc != null && Number(ps.costo_tc) > 0) return Number(ps.costo_tc);
              const cm = ps.costo_moneda;
              if ((cm === 'ARS' || cm === 'UYU') && cm === moneda && tc) {
                return Number(tc);
              }
              return null;
            }
            return ps[col] ?? null;
          }));
          const prodRes = await client.query(
            `INSERT INTO productos (${insertCols})
               SELECT ${colsAlias} FROM UNNEST(${params}) AS u(${colsAlias})
               RETURNING *`,
            arrays
          );
          productosCreados = prodRes.rows;

          // 1 audit-lote (constraint acepta INSERT/UPDATE/DELETE).
          await audit(client, 'productos', 'INSERT', productosCreados[0]?.id || mov.id, {
            despues: {
              _bulk: true,
              _origen: 'mercaderia_recibida_cliente',
              movimiento_cc_id: mov.id,
              ids: productosCreados.map(p => p.id),
              count: productosCreados.length,
            },
            user_id: req.user.id,
          });
        }
      }
    }

    await audit(client, 'movimientos_cc', 'INSERT', mov.id, {
      despues: { ...mov, items: insertedItems },
      user_id: req.user.id,
    });
    await client.query('COMMIT');
    // Venta B2B descontó stock — invalidar el cache de métricas para que el
    // dashboard de Inventario refleje el nuevo total en el próximo refresh.
    if (insertedItems.length > 0 || productosCreados.length > 0) invalidateMetricas(req.tenantId);
    // Cualquier tipo (compra, devolucion, pago, mercaderia_recibida...) mueve
    // el saldo del cliente + potencialmente los KPIs del dashboard. Invalidamos
    // siempre — el costo de un refetch es menor al de mostrar KPIs stale.
    invalidateDashboardVentas(req.tenantId);

    res.status(201).json({ ...mov, items: insertedItems, productos_creados: productosCreados });
  } catch (err) {
    await client.query('ROLLBACK');
    // Race window residual Pattern G: 2 requests con la misma key llegan al
    // INSERT concurrentes; el UNIQUE index parcial atrapa al 2do.
    if (isIdempotencyConflict(err)) {
      return res.status(409).json({
        error: 'Otro request con la misma Idempotency-Key está en curso. Reintentá en un instante.',
        reason: 'idempotency_conflict',
      });
    }
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /movimientos/:id/estado — toggle acreditado/pendiente (2026-06-10).
// El selector del frontend en la grilla unificada de Ventas dispara esto.
// Solo aplica a movs vivos. Ownership: cualquiera con permiso `cuentas` puede
// cambiarlo (no hay check #B-07 acá — es solo un flag visual, no toca
// inventario ni caja).
router.patch('/movimientos/:id/estado', validate(updateEstadoMovimientoCCSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { estado } = req.body;

    // 2026-06-15 multi-tenant (PR 4.3): SELECT + UPDATE + audit en una sola
    // withTenant. Antes el audit corría con el pool global (sin contexto de
    // tenant) — ahora corre dentro de la tx con SET LOCAL, así el audit_log
    // se escribe con el tenant correcto.
    const result = await db.withTenant(req.tenantId, async (client) => {
      const { rows: pre } = await client.query(
        'SELECT estado FROM movimientos_cc WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );
      if (!pre[0]) return { notFound: true };
      if (pre[0].estado === estado) return { sinCambios: true };

      const { rows } = await client.query(
        `UPDATE movimientos_cc SET estado = $1 WHERE id = $2 RETURNING *`,
        [estado, id]
      );
      await audit(client, 'movimientos_cc', 'UPDATE', id, {
        antes: { estado: pre[0].estado },
        despues: { estado: rows[0].estado },
        user_id: req.user.id,
        _origen: 'cambio_estado',
      });
      return { row: rows[0] };
    });
    if (result.notFound) return res.status(404).json({ error: 'Movimiento no encontrado' });
    if (result.sinCambios) return res.json({ ok: true, estado, sin_cambios: true });
    res.json({ ok: true, estado: result.row.estado });
  } catch (err) { next(err); }
});

// ─── PUT /movimientos/:id — edit inline del movimiento (Fase B, task #300) ────
//
// Simétrico al PUT /movimientos/:mid de proveedores.js (task #262). Sólo aplica
// a tipo=compra por diseño (el resto de tipos son atómicos: no tiene sentido
// editar items en pago/devolución — anular + recrear en su lugar).
//
// Editables:
//   · fecha, descripcion, notas
//   · items (diff-based) — INSERT nuevos con producto_id descuenta stock,
//     DELETE existentes con producto_id revierte stock
//
// NO editables (razones de integridad contable — anular + recrear si necesario):
//   · cliente_cc_id, tipo, monto_total (recomputado), caja_id, moneda, tc,
//     estado
//
// Sync inventario bidireccional:
//   · Item NUEVO con producto_id → descuenta stock (guard 409 si insuficiente)
//   · Item EXISTENTE con producto_id → no toca stock (campos NO ligados a
//     stock son editables: color, notas, verificado, valor). Si el user
//     quiere cambiar producto_id o cantidad, debe REMOVER el item + AGREGAR
//     uno nuevo (dispara revert + descount).
//   · Item REMOVIDO con producto_id → revierte stock (suma cantidad al producto)
//   · Guard 409: no se puede remover un item cuyo producto ya se vendió en
//     otra venta.
//
// Ajuste caja: si mov.caja_id != NULL (venta B2B contado) y el monto_total
// cambia, hacemos reverseCajaMovimientos + postCajaMovimiento. Para monedas
// !== USD, requerimos mov.tc para poder convertir el nuevo monto USD a la
// moneda nativa de la caja.
//
// Multi-tenant: SET LOCAL app.current_tenant en toda la tx. RLS canónica
// filtra selects/updates.
router.put('/movimientos/:id', editMovimientoLimiter,
  validate(updateMovimientoCCSchema),
  async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const idem = parseIdempotencyKey(req);
    if (idem.error) return res.status(400).json({ error: idem.error, reason: 'idempotency_key_invalid' });

    const { fecha, descripcion, notas, items: itemsBody } = req.body;
    const bodyItems = Array.isArray(itemsBody) ? itemsBody : null;  // null = "no tocar items"

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', $1::text, true)`, [String(req.tenantId)]);

      // Idempotency replay: si el caller reintenta con la misma key y ya
      // triunfó, devolvemos el movimiento sin re-ejecutar diff+stock.
      // Nota: PUT rara vez usa Idempotency-Key (los edits no suelen re-tratarse
      // como POSTs), pero por defensa cubrimos network flakes de reintentos.
      if (idem.key) {
        const existing = await findExistingByIdempotencyKey(client, 'movimientos_cc', idem.key);
        if (existing && existing.id === id) {
          await client.query('ROLLBACK');
          return res.status(200).json({ ...existing, idempotent_replay: true });
        }
      }

      // 1) Lock del movimiento + ownership check (mismo patrón que DELETE).
      const { rows: movs } = await client.query(
        'SELECT * FROM movimientos_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [id]
      );
      if (!movs[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
      const mov = movs[0];

      // Ownership check: mismo patrón que DELETE handler (auditoría #B-07).
      // Un user con permiso `cuentas` solo puede editar movimientos que él
      // mismo creó. Admins + owners del tenant pueden editar cualquiera.
      const isOwner = mov.created_by_user_id === req.user.id;
      const isBypass = req.user.role === 'admin'
        || req.user.tenant_cap_rol === 'owner'
        || req.user.tenant_cap_rol === 'admin';
      if (!isOwner && !isBypass) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'No tenés permiso para editar este movimiento (lo creó otro usuario).' });
      }

      // 2) Validación de tipo: solo 'compra' es editable via este endpoint.
      if (mov.tipo !== 'compra') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Solo se pueden editar ventas B2B (tipo='compra'). Este movimiento es tipo='${mov.tipo}'. Para modificarlo, anulalo y creá uno nuevo.`,
          tipo: mov.tipo,
        });
      }

      // 3) Cargar items actuales con snapshot del producto asociado (para
      //    validar guards y sync inventario).
      const currentItemsRes = await client.query(
        `SELECT i.*,
                p.id       AS p_producto_id,
                p.estado   AS producto_estado,
                p.nombre   AS producto_nombre,
                p.cantidad AS producto_cantidad
           FROM items_movimiento_cc i
      LEFT JOIN productos p
             ON p.id = i.producto_id
            AND p.deleted_at IS NULL
          WHERE i.movimiento_cc_id = $1
          ORDER BY i.id`,
        [id]
      );
      // Normalizamos: producto_id = solo si el producto está vivo (no soft-deleted).
      const currentItems = currentItemsRes.rows.map(r => ({
        ...r,
        producto_id_alive: r.p_producto_id, // solo si producto no soft-deleted
      }));
      const currentById = new Map(currentItems.map(i => [i.id, i]));

      // 4) Diff: toUpdate / toInsert / toRemove
      let toUpdate = [], toInsert = [], toRemove = [];
      if (bodyItems !== null) {
        // Validar que items con id pertenezcan a este mov
        for (const bi of bodyItems) {
          if (bi.id && !currentById.has(bi.id)) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Item id=${bi.id} no pertenece a este movimiento`,
              item_id: bi.id,
            });
          }
        }
        const bodyIdsSet = new Set(bodyItems.filter(i => i.id).map(i => i.id));
        toRemove = currentItems.filter(i => !bodyIdsSet.has(i.id));
        toUpdate = bodyItems.filter(i => i.id);
        toInsert = bodyItems.filter(i => !i.id);
      }

      // 5) Cross-módulo: si el edit toca stock (nuevos items con producto_id,
      //    o remoción de items con producto_id vivo), requerir permiso inventario.
      const nuevosConProd = toInsert.filter(bi => bi.producto_id);
      const removidosConProd = toRemove.filter(i => i.producto_id_alive);
      const tocaStock = nuevosConProd.length > 0 || removidosConProd.length > 0;
      if (tocaStock) {
        const { hasCapability } = require('../middleware/requireCapability');
        const ok = await hasCapability(req.user, 'inventario.ver');
        if (!ok) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'Para editar items que descuentan/reponen stock necesitás también permiso de Inventario.',
          });
        }
      }

      // 6) Guard: items a UPDATE con producto_id NO pueden cambiar
      //    producto_id ni cantidad. Simplifica lógica de sync inventario:
      //    el user debe remover + agregar para cambiar producto/cantidad.
      for (const bi of toUpdate) {
        const orig = currentById.get(bi.id);
        if (orig.producto_id_alive) {
          // producto_id: si viene en body distinto al original, rechazar.
          const nuevoPid = bi.producto_id != null ? Number(bi.producto_id) : null;
          const origPid = Number(orig.producto_id_alive);
          if (nuevoPid !== null && nuevoPid !== origPid) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Item id=${bi.id}: no se puede cambiar producto_id de un item existente (${origPid} → ${nuevoPid}). Remové el item y agregá uno nuevo.`,
              item_id: bi.id,
            });
          }
          // cantidad: idem — cambiar cantidad tocaría stock post-hoc.
          const nuevaCant = bi.cantidad != null ? Number(bi.cantidad) : 1;
          const origCant  = Number(orig.cantidad || 1);
          if (nuevaCant !== origCant) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: `Item id=${bi.id}: no se puede cambiar cantidad de un item existente vinculado a Inventario (${origCant} → ${nuevaCant}). Remové el item y agregá uno nuevo.`,
              item_id: bi.id,
            });
          }
        }
      }

      // 7) Guard: no se puede remover un item cuyo producto ya se vendió en
      //    OTRA venta posterior (mismo patrón que DELETE via cancelMovimientoCC).
      //
      //    Nota: NO alcanza con chequear `producto_estado === 'vendido'`, porque
      //    un producto puede estar 'vendido' precisamente por ESTE movimiento
      //    (cantidad quedó en 0 tras el descuento del POST original). En ese
      //    caso removerlo + revertir stock es exactamente lo esperado.
      //
      //    Detección: buscar si el producto figura en OTRA venta minorista
      //    (venta_items) o B2B (items_movimiento_cc de OTRO movimiento vivo)
      //    activa. Si sí, bloquear. Si no, permitir remove + revert.
      const removeProdIds = toRemove.filter(i => i.producto_id_alive).map(i => i.producto_id_alive);
      if (removeProdIds.length > 0) {
        // Query única para eficiencia: retorna solo los producto_ids con
        // ventas en OTROS movimientos.
        const { rows: conVentaExterna } = await client.query(
          `SELECT DISTINCT producto_id FROM (
             -- Venta minorista con ese producto
             SELECT vi.producto_id
               FROM venta_items vi
               JOIN ventas v ON v.id = vi.venta_id
              WHERE vi.producto_id = ANY($1::int[])
                AND v.deleted_at IS NULL
             UNION ALL
             -- Venta B2B en OTRO mov_cc (excluye el actual)
             SELECT imcc.producto_id
               FROM items_movimiento_cc imcc
               JOIN movimientos_cc mcc ON mcc.id = imcc.movimiento_cc_id
              WHERE imcc.producto_id = ANY($1::int[])
                AND imcc.movimiento_cc_id <> $2
                AND mcc.deleted_at IS NULL
           ) x`,
          [removeProdIds, id]
        );
        const bloqueadosSet = new Set(conVentaExterna.map(r => Number(r.producto_id)));
        const vendidos = toRemove
          .filter(i => i.producto_id_alive && bloqueadosSet.has(Number(i.producto_id_alive)))
          .map(i => i.producto_nombre || i.producto || `producto #${i.producto_id_alive}`);
        if (vendidos.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `No se puede eliminar ${vendidos.length} producto(s) ya vendido(s) en otra venta: ${vendidos.slice(0, 3).join(', ')}${vendidos.length > 3 ? '…' : ''}. Anulá la(s) otra(s) venta(s) primero o dejá el ítem en esta venta.`,
            productos_vendidos: vendidos,
          });
        }
      }

      // 8) Pre-validación stock para items nuevos con producto_id:
      //    ordenar por producto_id ASC (evita deadlock #H-01) + best-effort
      //    check (el UPDATE condicional al final es el guard real).
      let prodMap = new Map();
      const nuevosOrdenados = [...nuevosConProd].sort((a, b) => Number(a.producto_id) - Number(b.producto_id));
      const nuevosPids = nuevosOrdenados.map(it => Number(it.producto_id));
      if (nuevosPids.length > 0) {
        // Dup check
        const seenPids = new Set();
        for (const pid of nuevosPids) {
          if (seenPids.has(pid)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `Producto #${pid} duplicado dentro de los items nuevos del edit`,
              producto_id: pid,
            });
          }
          seenPids.add(pid);
        }
        const { rows: prodRows } = await client.query(
          `SELECT id, nombre, cantidad, estado, costo, costo_moneda FROM productos
             WHERE id = ANY($1::int[]) AND deleted_at IS NULL
             ORDER BY id`,
          [nuevosPids]
        );
        prodMap = new Map(prodRows.map(p => [Number(p.id), p]));
        for (const item of nuevosOrdenados) {
          const p = prodMap.get(Number(item.producto_id));
          if (!p) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `Producto #${item.producto_id} no existe` });
          }
          if (Number(p.cantidad) < Number(item.cantidad || 1)) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `Stock insuficiente para "${p.nombre}": disponible ${p.cantidad}, pedido ${item.cantidad}`,
              producto_id: item.producto_id,
            });
          }
        }
      }

      // 9) Mutaciones — orden: UPDATE existentes, INSERT nuevos + descount,
      //    DELETE removidos + revert.

      // 9a. UPDATE items existentes (solo campos NO ligados a stock).
      for (const bi of toUpdate) {
        await client.query(
          `UPDATE items_movimiento_cc
              SET producto = $1, modelo = $2, tamano = $3, color = $4,
                  imei_serial = $5, valor = $6, verificado = $7, notas = $8
            WHERE id = $9`,
          [
            bi.producto ?? null, bi.modelo ?? null, bi.tamano ?? null, bi.color ?? null,
            bi.imei_serial ?? null, bi.valor ?? null, bi.verificado ?? false, bi.notas ?? null,
            bi.id,
          ]
        );
      }

      // 9b. INSERT items nuevos + descuento de stock (para items con producto_id).
      let insertedItems = [];
      if (toInsert.length > 0) {
        // Snapshot de costo congelado (idem POST).
        const costoSnap = (it) => {
          if (!it.producto_id) return { unit: null, moneda: null };
          const p = prodMap.get(Number(it.producto_id));
          if (!p) return { unit: null, moneda: null };
          return { unit: Number(p.costo) || 0, moneda: p.costo_moneda || 'USD' };
        };
        const itemInsertRes = await client.query(
          `INSERT INTO items_movimiento_cc
             (movimiento_cc_id, producto, modelo, tamano, color, imei_serial, valor, verificado, notas, producto_id, cantidad, costo_unit, costo_moneda)
           SELECT $1, p, m, t, c, i, v, vf, n, pid, cant, cu, cm
             FROM UNNEST(
               $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
               $7::numeric[], $8::boolean[], $9::text[], $10::int[], $11::int[],
               $12::numeric[], $13::text[]
             ) AS u(p, m, t, c, i, v, vf, n, pid, cant, cu, cm)
           RETURNING *`,
          [
            id,
            toInsert.map(it => it.producto ?? null),
            toInsert.map(it => it.modelo ?? null),
            toInsert.map(it => it.tamano ?? null),
            toInsert.map(it => it.color ?? null),
            toInsert.map(it => it.imei_serial ?? null),
            toInsert.map(it => it.valor ?? null),
            toInsert.map(it => it.verificado ?? false),
            toInsert.map(it => it.notas ?? null),
            toInsert.map(it => it.producto_id ?? null),
            toInsert.map(it => Number(it.cantidad || 1)),
            toInsert.map(it => costoSnap(it).unit),
            toInsert.map(it => costoSnap(it).moneda),
          ]
        );
        insertedItems = itemInsertRes.rows;

        // Bulk UPDATE stock para nuevos con producto_id (esSalida siempre =
        // true porque tipo=compra). Guard concurrencia con WHERE p.cantidad >= u.cant.
        if (nuevosOrdenados.length > 0) {
          const updateRes = await client.query(
            `UPDATE productos p SET
               cantidad = p.cantidad - u.cant,
               estado = CASE
                 WHEN p.cantidad - u.cant <= 0 THEN 'vendido'
                 WHEN p.cantidad - u.cant > 0 AND p.estado = 'vendido' THEN 'disponible'
                 ELSE p.estado
               END
             FROM UNNEST($1::int[], $2::int[]) AS u(pid, cant)
             WHERE p.id = u.pid AND p.cantidad >= u.cant`,
            [
              nuevosOrdenados.map(it => Number(it.producto_id)),
              nuevosOrdenados.map(it => Number(it.cantidad || 1)),
            ]
          );
          if (updateRes.rowCount !== nuevosOrdenados.length) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: 'Stock insuficiente por concurrencia — otra venta consumió el stock. Reintentá.',
              esperado: nuevosOrdenados.length,
              afectado: updateRes.rowCount,
            });
          }
        }
      }

      // 9c. DELETE items removidos + REVERT stock (para items con producto_id vivo).
      // items_movimiento_cc no tiene deleted_at (schema original) — HARD DELETE.
      // El audit trail queda en el JSON del audit_logs abajo.
      for (const orig of toRemove) {
        await client.query('DELETE FROM items_movimiento_cc WHERE id = $1', [orig.id]);
        if (orig.producto_id_alive) {
          // Revert stock: SUMAR cantidad al producto (opuesto al descuento
          // que hizo el POST original). Mismo patrón que cancelMovimientoCC.
          const cantRevert = Number(orig.cantidad || 1);
          await client.query(
            `UPDATE productos SET
               cantidad = cantidad + $1,
               estado = CASE
                 WHEN estado = 'vendido' THEN 'disponible'
                 ELSE estado
               END
              WHERE id = $2 AND deleted_at IS NULL`,
            [cantRevert, orig.producto_id_alive]
          );
        }
      }

      // 10) Recalcular monto_total desde SUM de valores de items vivos.
      //     movimientos_cc.monto_total está en USD (SALDO_CASE lo asume).
      //     items_movimiento_cc.valor asumimos en USD también (consistente
      //     con la unidad del monto_total al momento de crear el movimiento).
      let nuevoMontoUsd = Number(mov.monto_total);
      if (bodyItems !== null) {
        const sumRes = await client.query(
          `SELECT COALESCE(SUM(valor), 0)::numeric AS total
             FROM items_movimiento_cc
            WHERE movimiento_cc_id = $1`,
          [id]
        );
        nuevoMontoUsd = round2(Number(sumRes.rows[0].total));
      }

      await client.query(
        `UPDATE movimientos_cc
            SET fecha = COALESCE($1, fecha),
                descripcion = $2,
                notas = $3,
                monto_total = $4
          WHERE id = $5`,
        [fecha ?? null, descripcion ?? null, notas ?? null, nuevoMontoUsd, id]
      );

      // 11) Ajustar caja_movimiento si el movimiento era contado (mov.caja_id
      //     != NULL — venta B2B con cobro inmediato) y el monto o fecha cambió.
      //     reverseCajaMovimientos borra + genera el reverse. Luego
      //     postCajaMovimiento agrega el nuevo con el monto/fecha actualizados.
      //     Neto: la caja queda ajustada al valor real.
      const montoOriginalUsd = Number(mov.monto_total);
      const montoCambio = Math.abs(montoOriginalUsd - nuevoMontoUsd) > 0.005;
      const fechaCambio = fecha && String(fecha) !== String(mov.fecha).slice(0, 10);
      if (mov.caja_id && (montoCambio || fechaCambio)) {
        // Convertir el nuevoMontoUsd de vuelta a la moneda del pago original
        // (necesario porque postCajaMovimiento persiste `monto` en la moneda
        // nativa de la caja). Nota: la tabla `movimientos_cc` NO tiene columna
        // moneda/tc (el POST solo la usa para convertir a USD via `toUsd`;
        // luego persiste el USD en monto_total). Por lo tanto `mov.moneda` es
        // siempre undefined — el ingreso original a caja se hizo en USD.
        // Repostear también en USD (misma unidad, la caja acepta si su grupo
        // es USD/USDT).
        const movMoneda = mov.moneda || 'USD';
        let nuevoMontoNativo;
        if (movMoneda === 'USD') {
          nuevoMontoNativo = nuevoMontoUsd;
        } else if (mov.tc && Number(mov.tc) > 0) {
          nuevoMontoNativo = round2(nuevoMontoUsd * Number(mov.tc));
        } else {
          // Edge case defensivo: si un futuro schema agregara moneda/tc a
          // movimientos_cc y el mov quedó en no-USD sin TC, rechazamos con
          // mensaje explícito en vez de corromper el saldo de la caja.
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `No se puede recalcular el saldo de la caja: el movimiento está en ${movMoneda} sin tipo de cambio guardado. Anulá el movimiento y creá uno nuevo.`,
            moneda: movMoneda,
          });
        }
        await reverseCajaMovimientos(client, 'movimientos_cc', id);
        await postCajaMovimiento(client, {
          caja_id: mov.caja_id,
          fecha: fecha ?? mov.fecha,
          tipo: 'ingreso',
          monto: nuevoMontoNativo,
          moneda: movMoneda,
          tc: mov.tc || null,
          origen: 'b2b',
          ref_tabla: 'movimientos_cc',
          ref_id: id,
          concepto: `Venta B2B (contado, editada) cliente #${mov.cliente_cc_id}`,
          user_id: req.user.id,
        });
      }

      // 12) Audit del cambio
      await audit(client, 'movimientos_cc', 'UPDATE', id, {
        antes: {
          fecha: mov.fecha,
          descripcion: mov.descripcion,
          notas: mov.notas,
          monto_total: montoOriginalUsd,
          items_count: currentItems.length,
        },
        despues: {
          fecha: fecha ?? mov.fecha,
          descripcion: descripcion ?? mov.descripcion,
          notas: notas ?? mov.notas,
          monto_total: nuevoMontoUsd,
          items_count: (bodyItems || currentItems).length,
          items_removed: toRemove.length,
          items_added: toInsert.length,
          items_updated: toUpdate.length,
          items_removed_reverted_stock: removidosConProd.length,
          items_added_discounted_stock: nuevosConProd.length,
        },
        user_id: req.user.id,
        _origen: 'edit_movimiento',
      });

      await client.query('COMMIT');

      // Cache invalidation cross-instance
      if (tocaStock) invalidateMetricas(req.tenantId);
      invalidateDashboardVentas(req.tenantId);
      if (mov.caja_id && (montoCambio || fechaCambio)) {
        invalidateCajas(req.tenantId).catch((err) =>
          logger.warn({ err: err.message, tenantId: req.tenantId },
            '[cuentas] invalidateCajas post-PUT falló'));
      }

      // 13) Devolver estado fresh (items post-edit)
      const finalMov = await db.withTenant(req.tenantId, async (ac) => {
        const mv = await ac.query('SELECT * FROM movimientos_cc WHERE id = $1', [id]);
        const it = await ac.query(
          `SELECT * FROM items_movimiento_cc WHERE movimiento_cc_id = $1 ORDER BY id`,
          [id]
        );
        return { ...mv.rows[0], items: it.rows };
      });
      res.json(finalMov);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (isIdempotencyConflict(err)) {
        return res.status(409).json({
          error: 'Otro request con la misma Idempotency-Key está en curso. Reintentá en un instante.',
          reason: 'idempotency_conflict',
        });
      }
      next(err);
    } finally {
      client.release();
    }
  }
);

router.delete('/movimientos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );
    // Ownership check (auditoría #B-07): un user con permiso `cuentas` solo
    // puede borrar movimientos que él mismo creó. Los admins pueden borrar
    // cualquiera. Movimientos legacy (created_by_user_id IS NULL, anteriores
    // al deploy de la migración 013) solo los borra admin.
    const { rows: pre } = await client.query(
      'SELECT id, created_by_user_id FROM movimientos_cc WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (!pre[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    // 2026-06-24 TANDA 1 P1 fix: el chequeo previo era `req.user.role === 'admin'`
    // (rol global). Post-F4 los owners self-signup NO son admin global (decisión
    // de seguridad cross-tenant) → owners legítimos quedaban bloqueados de
    // borrar movimientos B2B de su propio tenant. Replicamos el patrón ya
    // usado en proveedores.js: bypass por tenant_cap_rol owner/admin además
    // del admin global.
    const isOwner = pre[0].created_by_user_id === req.user.id;
    const isBypass = req.user.role === 'admin'
      || req.user.tenant_cap_rol === 'owner'
      || req.user.tenant_cap_rol === 'admin';
    if (!isOwner && !isBypass) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'No tenés permiso para borrar este movimiento (lo creó otro usuario).' });
    }
    // Helper compartido: soft-delete + revertir caja + restaurar stock + audit.
    // Mismo flow que DELETE /clientes/:id (cascada) y POST /admin/orphan-movs
    // (cleanup huérfanos). Lanza errors con .status que mapeamos a HTTP.
    await cancelMovimientoCC(client, {
      movimientoId: id,
      userId: req.user.id,
      origen: 'manual',
    });
    await client.query('COMMIT');
    // DELETE de venta B2B repuso stock — invalidar cache para que el dashboard
    // refleje el nuevo total inmediatamente.
    invalidateMetricas(req.tenantId);
    invalidateDashboardVentas(req.tenantId);  // cancelar movimiento_cc afecta KPIs B2B
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message, producto_id: err.producto_id });
    next(err);
  } finally {
    client.release();
  }
});

// ─── POST /movimientos/:movId/items/:itemId/devolver ────────────────────────
//
// Devolución inline de UN item de una venta B2B. Junio 2026 — Lucas pidió
// poder devolver un producto individual sin tener que cargar un movimiento
// nuevo manual. UX: el item queda visible en el desglose original con
// tachado + badge "Devuelto"; en paralelo se crea un movimiento_cc tipo
// 'devolucion' nuevo para mantener la trazabilidad contable + la lógica
// existente de saldo/caja (el saldo del cliente baja porque la devolución
// le da crédito).
//
// Idempotente: si el item ya fue devuelto (devuelto_at IS NOT NULL), tira 409.
// Atómico: si falla cualquier paso, rollback total.
//
// Pre-condiciones:
//   · movimiento_cc vivo (no soft-deleted) y tipo='compra' (no se devuelve
//     una devolución ni un pago).
//   · item del movimiento existe.
//   · item.producto_id NO NULL (sin producto_id no podemos restaurar stock —
//     items legacy de texto libre no se pueden devolver por este flow).
router.post('/movimientos/:movId/items/:itemId/devolver', async (req, res, next) => {
  const movId  = parseId(req.params.movId);
  const itemId = parseId(req.params.itemId);
  if (!movId || !itemId) return res.status(400).json({ error: 'IDs inválidos' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    // 1. Lock del movimiento padre + validación.
    const { rows: movs } = await client.query(
      'SELECT * FROM movimientos_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [movId]
    );
    if (!movs[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    const movOrig = movs[0];
    if (movOrig.tipo !== 'compra') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Solo se pueden devolver items de movimientos tipo "compra".' });
    }

    // 2. Lock del item + validación.
    const { rows: items } = await client.query(
      `SELECT * FROM items_movimiento_cc
        WHERE id = $1 AND movimiento_cc_id = $2
        FOR UPDATE`,
      [itemId, movId]
    );
    if (!items[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item no encontrado en este movimiento' });
    }
    const item = items[0];
    if (item.devuelto_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este item ya fue devuelto.' });
    }
    if (!item.producto_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Este item no tiene producto del Inventario asociado (texto libre); no se puede devolver por este flow.',
      });
    }

    // 3. Crear el movimiento_cc tipo 'devolucion' por este solo item. Le pasa
    //    el saldo del cliente (resta deuda) y restaura stock del producto.
    const cantidad = Number(item.cantidad || 1);
    const valor    = Number(item.valor || 0);
    const { rows: devMovRows } = await client.query(
      `INSERT INTO movimientos_cc
         (cliente_cc_id, fecha, tipo, descripcion, monto_total, caja_id, created_by_user_id)
       VALUES ($1, NOW()::date, 'devolucion', $2, $3, NULL, $4)
       RETURNING *`,
      [
        movOrig.cliente_cc_id,
        `Devolución item de mov #${movId}`,
        valor * cantidad,
        req.user.id,
      ]
    );
    const devMov = devMovRows[0];

    // 4. Copiar item al nuevo movimiento (para que el desglose del mov de
    //    devolución muestre qué se devolvió). Costo congelado igual que el
    //    original. NO seteamos devuelto_at acá — el flag lo lleva el item
    //    original, no la copia.
    await client.query(
      `INSERT INTO items_movimiento_cc
         (movimiento_cc_id, producto, modelo, tamano, color, imei_serial, valor, verificado,
          notas, producto_id, cantidad, costo_unit, costo_moneda)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        devMov.id, item.producto, item.modelo, item.tamano, item.color,
        item.imei_serial, item.valor, item.verificado, item.notas,
        item.producto_id, cantidad, item.costo_unit, item.costo_moneda,
      ]
    );

    // 5. Restaurar stock — incrementar cantidad y volver a 'disponible' si
    //    el producto había quedado vendido. Mismo CASE que cancelMovimientoCC.
    //    2026-06-25 SOL-5 (audit pre-live): `AND deleted_at IS NULL` para
    //    NO resucitar productos soft-deleted. Antes, si entre la venta y la
    //    devolución alguien borraba el producto del inventario, la
    //    devolución le sumaba stock y lo reactivaba implícitamente —
    //    productos borrados aparecían "vivos" con stock fantasma. Si el
    //    producto está deleted, la devolución solo marca el item como
    //    devuelto (paso 6 abajo); el stock queda sin restaurar (el operador
    //    puede recrear el producto manualmente si quiere reusarlo).
    await client.query(
      `UPDATE productos
          SET cantidad = cantidad + $2,
              estado = CASE
                WHEN cantidad + $2 <= 0                              THEN 'vendido'
                WHEN cantidad + $2 > 0  AND estado = 'vendido'       THEN 'disponible'
                ELSE estado
              END
        WHERE id = $1
          AND deleted_at IS NULL`,
      [item.producto_id, cantidad]
    );

    // 6. Marcar el item ORIGINAL como devuelto. Esto es lo que el frontend
    //    lee para tachar la fila y ocultar el botón ↺.
    await client.query(
      `UPDATE items_movimiento_cc
          SET devuelto_at = NOW(),
              devolucion_mov_id = $2,
              devolucion_user_id = $3
        WHERE id = $1`,
      [itemId, devMov.id, req.user.id]
    );

    // 7. Audit: queda registrado quién devolvió qué item de qué mov.
    await audit(client, 'items_movimiento_cc', 'UPDATE', itemId, {
      antes: { devuelto_at: null },
      despues: { devuelto_at: 'NOW', devolucion_mov_id: devMov.id },
      user_id: req.user.id,
      _origen: 'devolucion_inline',
      _mov_original_id: movId,
    });

    await client.query('COMMIT');
    invalidateMetricas(req.tenantId);
    invalidateDashboardVentas(req.tenantId);  // devolucion revierte parte del ingreso B2B
    res.json({
      ok: true,
      item_id: itemId,
      devolucion_mov_id: devMov.id,
      monto_devuelto_usd: valor * cantidad,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// ─── COBRANZA MASIVA ──────────────────────────────────────────────────────────
// Registra N pagos de distintos clientes en una sola TX (todo o nada).
//   - Cada fila es un movimiento_cc independiente (tipo=pago/parte_de_pago).
//   - Cada fila postea un INGRESO a su caja correspondiente.
//   - El sobrepago (monto > saldo) se permite: el cliente queda con saldo
//     negativo (a favor), descontable de la próxima compra.
//   - Si una fila falla por cualquier motivo (cliente no existe, caja
//     inválida, etc.) → rollback total: ninguna cobranza se aplica.
// 2026-06-23 F5a: gate inline. El módulo está gateado por `b2b.trabajar`
// (vendedor lo tiene), pero la cobranza masiva tiene su propia capability
// `b2b.cobranza_masiva` — vendedor NO la tiene en default, encargado SÍ.
router.post('/cobranzas-masivas', requireCapability('b2b.cobranza_masiva'), cobranzaLimiter, validate(cobranzaMasivaSchema), async (req, res, next) => {
  // 2026-07-26 (audit 07-25 Track A P1-6, Pattern G bulk): Idempotency-Key
  // para el batch entero. Semántica: 1 Idempotency-Key = 1 batch de N
  // cobranzas. Si el user hace doble-click o hay retry por 502 de Netlify,
  // el 2do request encuentra la key persistida en la FIRST fila del batch
  // y devuelve replay sin re-ejecutar side effects (crear duplicados de
  // caja_movimientos, sumar 2× en saldos, etc.).
  //
  // Detalle técnico: como movimientos_cc tiene UNIQUE (tenant_id,
  // client_generated_id), no podemos persistir la key en las N filas del
  // batch. Solución: persistimos SOLO en la primera fila (índice 0 en el
  // orden del batch). En replay, encontramos esa primera fila y reconstruimos
  // el lote leyendo audit_logs.despues.ids (el audit-lote ya se persiste
  // como {_bulk: true, ids: [...], count: N} — ver `audit(...)` abajo).
  const idem = parseIdempotencyKey(req);
  if (idem.error) {
    return res.status(400).json({ error: idem.error, reason: 'idempotency_key_invalid' });
  }

  const client = await db.connect();
  try {
    const { cobranzas } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    // Idempotency replay antes de tocar clientes + cajas. Si el batch ya
    // se procesó, reconstruimos el response desde la primera fila +
    // audit_logs.
    if (idem.key) {
      const firstRow = await findExistingByIdempotencyKey(client, 'movimientos_cc', idem.key);
      if (firstRow) {
        // Reconstruir el batch completo via audit_logs.despues.ids.
        const { rows: auditRows } = await client.query(
          `SELECT despues FROM audit_logs
             WHERE tabla = 'movimientos_cc'
               AND accion = 'INSERT'
               AND registro_id = $1::text
               AND deleted_at IS NULL
             LIMIT 1`,
          [String(firstRow.id)]
        );
        const ids = auditRows[0]?.despues?.ids || [firstRow.id];
        const { rows: creadosReplay } = await client.query(
          'SELECT * FROM movimientos_cc WHERE id = ANY($1::int[]) AND deleted_at IS NULL',
          [ids]
        );
        await client.query('ROLLBACK');
        return res.status(200).json({
          ok: true,
          creados: creadosReplay.length,
          movimientos: creadosReplay,
          idempotent_replay: true,
        });
      }
    }

    // Pre-validación: clientes vivos y cajas vivas. Salvo bloqueo total
    // antes de empezar a INSERTAR para mensajes claros y rollback rápido.
    //
    // #M-01: SELECT FOR UPDATE ordenado por id en ambas tablas. Sin esto,
    // entre el SELECT y el INSERT otro proceso podía soft-deletear un
    // cliente o caja, dejando un movimientos_cc apuntando a deleted_at
    // != NULL. Con el lock, el delete espera al COMMIT.
    const clienteIds = [...new Set(cobranzas.map(c => c.cliente_cc_id))].sort((a, b) => a - b);
    const cajaIds    = [...new Set(cobranzas.map(c => c.caja_id))].sort((a, b) => a - b);
    // Las dos queries son secuenciales (no Promise.all) para mantener orden
    // de locks consistente entre transacciones concurrentes.
    const valC = await client.query(
      'SELECT id FROM clientes_cc WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE',
      [clienteIds]);
    const valK = await client.query(
      'SELECT id FROM metodos_pago WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE',
      [cajaIds]);
    const okC = new Set(valC.rows.map(r => r.id));
    const okK = new Set(valK.rows.map(r => r.id));
    const errores = [];
    cobranzas.forEach((c, i) => {
      if (!okC.has(c.cliente_cc_id)) errores.push({ fila: i + 1, error: `Cliente #${c.cliente_cc_id} no existe` });
      if (!okK.has(c.caja_id))       errores.push({ fila: i + 1, error: `Caja #${c.caja_id} no existe` });
    });
    if (errores.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Referencias inválidas', detalles: errores });
    }

    // #H-02 deadlock prevention: ordenar por caja_id ASC para que dos
    // procesos concurrentes que tocan cajas [A,B] vs [B,A] lockeen en el
    // mismo orden y eviten abort por deadlock detectado por PostgreSQL.
    //
    // #P-03 bulkificado: ANTES era loop con 1 INSERT mov + postCajaMovimiento
    // (que hace SELECT caja FOR UPDATE + INSERT) + 1 audit por cobranza.
    // Para 100 cobranzas: ~500 round-trips. AHORA: 1 lock batch + 1 INSERT
    // movs + 1 INSERT caja_movs + 1 audit-lote = 4 RTT total.
    const cobranzasOrdenadas = [...cobranzas].sort((a, b) =>
      Number(a.caja_id) - Number(b.caja_id));

    // Lock batch de las cajas únicas, ordenadas.
    const cajasUnicasOrdenadas = [...new Set(cobranzasOrdenadas.map(c => c.caja_id))].sort((a, b) => a - b);
    const { rows: cajaRows } = await client.query(
      `SELECT id, moneda FROM metodos_pago
         WHERE id = ANY($1::int[]) AND deleted_at IS NULL
         ORDER BY id FOR UPDATE`,
      [cajasUnicasOrdenadas]
    );
    const cajaMoneda = new Map(cajaRows.map(r => [r.id, r.moneda]));

    // Validar que la moneda del pago coincida con el grupo de la caja
    // (USD/USDT son intercambiables, ARS aparte, UYU aparte) — mismo check
    // que hace postCajaMovimiento pero hecho upfront para todas las filas.
    // 2026-07-12 (auditoría TOTAL P0-2): usar el `grupoMoneda` canónico de
    // cajaLedger.js (import arriba). El local definía solo 2 grupos y hacía
    // que cobranzas UYU contra caja USDT pasaran validación con corrupción
    // silenciosa del saldo.
    //
    // 2026-07-26 (audit 07-25 Track A P1-2): agregado `assertMonedaValidaParaPais`.
    // El check de grupo caja/pago no cubría el caso "AR-only tenant crea
    // cobranza UYU contra una caja UYU inexistente/rogue" — teóricamente
    // imposible porque el tenant AR-only no tiene cajas UYU, pero
    // defense-in-depth cierra el hueco por si el flow admite crear caja
    // UYU en tenant AR (bug latente en cajas.js) o si el body burla la
    // caja lookup con un ID válido de OTRO tenant (no debería pasar por
    // RLS, pero el error message es más claro con el guard aquí).
    for (let i = 0; i < cobranzasOrdenadas.length; i++) {
      const c = cobranzasOrdenadas[i];
      try {
        assertMonedaValidaParaPais(c.moneda, req.tenantPais, `cobranzas[${i}].moneda`);
      } catch (err) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: err.message });
      }
      const monedaCaja = cajaMoneda.get(c.caja_id);
      if (grupoMoneda(monedaCaja) !== grupoMoneda(c.moneda)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Fila ${i + 1}: la moneda del pago (${c.moneda}) no coincide con la de la caja (${monedaCaja}).`,
        });
      }
    }

    // 1) Bulk INSERT de movimientos_cc, devuelve los IDs en el orden de UNNEST.
    //
    // 2026-07-26 (audit 07-25 P1-6): la key de Idempotency se persiste SOLO en
    // la primera fila del batch (índice 0 del orden). El UNIQUE index no
    // permite N filas con la misma key. La primera fila actúa como "marker"
    // del batch; el audit-lote guarda los ids del batch entero para poder
    // reconstruir el response en replay.
    const montosUsd = cobranzasOrdenadas.map(c => round2(toUsd(c.monto, c.moneda, c.tc)));
    const clientGeneratedIds = cobranzasOrdenadas.map((_, i) => i === 0 ? (idem.key || null) : null);
    let movRes;
    try {
      movRes = await client.query(
        `INSERT INTO movimientos_cc
           (cliente_cc_id, fecha, tipo, descripcion, monto_total, caja_id, created_by_user_id, client_generated_id)
         SELECT cli, f, t, d, m, k, $1, cgi
           FROM UNNEST(
             $2::int[], $3::date[], $4::text[], $5::text[],
             $6::numeric[], $7::int[], $8::uuid[]
           ) WITH ORDINALITY AS u(cli, f, t, d, m, k, cgi, ord)
           ORDER BY ord
         RETURNING *`,
        [
          req.user.id,
          cobranzasOrdenadas.map(c => c.cliente_cc_id),
          cobranzasOrdenadas.map(c => c.fecha),
          cobranzasOrdenadas.map(c => c.tipo),
          cobranzasOrdenadas.map(c => c.descripcion ?? 'Cobranza masiva'),
          montosUsd,
          cobranzasOrdenadas.map(c => c.caja_id),
          clientGeneratedIds,
        ]
      );
    } catch (err) {
      // Race window: 2 requests con misma key entraron concurrentemente,
      // ambos pasaron el findExisting → ambos intentan INSERT, UNIQUE index
      // atrapa al 2do (SQLSTATE 23505 sobre idx_movimientos_cc_idempotency).
      if (isIdempotencyConflict(err)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'La cobranza ya está siendo procesada. Reintentá en unos segundos.',
          reason: 'idempotency_conflict',
        });
      }
      throw err;
    }
    const creados = movRes.rows;

    // 2) Bulk INSERT de caja_movimientos con los ref_id de los movs creados.
    await client.query(
      `INSERT INTO caja_movimientos
         (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, user_id)
       SELECT k, f, 'ingreso', m, mu, 'b2b', 'movimientos_cc', ref, con, $1
         FROM UNNEST(
           $2::int[], $3::date[], $4::numeric[], $5::numeric[],
           $6::int[], $7::text[]
         ) AS u(k, f, m, mu, ref, con)`,
      [
        req.user.id,
        cobranzasOrdenadas.map(c => c.caja_id),
        cobranzasOrdenadas.map(c => c.fecha),
        cobranzasOrdenadas.map(c => c.monto),
        montosUsd,
        creados.map(m => m.id),
        cobranzasOrdenadas.map(c => `Cobranza masiva cliente #${c.cliente_cc_id}`),
      ]
    );

    // 3) 1 audit-lote en vez de 1 por cobranza.
    // 1 audit-lote (accion='INSERT', con flag _bulk para distinguir del
    // INSERT individual al inspeccionar logs).
    await audit(client, 'movimientos_cc', 'INSERT', creados[0].id, {
      despues: { _bulk: true, _origen: 'cobranza_masiva', ids: creados.map(m => m.id), count: creados.length },
      user_id: req.user.id,
    });

    await client.query('COMMIT');

    // 2026-07-24 (cache audit P1): invalidar CAJAS_LIST post-COMMIT. Los
    // otros callers de caja_movimientos (cajas.js movimientos, ventaCore,
    // cancelarVenta, admin.js backfill) ya invalidan — este endpoint bulk
    // se había quedado atrás. Sin este call, el dashboard "Cajas → saldos"
    // queda stale hasta 15s post-cobranza masiva, y con N cobranzas del
    // orden de cientos (Tek Haus hace 100+ en un lote) el impacto se nota.
    // Fire-and-forget con catch para no bloquear la response.
    invalidateCajas(req.tenantId).catch(err =>
      logger.warn({ err: err.message, tenantId: req.tenantId, count: creados.length },
        'cobranza-masiva: invalidateCajas falló')
    );

    res.status(201).json({ ok: true, creados: creados.length, movimientos: creados });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── RESUMEN DE CUENTA ────────────────────────────────────────────────────────
// Totales desglosados por tipo para el header del detalle de cuenta

router.get('/clientes/:id/resumen', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const data = await db.withTenant(req.tenantId, async (client) => {
      const { rows: c } = await client.query(
        'SELECT * FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
      );
      if (!c[0]) return { notFound: true };

      const { rows } = await client.query(
        `SELECT
           COALESCE(SUM(CASE WHEN tipo = 'compra'             THEN monto_total ELSE 0 END), 0) AS total_compras,
           COALESCE(SUM(CASE WHEN tipo = 'pago'               THEN monto_total ELSE 0 END), 0) AS total_pagos,
           COALESCE(SUM(CASE WHEN tipo = 'devolucion'         THEN monto_total ELSE 0 END), 0) AS total_devoluciones,
           COALESCE(SUM(CASE WHEN tipo = 'parte_de_pago'      THEN monto_total ELSE 0 END), 0) AS total_parte_de_pago,
           COALESCE(SUM(CASE WHEN tipo = 'entrega_mercaderia' THEN monto_total ELSE 0 END), 0) AS total_entrega_mercaderia,
           COALESCE(SUM(CASE WHEN tipo = 'saldo_inicial'      THEN monto_total ELSE 0 END), 0) AS total_saldo_inicial,
           -- Saldo aplica la misma regla que el listado (SALDO_CASE):
           -- compra con caja_id = contado, no suma deuda.
           COALESCE(SUM(${SALDO_CASE}), 0) AS saldo,
           COUNT(*) FILTER (WHERE tipo = 'compra') AS cant_compras,
           COUNT(*)                                AS cant_movimientos
         FROM movimientos_cc
         WHERE cliente_cc_id = $1 AND deleted_at IS NULL`,
        [id]
      );

      return { cliente: c[0], ...rows[0] };
    });
    if (data.notFound) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /resumen-general — métricas globales de todas las CC
router.get('/resumen-general', async (req, res, next) => {
  try {
    // CTE compartida: calcula saldos una sola vez para totales y top-10.
    // Usa la misma regla que el listado de clientes y el detalle (SALDO_CASE_M):
    // una 'compra' con caja_id no suma deuda (contado).
    const BASE_CTE = `
      WITH saldos AS (
        SELECT
          c.id, c.nombre, c.apellido, c.categoria,
          COALESCE(SUM(${SALDO_CASE_M}), 0) AS saldo
        FROM clientes_cc c
        LEFT JOIN movimientos_cc m
               ON m.cliente_cc_id = c.id AND m.deleted_at IS NULL
        WHERE c.deleted_at IS NULL
        GROUP BY c.id, c.nombre, c.apellido, c.categoria
      )
    `;

    const { totals, top } = await db.withTenant(req.tenantId, async (client) => {
      const { rows: totals } = await client.query(BASE_CTE + `
        SELECT
          COUNT(*)::int                                                   AS cant_clientes,
          COALESCE(SUM(CASE WHEN saldo > 0 THEN saldo  ELSE 0 END), 0)   AS total_deuda,
          COALESCE(SUM(CASE WHEN saldo < 0 THEN -saldo ELSE 0 END), 0)   AS total_credito,
          COALESCE(SUM(saldo), 0)                                         AS neto
        FROM saldos
      `);
      const { rows: top } = await client.query(BASE_CTE + `
        SELECT id, nombre, apellido, categoria, saldo
        FROM saldos
        WHERE saldo > 0
        ORDER BY saldo DESC
        LIMIT 10
      `);
      return { totals, top };
    });

    res.json({ ...totals[0], top_deudores: top });
  } catch (err) { next(err); }
});

// GET /calendario?mes=2026-05 — movimientos agrupados por día para el calendario
router.get('/calendario', async (req, res, next) => {
  try {
    const mes = req.query.mes || new Date().toISOString().substring(0, 7);
    // Validate mes format
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Formato de mes inválido (YYYY-MM)' });

    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(`
        SELECT
          fecha::date                                                                                AS dia,
          COALESCE(SUM(CASE WHEN tipo = 'compra'                         THEN monto_total ELSE 0 END), 0) AS compras,
          COALESCE(SUM(CASE WHEN tipo IN ('pago','parte_de_pago','entrega_mercaderia') THEN monto_total ELSE 0 END), 0) AS pagos,
          COALESCE(SUM(CASE WHEN tipo = 'devolucion'                     THEN monto_total ELSE 0 END), 0) AS devoluciones,
          COUNT(*)::int                                                                              AS cant
        FROM movimientos_cc
        WHERE DATE_TRUNC('month', fecha) = DATE_TRUNC('month', ($1 || '-01')::date)
          AND deleted_at IS NULL
        GROUP BY fecha::date
        ORDER BY fecha::date
      `, [mes]);
      return rows;
    });

    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
