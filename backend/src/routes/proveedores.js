// Módulo Proveedores — cuentas por pagar. Alta de proveedores + cuenta corriente
// (compras que les debemos y pagos que les hicimos). Montos normalizados a USD.
// Montado en /api/proveedores con requireAuth + requireCapability('proveedores.trabajar') (app.js).
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { toUsd, round2, assertMonedaValidaParaPais } = require('../lib/money');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { syncContactoSafe } = require('../lib/contactosSync');
const adminOnly = require('../middleware/adminOnly');
const requireCapability = require('../middleware/requireCapability');
const { invalidateMetricas } = require('../lib/inventarioCache');
const { invalidateCajas } = require('../lib/cajasCache');
const {
  parseIdempotencyKey,
  findExistingByIdempotencyKey,
  isIdempotencyConflict,
} = require('../lib/idempotency');
const {
  createProveedorSchema, updateProveedorSchema, createMovimientoProveedorSchema, updateMovimientoProveedorSchema,
  bulkCreateMovimientosProveedorSchema, nombresBulkProveedoresSchema,
  createDevolucionMercaderiaProveedorSchema,
  proveedorRelevoSchema,
} = require('../schemas/proveedores');
// Fórmula canónica del saldo por proveedor — evita divergencia entre listado,
// resumen, chat-tools y dashboardMensual (task #150 consolidación).
const { SALDO_CASE_M } = require('../lib/saldoProveedor');

// Mapeo de columnas de productos a su tipo PostgreSQL para UNNEST batched
// inserts (#P-01). Se actualiza si STOCK_COLS cambia.
// F3.d-3 (2026-07-09): `clase` VARCHAR dropeada. STOCK_COLS solo usa clase_id.
const PRODUCT_COL_TYPES = {
  tipo_carga: 'text', clase_id: 'uuid', nombre: 'text', imei: 'text',
  gb: 'text', color: 'text', bateria: 'int',
  categoria_id: 'int', deposito_id: 'int', proveedor: 'text',
  costo: 'numeric', costo_moneda: 'text',
  precio_venta: 'numeric', precio_moneda: 'text',
  trackear_stock: 'boolean', cantidad: 'int', estado: 'text',
  observaciones: 'text', condicion: 'text', oculto: 'boolean',
  proveedor_movimiento_id: 'int',
};
const pgArrayType = (col) => PRODUCT_COL_TYPES[col] || 'text';

// Rate-limit dedicado para POST /movimientos (auditoría #H-07): cuando una
// compra trae producto_stock, hace hasta 200 INSERTs productos + IMEI locks
// + audit. Sin tope dedicado, un script puede agotar conexiones del pool en
// minutos. 30 lotes / 15 min por user es generoso para uso humano.
const compraMovimientoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id != null
    ? `prov-mov:${req.user.id}`
    : `prov-mov:ip:${ipKeyGenerator(req)}`,
  message: { error: 'Demasiadas compras a proveedor en poco tiempo. Probá en unos minutos.' },
  // Bypass en tests — mismo pattern que signupLimiter. Las suites de integración
  // hacen bursts de >30 POSTs contra el mismo user y toparían el limiter en
  // NODE_ENV=test si no lo skipeamos (falso positivo 429, no bug de la ruta).
  skip: () => process.env.NODE_ENV === 'test',
});

// ─── PROVEEDORES ────────────────────────────────────────────

// Lista con saldo (lo que les debemos) en USD. Paginado (#M-06): antes
// devolvía TODOS los proveedores sin LIMIT, con LEFT JOIN agregado sobre
// todos sus movimientos. A 500 proveedores con 200 movs c/u ya escanea
// 100k filas. Default 100/página, max 200.
router.get('/', async (req, res, next) => {
  try {
    const { buscar } = req.query;
    const params = [];
    let where = 'WHERE p.deleted_at IS NULL';
    if (buscar) { params.push(`%${buscar}%`); where += ` AND p.nombre ILIKE $${params.length}`; }

    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 200 });

    // Cálculo de saldo (lo que les debemos): fórmula canónica en
    // `lib/saldoProveedor.js` — consolidada 2026-07-17 (task #150). Antes esta
    // CASE convivía inline duplicada con /resumen/saldos + chat-tools +
    // dashboardMensual (este último con bug: no distinguía compras contado).
    //
    // 2026-06-15 multi-tenant (PR 4.4): count + data en una sola withTenant
    // → comparten SET LOCAL. RLS filtra proveedores y proveedor_movimientos.
    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(`SELECT COUNT(*) FROM proveedores p ${where}`, params);
      const dataRes = await client.query(
        `SELECT p.id, p.nombre, p.contacto_nombre, p.contacto_apellido, p.whatsapp, p.ubicacion, p.notas,
                COALESCE(SUM(${SALDO_CASE_M}), 0) AS saldo_usd,
                COALESCE(SUM(CASE WHEN m.tipo='saldo_inicial' THEN m.monto_usd ELSE 0 END), 0) AS saldo_inicial,
                COUNT(m.id) FILTER (WHERE m.id IS NOT NULL) AS movimientos
           FROM proveedores p
           LEFT JOIN proveedor_movimientos m ON m.proveedor_id = p.id AND m.deleted_at IS NULL
           ${where}
          GROUP BY p.id
          ORDER BY p.nombre
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });
    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM proveedores WHERE id = $1 AND deleted_at IS NULL', [id]
      );
      return rows[0] || null;
    });
    if (!row) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json(row);
  } catch (err) { next(err); }
});

// Bulk resolve-or-create de proveedores — para import de stock. No usa
// ON CONFLICT porque `proveedores.nombre` no tiene UNIQUE (decision histórica:
// permitir homónimos con datos de contacto distintos). Estrategia: SELECT
// matching case-insensitive primero, después INSERT solo los que no existen.
// El resultado es idempotente: imports repetidos no duplican.
router.post('/bulk', validate(nombresBulkProveedoresSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const inputDedup = [...new Map(
      req.body.nombres.map(n => [String(n).trim().toLowerCase(), String(n).trim()])
    ).values()].filter(Boolean);
    if (inputDedup.length === 0) return res.json({ creados: 0, proveedores: [] });

    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );
    const lowers = inputDedup.map(n => n.toLowerCase());
    // Filtrar nombres que YA existen (case-insensitive).
    const { rows: existentes } = await client.query(
      `SELECT LOWER(nombre) AS k FROM proveedores
        WHERE LOWER(nombre) = ANY($1::text[]) AND deleted_at IS NULL`,
      [lowers]
    );
    const setExist = new Set(existentes.map(r => r.k));
    const aCrear = inputDedup.filter(n => !setExist.has(n.toLowerCase()));
    if (aCrear.length > 0) {
      // INSERT en bloque solo los faltantes.
      await client.query(
        `INSERT INTO proveedores (nombre) SELECT unnest($1::text[])`,
        [aCrear]
      );
      await audit(client, 'proveedores', 'INSERT', 0, {
        tipo: 'bulk_resolve_or_create_proveedores', nombres: aCrear, user_id: req.user.id,
      });
    }
    // Resolve-or-create: devolvemos id+nombre de TODOS los pedidos (existentes
    // + recién creados). Permite al frontend del import XLSX (2026-06-14)
    // construir movimientos referenciando proveedor_id sin un RTT extra para
    // resolver los ids. Backward compatible: `creados` sigue presente con la
    // misma semántica (cantidad de filas insertadas).
    const { rows: proveedores } = await client.query(
      `SELECT id, nombre FROM proveedores
        WHERE LOWER(nombre) = ANY($1::text[]) AND deleted_at IS NULL`,
      [lowers]
    );
    await client.query('COMMIT');
    res.json({ creados: aCrear.length, proveedores });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.post('/', validate(createProveedorSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { nombre, contacto_nombre, contacto_apellido, whatsapp, ubicacion, notas, saldo_inicial } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );
    const { rows } = await client.query(
      `INSERT INTO proveedores (nombre, contacto_nombre, contacto_apellido, whatsapp, ubicacion, notas)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nombre, contacto_nombre ?? null, contacto_apellido ?? null, whatsapp ?? null, ubicacion ?? null, notas ?? null]
    );
    const prov = rows[0];

    // Saldo inicial → movimiento de apertura (USD). Suma al saldo como deuda.
    const ini = round2(Number(saldo_inicial) || 0);
    if (ini > 0) {
      await client.query(
        `INSERT INTO proveedor_movimientos (proveedor_id, fecha, tipo, descripcion, monto, moneda, monto_usd)
         VALUES ($1, CURRENT_DATE, 'saldo_inicial', 'Saldo inicial', $2, 'USD', $2)`,
        [prov.id, ini]
      );
    }

    await audit(client, 'proveedores', 'INSERT', prov.id, { despues: { ...prov, saldo_inicial: ini }, user_id: req.user.id });
    await client.query('COMMIT');
    // Agenda central (best-effort, fuera de la TX principal).
    // 2026-06-15 multi-tenant: dentro de withTenant para que el INSERT en
    // contactos respete el tenant correcto (la lib lee app.current_tenant).
    await db.withTenant(req.tenantId, async (c) => syncContactoSafe(c, {
      origen: 'proveedores', ref_tabla: 'proveedores', ref_id: prov.id,
      nombre: prov.contacto_nombre || prov.nombre, apellido: prov.contacto_apellido, telefono: prov.whatsapp,
    }));
    res.status(201).json({ ...prov, saldo_usd: ini, movimientos: ini > 0 ? 1 : 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.put('/:id', validate(updateProveedorSchema), async (req, res, next) => {
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
    const before = await client.query('SELECT * FROM proveedores WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Proveedor no encontrado' }); }

    const { nombre, contacto_nombre, contacto_apellido, whatsapp, ubicacion, notas, saldo_inicial } = req.body;
    const { rows } = await client.query(
      `UPDATE proveedores SET
         nombre            = COALESCE($1, nombre),
         contacto_nombre   = COALESCE($2, contacto_nombre),
         contacto_apellido = COALESCE($3, contacto_apellido),
         whatsapp          = COALESCE($4, whatsapp),
         ubicacion         = COALESCE($5, ubicacion),
         notas             = COALESCE($6, notas)
       WHERE id = $7 RETURNING *`,
      [nombre ?? null, contacto_nombre ?? null, contacto_apellido ?? null, whatsapp ?? null, ubicacion ?? null, notas ?? null, id]
    );

    // Ajuste del saldo inicial (movimiento de apertura) si vino en el body
    if (saldo_inicial !== undefined && saldo_inicial !== null) {
      const ini = round2(Number(saldo_inicial) || 0);
      const ap = await client.query(
        `SELECT id FROM proveedor_movimientos WHERE proveedor_id = $1 AND tipo = 'saldo_inicial' AND deleted_at IS NULL ORDER BY id LIMIT 1`, [id]
      );
      if (ini > 0 && ap.rows[0]) {
        await client.query('UPDATE proveedor_movimientos SET monto = $1, monto_usd = $1 WHERE id = $2', [ini, ap.rows[0].id]);
      } else if (ini > 0) {
        await client.query(
          `INSERT INTO proveedor_movimientos (proveedor_id, fecha, tipo, descripcion, monto, moneda, monto_usd)
           VALUES ($1, CURRENT_DATE, 'saldo_inicial', 'Saldo inicial', $2, 'USD', $2)`, [id, ini]
        );
      } else if (ap.rows[0]) {
        // ini == 0 → quitar el saldo inicial
        await client.query('UPDATE proveedor_movimientos SET deleted_at = NOW() WHERE id = $1', [ap.rows[0].id]);
      }
    }

    await audit(client, 'proveedores', 'UPDATE', id, { antes: before.rows[0], despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    // Agenda central (best-effort, fuera de la TX principal).
    // 2026-06-15 multi-tenant: ver comentario en POST /.
    await db.withTenant(req.tenantId, async (c) => syncContactoSafe(c, {
      origen: 'proveedores', ref_tabla: 'proveedores', ref_id: rows[0].id,
      nombre: rows[0].contacto_nombre || rows[0].nombre, apellido: rows[0].contacto_apellido, telefono: rows[0].whatsapp,
    }));
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    // 2026-06-15 multi-tenant (PR 4.4): UPDATE + audit in-tx (antes el audit
    // corría con pool global, sin contexto de tenant).
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE proveedores SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
      );
      if (!rows[0]) return null;
      await audit(client, 'proveedores', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── BULK DELETE: TODOS LOS PROVEEDORES ────────────────────────────────────
//
// Borrado masivo en cascada — pedido por Lucas 2026-06-15. Único caller
// previsto: botón admin "Eliminar todos los proveedores" en la pantalla.
// Operación destructiva → adminOnly + tx única atómica.
//
// Cascada:
//   1. Lockea TODOS los proveedor_movimientos vivos del tenant + sus productos.
//   2. Si algún producto está vendido → 409 (no rompemos historial de ventas).
//   3. Soft-delete productos creados por las compras → inventario refleja.
//   4. Soft-delete proveedor_movimientos (compras + pagos) en bloque.
//   5. Para cada movimiento: reverseCajaMovimientos — revierte egresos de
//      compras-contado y de pagos. Si alguna caja queda en negativo, la lib
//      tira 409 → la tx hace ROLLBACK y se preserva el estado original.
//   6. Soft-delete proveedores.
//   7. Invalida caches (inventarioCache + cajasCache) — los saldos cambiaron.
//   8. Audit-lote (no audit por proveedor — 1 entry con conteo y user_id).
//
// Compras con productos PARCIALMENTE vendidos: por decisión de Lucas, NO se
// tocan (el endpoint 409 antes de borrar nada si DETECTA esa situación).
// Para limpiar el resto sin afectar el historial vendido, el operador puede
// borrar manualmente compra por compra o usar el flow de "Vaciar stock +
// compras" en Inventario que sí tolera parciales.
router.post('/bulk-delete-all', adminOnly, async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    // 1. Lockear movimientos vivos del tenant.
    const { rows: movs } = await client.query(
      `SELECT id, proveedor_id FROM proveedor_movimientos
        WHERE deleted_at IS NULL
        ORDER BY id FOR UPDATE`
    );

    // 2. Lockear productos vivos creados por esos movimientos.
    let prods = [];
    if (movs.length > 0) {
      const movIds = movs.map(m => m.id);
      const { rows } = await client.query(
        `SELECT id, nombre, estado, proveedor_movimiento_id
           FROM productos
          WHERE proveedor_movimiento_id = ANY($1::int[]) AND deleted_at IS NULL
          ORDER BY id FOR UPDATE`,
        [movIds]
      );
      prods = rows;
      const vendidos = prods.filter(p => p.estado === 'vendido');
      if (vendidos.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `No se puede borrar: ${vendidos.length} producto(s) de compras a proveedores ya se vendieron: ${vendidos.map(p => p.nombre).slice(0, 3).join(', ')}${vendidos.length > 3 ? '…' : ''}. Resolvé/borrá esas compras a mano primero.`,
          productos_vendidos: vendidos.map(p => p.id),
        });
      }
    }

    // 3. Lockear proveedores vivos (el lock evita races con altas/edits concurrentes).
    const { rows: provs } = await client.query(
      `SELECT id FROM proveedores
        WHERE deleted_at IS NULL
        ORDER BY id FOR UPDATE`
    );

    if (provs.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, proveedores_borrados: 0, movimientos_borrados: 0, productos_borrados: 0 });
    }

    // 4. Soft-delete productos.
    if (prods.length > 0) {
      await client.query(
        `UPDATE productos SET deleted_at = NOW()
           WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
        [prods.map(p => p.id)]
      );
    }

    // 5. Soft-delete movimientos.
    if (movs.length > 0) {
      await client.query(
        `UPDATE proveedor_movimientos SET deleted_at = NOW()
           WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
        [movs.map(m => m.id)]
      );
      // 6. Revertir caja por cada movimiento (uno por uno porque
      //    reverseCajaMovimientos opera por ref puntual). Si alguno deja la
      //    caja en negativo, throw → ROLLBACK total → tenant queda intacto.
      for (const m of movs) {
        await reverseCajaMovimientos(client, 'proveedor_movimientos', m.id);
      }
    }

    // 7. Soft-delete proveedores.
    await client.query(
      `UPDATE proveedores SET deleted_at = NOW()
         WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
      [provs.map(p => p.id)]
    );

    // 8. Audit-lote (1 entry, no N).
    await audit(client, 'proveedores', 'DELETE', 0, {
      tipo: 'bulk_delete_all_proveedores',
      proveedores: provs.length,
      movimientos: movs.length,
      productos: prods.length,
      user_id: req.user.id,
    });

    await client.query('COMMIT');
    invalidateMetricas(req.tenantId);
    invalidateCajas(req.tenantId);
    res.json({
      ok: true,
      proveedores_borrados: provs.length,
      movimientos_borrados: movs.length,
      productos_borrados: prods.length,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // reverseCajaMovimientos puede tirar err.status (409 saldo insuficiente).
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// ─── MOVIMIENTOS (compras y pagos) ──────────────────────────

router.get('/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query('SELECT COUNT(*) FROM proveedor_movimientos WHERE proveedor_id = $1 AND deleted_at IS NULL', [id]);
      const dataRes = await client.query(
        `SELECT m.*, mp.nombre AS caja_nombre,
                COALESCE(
                  (SELECT json_agg(i.* ORDER BY i.id)
                     FROM proveedor_movimiento_items i
                    WHERE i.proveedor_movimiento_id = m.id), '[]'
                ) AS items
           FROM proveedor_movimientos m
           LEFT JOIN metodos_pago mp ON mp.id = m.caja_id
          WHERE m.proveedor_id = $1 AND m.deleted_at IS NULL
          ORDER BY m.fecha DESC, m.id DESC
          LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      );
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });
    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) { next(err); }
});

// Registro de compra/pago — igual al flujo B2B: una COMPRA carga ítems (productos
// comprados); un PAGO no. Transaccional (movimiento + ítems atómicos).
router.post('/movimientos', compraMovimientoLimiter, validate(createMovimientoProveedorSchema), async (req, res, next) => {
  // 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G): Idempotency-Key.
  const idem = parseIdempotencyKey(req);
  if (idem.error) {
    return res.status(400).json({ error: idem.error, reason: 'idempotency_key_invalid' });
  }

  const client = await db.connect();
  try {
    const { proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, caja_id, notas, items = [] } = req.body;
    // Multi-país F2: rechazar moneda no habilitada para el país del tenant.
    assertMonedaValidaParaPais(moneda, req.tenantPais, 'moneda');

    // #H-05 cross-module: si la compra crea productos en Inventario, exigir
    // también permiso `inventario` (no alcanza con solo `proveedores`).
    // Evita que un user al que se le quitó `inventario` siga creando stock
    // por la puerta de atrás.
    const creaStock = tipo === 'compra' && items.some(it => it.producto_stock);
    if (creaStock) {
      // 2026-06-23 F4: cutover a requireCapability. hasCapability mantiene
      // la misma semántica para checks cross-módulo inline.
      const { hasCapability } = require('../middleware/requireCapability');
      const ok = await hasCapability(req.user, 'inventario.ver');
      if (!ok) {
        return res.status(403).json({
          error: 'Para registrar una compra que crea productos necesitás también permiso de Inventario.',
        });
      }
    }

    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    // Idempotency replay: si el caller ya intentó con esta key, devolvemos el
    // movimiento original SIN reejecutar caja + productos.
    if (idem.key) {
      const existing = await findExistingByIdempotencyKey(client, 'proveedor_movimientos', idem.key);
      if (existing) {
        await client.query('ROLLBACK');
        return res.status(200).json({ ...existing, idempotent_replay: true });
      }
    }

    const prov = await client.query('SELECT id, nombre FROM proveedores WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [proveedor_id]);
    if (!prov.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Proveedor no encontrado' }); }

    // Pre-validación IMEI duplicado: si algún item.producto_stock trae un IMEI
    // que ya existe en `productos` (vivo), abortar ANTES de hacer cualquier
    // INSERT. Regla del negocio: IMEI es único físicamente.
    if (tipo === 'compra' && items.length > 0) {
      const imeisACrear = items
        .filter(it => it.producto_stock?.imei)
        .map(it => String(it.producto_stock.imei).trim())
        .filter(Boolean);
      if (imeisACrear.length > 0) {
        // Detectar duplicados internos en el mismo payload
        const seen = new Set();
        for (const i of imeisACrear) {
          if (seen.has(i)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `IMEI duplicado dentro del mismo lote: ${i}` });
          }
          seen.add(i);
        }
        // #H-04 — Lock distribuido por IMEI: previene la race condition TOCTOU
        // entre el SELECT (línea siguiente) y el INSERT (más abajo) cuando dos
        // requests concurrentes piden el mismo IMEI. pg_advisory_xact_lock
        // toma un lock por sesión que se libera con la transacción. Ordenamos
        // los hashes para evitar deadlock entre lotes con IMEIs cruzados.
        const hashes = [...new Set(imeisACrear.map(i => i))].sort();
        for (const imei of hashes) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [imei]);
        }
        // Choque con stock existente
        const { rows: existing } = await client.query(
          `SELECT imei FROM productos WHERE imei = ANY($1::text[]) AND deleted_at IS NULL`,
          [imeisACrear]
        );
        if (existing.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `IMEI ya existe${existing.length > 1 ? 's' : ''} en Inventario: ${existing.map(r => r.imei).join(', ')}`,
            imeis_existentes: existing.map(r => r.imei),
          });
        }
      }

      // 2026-07-31 (task #265, bug Nook Tech): validar clase_id upfront
      // — bulk query + rechazo 400 si alguno no existe en clases_producto
      // del tenant. Antes se guardaba silencioso como NULL si el frontend
      // no lo mandaba (regresión histórica cuando `categoria_id` legacy
      // pisaba el shape) → productos aparecían como "Sin categoría" en
      // Inventario. Mismo patrón que inventario.js:1811-1829 con
      // categoria_id, pero acá el rechazo es HARD porque F3 ya es
      // canónico (Inventario > Agregar producto exige clase_id).
      //
      // Nota: la RLS activa por SET LOCAL scopea el query al tenant.
      // Debe ir FUERA del `if (imeisACrear.length > 0)` — hay items sin
      // IMEI (accesorios, cargadores) que también necesitan validación.
      const claseIds = [...new Set(
        items.filter(it => it.producto_stock?.clase_id)
             .map(it => it.producto_stock.clase_id)
      )];
      if (claseIds.length > 0) {
        const { rows: valid } = await client.query(
          `SELECT id FROM clases_producto
            WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [claseIds]
        );
        const okSet = new Set(valid.map(r => r.id));
        const invalidas = claseIds.filter(id => !okSet.has(id));
        if (invalidas.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Categorías inválidas o eliminadas: ${invalidas.join(', ')}. Revisá el modal — puede haber quedado seleccionada una categoría que borraste.`,
            clase_ids_invalidas: invalidas,
          });
        }
      }

      // task #269 (bug Nook Tech): regla IMEI ⇒ cantidad=1. Un IMEI/serie
      // identifica un dispositivo físico único. Reject 400 si algún item
      // con producto_stock trae IMEI y cantidad > 1. Antes solo se validaba
      // si la clase era unitaria (celular/ipad), pero un accesorio con IMEI
      // (raro pero posible: gadget con serie) escapaba el check.
      const violacionImei = items.find(it => {
        const ps = it.producto_stock;
        if (!ps) return false;
        const imei = String(ps.imei || '').trim();
        if (!imei) return false;
        const cant = Number(ps.cantidad);
        return !Number.isNaN(cant) && cant > 1;
      });
      if (violacionImei) {
        await client.query('ROLLBACK');
        const bad = violacionImei.producto_stock;
        return res.status(400).json({
          error: `Un producto con IMEI/Serie debe tener cantidad = 1 (IMEI "${bad.imei}" tiene cantidad ${bad.cantidad}). El IMEI identifica una unidad física única — si querés cargar N unidades, dejá el IMEI vacío o cargá cada IMEI como fila separada.`,
          imei_conflictivo: bad.imei,
        });
      }
    }

    const monto_usd = round2(toUsd(monto, moneda, tc));
    const { rows } = await client.query(
      `INSERT INTO proveedor_movimientos (proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, monto_usd, caja_id, notas, created_by_user_id, client_generated_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [proveedor_id, fecha, tipo, descripcion ?? null, monto, moneda, tc ?? null, monto_usd, caja_id ?? null, notas ?? null, req.user.id, idem.key]
    );
    const mov = rows[0];

    // Ítems solo en compras (los pagos no llevan productos)
    //
    // #P-01 bulkificado con UNNEST: antes era un loop con 1 INSERT por item +
    // 1 INSERT por producto + 1 audit por producto. Para 50 items con stock:
    // ~150 round-trips secuenciales bloqueando el FOR UPDATE del proveedor.
    // Ahora: 1 INSERT items + 1 INSERT productos + 1 audit del lote = 3 RTT.
    let insertedItems = [];
    let productosCreados = [];
    if (tipo === 'compra' && items.length > 0) {
      // 1) Bulk INSERT de los items (siempre).
      const itemRes = await client.query(
        `INSERT INTO proveedor_movimiento_items
           (proveedor_movimiento_id, producto, modelo, tamano, color, imei_serial, valor, verificado, notas)
         SELECT $1, p, m, t, c, i, v, vf, n
           FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                      $7::numeric[], $8::boolean[], $9::text[])
                AS u(p, m, t, c, i, v, vf, n)
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
        ]
      );
      insertedItems = itemRes.rows;

      // 2) Bulk INSERT de productos para los items con producto_stock.
      //    Auto-fill: proveedor forzado al nombre del proveedor (#H-06).
      //
      //    2026-07-31 (feature FK producto_id): guardamos el índice original
      //    de cada stockItem en `items` para poder vincular el producto
      //    creado con el item correspondiente vía UPDATE post-INSERT.
      //    Los productos vuelven de RETURNING * en el mismo orden que se
      //    pasaron los arrays UNNEST, entonces productosCreados[i]
      //    corresponde a stockItemsIdx[i].
      const stockItemsIdx = items
        .map((it, idx) => ({ it, idx }))
        .filter(({ it }) => it.producto_stock);
      const stockItems = stockItemsIdx.map(({ it }) => it);
      if (stockItems.length > 0) {
        const STOCK_COLS = [
          'tipo_carga', 'clase_id', 'nombre', 'imei', 'gb', 'color', 'bateria',
          'categoria_id', 'deposito_id', 'proveedor', 'costo', 'costo_moneda',
          'precio_venta', 'precio_moneda', 'trackear_stock', 'cantidad', 'estado',
          'observaciones', 'condicion', 'oculto', 'proveedor_movimiento_id',
        ];
        const params = STOCK_COLS.map((col, i) => `$${i + 1}::${pgArrayType(col)}[]`).join(', ');
        const colsAlias = STOCK_COLS.map((_, i) => `c${i + 1}`).join(', ');
        const insertCols = STOCK_COLS.join(', ');
        const arrays = STOCK_COLS.map(col => stockItems.map(it => {
          const ps = it.producto_stock;
          if (col === 'proveedor')               return prov.rows[0].nombre;
          if (col === 'condicion')               return ps.condicion ?? 'nuevo';
          if (col === 'oculto')                  return ps.oculto    ?? false;
          if (col === 'proveedor_movimiento_id') return mov.id;
          return ps[col] ?? null;
        }));
        const prodRes = await client.query(
          `INSERT INTO productos (${insertCols})
             SELECT ${colsAlias} FROM UNNEST(${params}) AS u(${colsAlias})
             RETURNING *`,
          arrays
        );
        productosCreados = prodRes.rows;

        // 3) Vincular items ↔ productos via producto_id (feature FK 2026-07-31).
        //    Cierra la limitación del sync IMEI-based del PR #951: items sin
        //    IMEI (accesorios) ahora también se sincronizan por FK en edits
        //    futuros. Bulk UPDATE con UNNEST — 1 RTT extra vs. matching manual.
        const itemIds = stockItemsIdx.map(({ idx }) => insertedItems[idx].id);
        const prodIds = productosCreados.map(p => p.id);
        await client.query(
          `UPDATE proveedor_movimiento_items pmi
              SET producto_id = u.pid
             FROM UNNEST($1::int[], $2::int[]) AS u(iid, pid)
            WHERE pmi.id = u.iid`,
          [itemIds, prodIds]
        );
        // Refresh insertedItems con el producto_id popularizado (para el
        // response del cliente + audit_logs abajo).
        for (let i = 0; i < stockItemsIdx.length; i++) {
          insertedItems[stockItemsIdx[i].idx].producto_id = prodIds[i];
        }

        // 1 sólo audit-lote en vez de 1 por producto. La trazabilidad queda
        // en el JSON 'despues.ids' + ref al movimiento de compra.
        // 1 audit-lote con flag _bulk: true (constraint solo acepta
        // INSERT/UPDATE/DELETE).
        await audit(client, 'productos', 'INSERT', productosCreados[0]?.id || mov.id, {
          despues: {
            _bulk: true,
            _origen: 'compra_proveedor',
            proveedor_movimiento_id: mov.id,
            ids: productosCreados.map(p => p.id),
            count: productosCreados.length,
          },
          user_id: req.user.id,
        });
      }
    }

    // Flujo "sale dinero, entra inventario": una COMPRA con caja_id elegida
    // se trata como contado (sale el efectivo al instante). Sin caja_id queda
    // como deuda con el proveedor (flujo histórico, se paga después con tipo=pago).
    // Un PAGO siempre sale de la caja indicada.
    if (caja_id && (tipo === 'pago' || tipo === 'compra')) {
      await postCajaMovimiento(client, {
        caja_id, fecha, tipo: 'egreso', monto, moneda, tc,
        origen: 'proveedor', ref_tabla: 'proveedor_movimientos', ref_id: mov.id,
        concepto: tipo === 'pago' ? 'Pago a proveedor' : 'Compra a proveedor (contado)',
        user_id: req.user.id,
      });
    }

    await audit(client, 'proveedor_movimientos', 'INSERT', mov.id, { despues: { ...mov, items: insertedItems }, user_id: req.user.id });
    await client.query('COMMIT');
    // 2026-07-12 (auditoría TOTAL P0-3 Stock): invalidar cache de inventario.
    // Este endpoint puede crear productos (línea 584-589 aprox), y con o sin
    // productos nuevos afecta el saldo del proveedor que aparece en KPIs.
    // Fire-and-forget cross-instance vía Redis DEL.
    invalidateMetricas(req.tenantId).catch((err) => require('../lib/logger').warn({ err: err.message, tenantId: req.tenantId }, '[proveedores] invalidateMetricas post-COMMIT falló'));
    res.status(201).json({ ...mov, items: insertedItems, productos_creados: productosCreados });
  } catch (err) {
    await client.query('ROLLBACK');
    // Race window Pattern G — UNIQUE index atrapa al 2do request concurrente.
    if (isIdempotencyConflict(err)) {
      return res.status(409).json({
        error: 'Otro request con la misma Idempotency-Key está en curso. Reintentá en un instante.',
        reason: 'idempotency_conflict',
      });
    }
    next(err);
  } finally { client.release(); }
});

// ─── Editar compra existente (Fase B pedido Gianfranco 2026-07-30) ─────────
//
// Permite editar campos del movimiento (fecha, notas, descripción) + REEMPLAZAR
// completamente el array de items. El handler diffea por `id`:
//   · id en body existente en DB → UPDATE campos del item + UPDATE producto si sync
//   · id NO en body → soft-delete item + soft-delete producto asociado (guard: no vendido)
//   · sin id → INSERT item + INSERT producto si producto_stock
//
// Recalcula `monto` desde SUM(valor de items VIVOS) y ajusta `monto_usd`. Si la
// compra era contado (caja_id), reverse + re-post el caja_movimiento con el
// monto nuevo.
//
// Guards:
//   · Solo tipo=compra. Pagos, saldos, relevos, devolucion, entrega_mercaderia
//     no editables por esta ruta (tienen sus propios workflows).
//   · Productos ya vendidos no removibles (409).
//   · IMEI duplicado global (dentro del lote o vs stock existente) → 409.
//   · Capability `proveedores.eliminar_compra` (misma sensibilidad que borrar,
//     ya que editar valores/items impacta saldo del proveedor + caja).
//   · Idempotency-Key opcional (mismo pattern que POST).
//
// SYNC ITEM → PRODUCTO (limitación conocida):
//   Los productos vinculados a items se identifican por matching por IMEI
//   ORIGINAL (imei_serial que tenía el item ANTES del edit). Esto funciona
//   para items con IMEI/serial no vacío. Items sin IMEI no se pueden vincular
//   con seguridad al producto asociado — para editar sus datos, hay que ir
//   a Inventario directo. Task backlog: agregar columna
//   `proveedor_movimiento_items.producto_id` (FK) via migration para tracking
//   determinístico.
router.put('/movimientos/:mid', compraMovimientoLimiter,
  requireCapability('proveedores.eliminar_compra'),
  validate(updateMovimientoProveedorSchema),
  async (req, res, next) => {
    const mid = parseId(req.params.mid);
    if (!mid) return res.status(400).json({ error: 'movimiento_id inválido' });

    const idem = parseIdempotencyKey(req);
    if (idem.error) return res.status(400).json({ error: idem.error, reason: 'idempotency_key_invalid' });

    const { fecha, descripcion, notas, items: itemsBody } = req.body;
    const bodyItems = Array.isArray(itemsBody) ? itemsBody : null;  // null = "no tocar items"

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', $1::text, true)`, [String(req.tenantId)]);

      // Idempotency replay (raro para edits, pero cubre reintentos por network flake)
      if (idem.key) {
        const existing = await findExistingByIdempotencyKey(client, 'proveedor_movimientos', idem.key);
        if (existing && existing.id === mid) {
          await client.query('ROLLBACK');
          return res.status(200).json({ ...existing, idempotent_replay: true });
        }
      }

      // 1) Lock del movimiento + validaciones
      const movRes = await client.query(
        `SELECT * FROM proveedor_movimientos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [mid]
      );
      if (!movRes.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
      const mov = movRes.rows[0];
      if (mov.tipo !== 'compra') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Solo se pueden editar compras (tipo=${mov.tipo} no editable por esta ruta).`,
          tipo: mov.tipo,
        });
      }

      // 2) Cargar items actuales + producto asociado.
      //
      // 2026-07-31: usamos la FK directa `i.producto_id` (agregada por migration
      // 20260731100000). Antes se matcheaba por IMEI (LEFT JOIN por
      // proveedor_movimiento_id + imei_serial), lo cual dejaba fuera items sin
      // IMEI (accesorios). Ahora el link es determinístico — items con o sin
      // IMEI sincronizan igual. Los items históricos con IMEI fueron
      // backfilleados por la migration; los sin IMEI quedaron con producto_id
      // NULL y se pueden editar solo desde Inventario (limitación conocida
      // para históricos, aplica solo a filas creadas antes de 2026-07-31).
      const currentItemsRes = await client.query(
        `SELECT i.*,
                p.id AS p_producto_id,
                p.estado AS producto_estado,
                p.nombre AS producto_nombre
           FROM proveedor_movimiento_items i
      LEFT JOIN productos p
             ON p.id = i.producto_id
            AND p.deleted_at IS NULL
          WHERE i.proveedor_movimiento_id = $1
          ORDER BY i.id`,
        [mid]
      );
      // Normalizo el shape: en el código de abajo se lee `.producto_id`.
      // La FK propia del item viene en `i.producto_id`; el LEFT JOIN devuelve
      // `p.id AS p_producto_id` solo si el producto NO está soft-deleted.
      // Si `producto_id` está seteado pero el producto está soft-deleted,
      // `p_producto_id` es NULL y NO consideramos que haya producto vivo asociado.
      const currentItems = currentItemsRes.rows.map(r => ({
        ...r,
        producto_id: r.p_producto_id, // solo si producto está vivo
      }));
      const currentById = new Map(currentItems.map(i => [i.id, i]));

      // Si el body NO manda items, dejamos el array actual sin tocar (los diffs
      // quedan vacíos y el resto del handler solo actualiza fecha/notas/desc).
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

      // 3) Guard: productos a remover que YA se vendieron
      const vendidos = toRemove
        .filter(i => i.producto_id && i.producto_estado === 'vendido')
        .map(i => i.producto_nombre || i.producto || `producto #${i.producto_id}`);
      if (vendidos.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `No se puede eliminar ${vendidos.length} producto(s) ya vendido(s): ${vendidos.slice(0, 3).join(', ')}${vendidos.length > 3 ? '…' : ''}. Anulá la(s) venta(s) primero o dejá el ítem en la compra.`,
          productos_vendidos: vendidos,
        });
      }

      // 4) Validar IMEI globalmente único
      // Recopilar IMEIs que van a existir POST-edit en `productos` (vivos).
      // Excluir los producto_ids que ya son del movimiento actual (colisión consigo mismo).
      const productosPropios = new Set(currentItems.filter(i => i.producto_id).map(i => i.producto_id));
      // IMEIs de items nuevos con producto_stock
      const imeisNuevos = toInsert
        .filter(bi => bi.producto_stock?.imei)
        .map(bi => String(bi.producto_stock.imei).trim())
        .filter(Boolean);
      // IMEIs de items existentes cuyo imei cambia (nuevo imei distinto del original)
      const imeisEditados = [];
      for (const bi of toUpdate) {
        const orig = currentById.get(bi.id);
        const nuevoImei = (bi.imei_serial ?? '').trim();
        if (nuevoImei && nuevoImei !== (orig.imei_serial || '').trim()) {
          imeisEditados.push(nuevoImei);
        }
      }
      const imeisAValidar = [...imeisNuevos, ...imeisEditados];

      if (imeisAValidar.length > 0) {
        // Duplicados internos en el body
        const seen = new Set();
        for (const im of imeisAValidar) {
          if (seen.has(im)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `IMEI duplicado dentro del mismo lote de edición: ${im}` });
          }
          seen.add(im);
        }
        // Advisory locks por IMEI (idem POST)
        for (const im of [...seen].sort()) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [im]);
        }
        // Colisión con productos existentes EXCLUYENDO los propios del mov
        const propiosArr = [...productosPropios];
        const { rows: colisiones } = await client.query(
          `SELECT imei FROM productos
            WHERE imei = ANY($1::text[])
              AND deleted_at IS NULL
              AND ($2::int[] IS NULL OR id <> ALL($2::int[]))`,
          [imeisAValidar, propiosArr.length > 0 ? propiosArr : null]
        );
        if (colisiones.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: `IMEI ya existe${colisiones.length > 1 ? 'n' : ''} en Inventario: ${colisiones.map(r => r.imei).join(', ')}`,
            imeis_existentes: colisiones.map(r => r.imei),
          });
        }
      }

      // 2026-07-31 (task #265): validar clase_id de items nuevos (toInsert).
      // Espejo de la validación en POST /movimientos — evita que un edit
      // agregue productos con clase_id inválido/eliminado (mismo síntoma:
      // producto termina "Sin categoría" en Inventario).
      const claseIdsNuevos = [...new Set(
        toInsert.filter(bi => bi.producto_stock?.clase_id)
                .map(bi => bi.producto_stock.clase_id)
      )];
      if (claseIdsNuevos.length > 0) {
        const { rows: valid } = await client.query(
          `SELECT id FROM clases_producto
            WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [claseIdsNuevos]
        );
        const okSet = new Set(valid.map(r => r.id));
        const invalidas = claseIdsNuevos.filter(id => !okSet.has(id));
        if (invalidas.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: `Categorías inválidas o eliminadas: ${invalidas.join(', ')}.`,
            clase_ids_invalidas: invalidas,
          });
        }
      }

      // 5) Mutations — orden: UPDATE items, INSERT items+productos, DELETE items+productos
      const prov = await client.query('SELECT nombre FROM proveedores WHERE id = $1', [mov.proveedor_id]);
      const provNombre = prov.rows[0]?.nombre;

      // 5a. UPDATE items existentes + sync producto si aplica
      for (const bi of toUpdate) {
        const orig = currentById.get(bi.id);
        await client.query(
          `UPDATE proveedor_movimiento_items
              SET producto = $1, modelo = $2, tamano = $3, color = $4,
                  imei_serial = $5, valor = $6, verificado = $7, notas = $8
            WHERE id = $9`,
          [
            bi.producto ?? null, bi.modelo ?? null, bi.tamano ?? null, bi.color ?? null,
            bi.imei_serial ?? null, bi.valor ?? null, bi.verificado ?? false, bi.notas ?? null,
            bi.id,
          ]
        );

        // Sync producto asociado (si el item tenía uno vinculado por IMEI original)
        if (orig.producto_id) {
          // Mapping: item.producto → nombre, imei_serial → imei, tamano → gb,
          // color → color, valor → costo. Otros campos (categoria_id, deposito_id,
          // precio_venta, estado, condicion, etc.) solo se editan desde Inventario.
          await client.query(
            `UPDATE productos
                SET nombre = COALESCE($1, nombre),
                    imei = $2,
                    gb = $3,
                    color = $4,
                    costo = COALESCE($5, costo)
              WHERE id = $6`,
            [bi.producto ?? null, bi.imei_serial ?? null, bi.tamano ?? null, bi.color ?? null, bi.valor ?? null, orig.producto_id]
          );
        }
      }

      // 5b. INSERT items nuevos + INSERT productos si producto_stock
      let insertedItems = [];
      let productosCreados = [];
      if (toInsert.length > 0) {
        const itemInsertRes = await client.query(
          `INSERT INTO proveedor_movimiento_items
             (proveedor_movimiento_id, producto, modelo, tamano, color, imei_serial, valor, verificado, notas)
           SELECT $1, p, m, t, c, i, v, vf, n
             FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                        $7::numeric[], $8::boolean[], $9::text[])
                  AS u(p, m, t, c, i, v, vf, n)
           RETURNING *`,
          [
            mid,
            toInsert.map(it => it.producto ?? null),
            toInsert.map(it => it.modelo ?? null),
            toInsert.map(it => it.tamano ?? null),
            toInsert.map(it => it.color ?? null),
            toInsert.map(it => it.imei_serial ?? null),
            toInsert.map(it => it.valor ?? null),
            toInsert.map(it => it.verificado ?? false),
            toInsert.map(it => it.notas ?? null),
          ]
        );
        insertedItems = itemInsertRes.rows;

        // INSERT productos para items con producto_stock (mismo pattern que POST)
        // 2026-07-31 (feature FK producto_id): además vinculamos item ↔ producto
        // via producto_id post-INSERT, misma técnica que en el POST.
        const stockItemsIdx = toInsert
          .map((it, idx) => ({ it, idx }))
          .filter(({ it }) => it.producto_stock);
        const stockItems = stockItemsIdx.map(({ it }) => it);
        if (stockItems.length > 0) {
          // Cross-módulo: si crea stock, requerir capability inventario también.
          const { hasCapability } = require('../middleware/requireCapability');
          const ok = await hasCapability(req.user, 'inventario.ver');
          if (!ok) {
            await client.query('ROLLBACK');
            return res.status(403).json({
              error: 'Para agregar items que crean productos en Inventario necesitás también permiso de Inventario.',
            });
          }

          const STOCK_COLS = [
            'tipo_carga', 'clase_id', 'nombre', 'imei', 'gb', 'color', 'bateria',
            'categoria_id', 'deposito_id', 'proveedor', 'costo', 'costo_moneda',
            'precio_venta', 'precio_moneda', 'trackear_stock', 'cantidad', 'estado',
            'observaciones', 'condicion', 'oculto', 'proveedor_movimiento_id',
          ];
          const params = STOCK_COLS.map((col, i) => `$${i + 1}::${pgArrayType(col)}[]`).join(', ');
          const colsAlias = STOCK_COLS.map((_, i) => `c${i + 1}`).join(', ');
          const insertCols = STOCK_COLS.join(', ');
          const arrays = STOCK_COLS.map(col => stockItems.map(it => {
            const ps = it.producto_stock;
            if (col === 'proveedor')               return provNombre;
            if (col === 'condicion')               return ps.condicion ?? 'nuevo';
            if (col === 'oculto')                  return ps.oculto    ?? false;
            if (col === 'proveedor_movimiento_id') return mid;
            return ps[col] ?? null;
          }));
          const prodRes = await client.query(
            `INSERT INTO productos (${insertCols})
               SELECT ${colsAlias} FROM UNNEST(${params}) AS u(${colsAlias})
               RETURNING *`,
            arrays
          );
          productosCreados = prodRes.rows;

          // Vincular items nuevos ↔ productos via FK producto_id.
          const itemIds = stockItemsIdx.map(({ idx }) => insertedItems[idx].id);
          const prodIds = productosCreados.map(p => p.id);
          await client.query(
            `UPDATE proveedor_movimiento_items pmi
                SET producto_id = u.pid
               FROM UNNEST($1::int[], $2::int[]) AS u(iid, pid)
              WHERE pmi.id = u.iid`,
            [itemIds, prodIds]
          );
          for (let i = 0; i < stockItemsIdx.length; i++) {
            insertedItems[stockItemsIdx[i].idx].producto_id = prodIds[i];
          }
        }
      }

      // 5c. DELETE items removidos + soft-delete producto asociado
      // La tabla proveedor_movimiento_items NO tiene deleted_at (schema
      // original de 2026-05-25 no lo agregó). Como estos items no se
      // referencian desde otras tablas post-carga, hacemos HARD DELETE — el
      // audit trail queda en el JSON antes/después del audit_logs abajo.
      for (const orig of toRemove) {
        await client.query('DELETE FROM proveedor_movimiento_items WHERE id = $1', [orig.id]);
        if (orig.producto_id) {
          // Soft-delete del producto asociado (el guard 'vendido' ya se aplicó arriba).
          await client.query(
            `UPDATE productos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
            [orig.producto_id]
          );
        }
      }

      // 6) Recalcular monto desde SUM de items vivos + actualizar mov
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(valor), 0)::numeric AS total
           FROM proveedor_movimiento_items
          WHERE proveedor_movimiento_id = $1`,
        [mid]
      );
      // Si no hubo items en el body (bodyItems === null), no recalculamos —
      // dejamos el monto tal cual. Si hubo items (aún vacío), recalculamos.
      const nuevoMonto = bodyItems !== null ? Number(sumRes.rows[0].total) : Number(mov.monto);
      const nuevoMontoUsd = round2(toUsd(nuevoMonto, mov.moneda, mov.tc));

      await client.query(
        `UPDATE proveedor_movimientos
            SET fecha = COALESCE($1, fecha),
                descripcion = $2,
                notas = $3,
                monto = $4,
                monto_usd = $5
          WHERE id = $6`,
        [fecha ?? null, descripcion ?? null, notas ?? null, nuevoMonto, nuevoMontoUsd, mid]
      );

      // 7) Ajustar caja_movimiento si era contado y el monto cambió
      const montoOriginal = Number(mov.monto);
      const montoCambio = Math.abs(montoOriginal - nuevoMonto) > 0.005;
      const fechaCambio = fecha && String(fecha) !== String(mov.fecha).slice(0, 10);
      if (mov.caja_id && (montoCambio || fechaCambio)) {
        // Reverse el caja_movimiento anterior + re-post con el nuevo monto/fecha.
        // reverseCajaMovimientos borra + genera el reverse. Luego postCajaMovimiento
        // agrega el nuevo. Neto: la caja queda ajustada al valor real.
        await reverseCajaMovimientos(client, 'proveedor_movimientos', mid);
        await postCajaMovimiento(client, {
          caja_id: mov.caja_id, fecha: fecha ?? mov.fecha, tipo: 'egreso',
          monto: nuevoMonto, moneda: mov.moneda, tc: mov.tc,
          origen: 'proveedor', ref_tabla: 'proveedor_movimientos', ref_id: mid,
          concepto: 'Compra a proveedor (contado, editada)',
          user_id: req.user.id,
        });
      }

      // 8) Audit del cambio
      await audit(client, 'proveedor_movimientos', 'UPDATE', mid, {
        antes: {
          fecha: mov.fecha, descripcion: mov.descripcion, notas: mov.notas,
          monto: montoOriginal, monto_usd: Number(mov.monto_usd),
          items_count: currentItems.length,
        },
        despues: {
          fecha: fecha ?? mov.fecha,
          descripcion: descripcion ?? mov.descripcion,
          notas: notas ?? mov.notas,
          monto: nuevoMonto, monto_usd: nuevoMontoUsd,
          items_count: (bodyItems || currentItems).length,
          items_removed: toRemove.length,
          items_added: toInsert.length,
          items_updated: toUpdate.length,
          productos_creados: productosCreados.length,
          productos_soft_deleted: toRemove.filter(i => i.producto_id).length,
        },
        user_id: req.user.id,
      });

      await client.query('COMMIT');

      // Cache invalidation cross-instance
      invalidateMetricas(req.tenantId).catch((err) =>
        require('../lib/logger').warn({ err: err.message, tenantId: req.tenantId },
          '[proveedores] invalidateMetricas post-PUT falló'));
      if (mov.caja_id) {
        invalidateCajas(req.tenantId).catch((err) =>
          require('../lib/logger').warn({ err: err.message, tenantId: req.tenantId },
            '[proveedores] invalidateCajas post-PUT falló'));
      }

      // 9) Devolver estado fresh (items post-edit)
      const finalMov = await db.withTenant(req.tenantId, async (ac) => {
        const mv = await ac.query('SELECT * FROM proveedor_movimientos WHERE id = $1', [mid]);
        const it = await ac.query(
          `SELECT * FROM proveedor_movimiento_items WHERE proveedor_movimiento_id = $1 ORDER BY id`,
          [mid]
        );
        return { ...mv.rows[0], items: it.rows };
      });
      res.json({ ...finalMov, productos_creados: productosCreados });
    } catch (err) {
      await client.query('ROLLBACK');
      if (isIdempotencyConflict(err)) {
        return res.status(409).json({
          error: 'Otro request con la misma Idempotency-Key está en curso. Reintentá en un instante.',
          reason: 'idempotency_conflict',
        });
      }
      next(err);
    } finally { client.release(); }
  }
);

// Bulk multi-proveedor (2026-06-14) — usado por el import XLSX de Inventario
// cuando el archivo tiene productos de distintos proveedores. Procesa N
// movimientos en UNA sola transacción: si cualquiera falla, ninguno se persiste.
//
// La lógica de cada movimiento es idéntica al POST single — replicada inline
// para mantener el endpoint single funcionando tal cual (mismo path, mismo
// cliente, mismo audit trail). Un refactor a helper compartida queda como
// follow-up cuando los 2 endpoints se estabilicen.
router.post('/movimientos/bulk', compraMovimientoLimiter, validate(bulkCreateMovimientosProveedorSchema), async (req, res, next) => {
  const { movimientos } = req.body;
  const client = await db.connect();
  try {
    // ── Pre-validación cross-movimiento: IMEIs duplicados ────────────────
    // Recolectamos TODOS los IMEIs de todos los items con producto_stock
    // a través de TODOS los movimientos. Si hay duplicados (mismo IMEI en
    // 2 movimientos distintos, o en el mismo movimiento dos veces) →
    // rechazo ANTES de empezar la tx. Por qué acá y no por movimiento
    // individual: un IMEI duplicado entre proveedores distintos solo se
    // detecta acá.
    const todosImeis = [];
    for (const mov of movimientos) {
      if (mov.tipo !== 'compra') continue;
      for (const it of (mov.items || [])) {
        if (it.producto_stock?.imei) {
          todosImeis.push(String(it.producto_stock.imei).trim());
        }
      }
    }
    if (todosImeis.length > 0) {
      // Dup interno
      const seen = new Set();
      for (const i of todosImeis) {
        if (seen.has(i)) {
          return res.status(409).json({
            error: `IMEI duplicado dentro del bulk: ${i}`,
            imei: i,
          });
        }
        seen.add(i);
      }
    }

    // ── Permiso inventario para CUALQUIER movimiento que cree stock ──────
    const algunoCreaStock = movimientos.some(m =>
      m.tipo === 'compra' && (m.items || []).some(it => it.producto_stock)
    );
    if (algunoCreaStock) {
      // 2026-06-23 F4: cutover a requireCapability. hasCapability mantiene
      // la misma semántica para checks cross-módulo inline.
      const { hasCapability } = require('../middleware/requireCapability');
      const ok = await hasCapability(req.user, 'inventario.ver');
      if (!ok) {
        return res.status(403).json({
          error: 'Para registrar compras que crean productos necesitás también permiso de Inventario.',
        });
      }
    }

    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(
      `SELECT set_config('app.current_tenant', $1::text, true)`,
      [String(req.tenantId)]
    );

    // Choque con stock existente (1 sola query global para todos los IMEIs)
    if (todosImeis.length > 0) {
      // Lock por IMEI (#H-04). Hashes ordenados para evitar deadlocks.
      const hashes = [...new Set(todosImeis)].sort();
      for (const imei of hashes) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [imei]);
      }
      const { rows: existing } = await client.query(
        `SELECT imei FROM productos WHERE imei = ANY($1::text[]) AND deleted_at IS NULL`,
        [todosImeis]
      );
      if (existing.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `IMEI${existing.length > 1 ? 's' : ''} ya existe${existing.length > 1 ? 'n' : ''} en Inventario: ${existing.map(r => r.imei).join(', ')}`,
          imeis_existentes: existing.map(r => r.imei),
        });
      }
    }

    const resultados = [];
    for (const movData of movimientos) {
      const { proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, caja_id, notas, items = [] } = movData;

      const prov = await client.query(
        'SELECT id, nombre FROM proveedores WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [proveedor_id]
      );
      if (!prov.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: `Proveedor ${proveedor_id} no encontrado` });
      }

      const monto_usd = round2(toUsd(monto, moneda, tc));
      const { rows } = await client.query(
        `INSERT INTO proveedor_movimientos (proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, monto_usd, caja_id, notas, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [proveedor_id, fecha, tipo, descripcion ?? null, monto, moneda, tc ?? null, monto_usd, caja_id ?? null, notas ?? null, req.user.id]
      );
      const mov = rows[0];

      let insertedItems = [];
      let productosCreados = [];
      if (tipo === 'compra' && items.length > 0) {
        const itemRes = await client.query(
          `INSERT INTO proveedor_movimiento_items
             (proveedor_movimiento_id, producto, modelo, tamano, color, imei_serial, valor, verificado, notas)
           SELECT $1, p, m, t, c, i, v, vf, n
             FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                        $7::numeric[], $8::boolean[], $9::text[])
                  AS u(p, m, t, c, i, v, vf, n)
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
          ]
        );
        insertedItems = itemRes.rows;

        const stockItems = items.filter(it => it.producto_stock);
        if (stockItems.length > 0) {
          const STOCK_COLS = [
            'tipo_carga', 'clase_id', 'nombre', 'imei', 'gb', 'color', 'bateria',
            'categoria_id', 'deposito_id', 'proveedor', 'costo', 'costo_moneda',
            'precio_venta', 'precio_moneda', 'trackear_stock', 'cantidad', 'estado',
            'observaciones', 'condicion', 'oculto', 'proveedor_movimiento_id',
          ];
          const params = STOCK_COLS.map((col, i) => `$${i + 1}::${pgArrayType(col)}[]`).join(', ');
          const colsAlias = STOCK_COLS.map((_, i) => `c${i + 1}`).join(', ');
          const insertCols = STOCK_COLS.join(', ');
          const arrays = STOCK_COLS.map(col => stockItems.map(it => {
            const ps = it.producto_stock;
            if (col === 'proveedor')               return prov.rows[0].nombre;
            if (col === 'condicion')               return ps.condicion ?? 'nuevo';
            if (col === 'oculto')                  return ps.oculto    ?? false;
            if (col === 'proveedor_movimiento_id') return mov.id;
            return ps[col] ?? null;
          }));
          const prodRes = await client.query(
            `INSERT INTO productos (${insertCols})
               SELECT ${colsAlias} FROM UNNEST(${params}) AS u(${colsAlias})
               RETURNING *`,
            arrays
          );
          productosCreados = prodRes.rows;

          await audit(client, 'productos', 'INSERT', productosCreados[0]?.id || mov.id, {
            despues: {
              _bulk: true,
              _origen: 'compra_proveedor_bulk',
              proveedor_movimiento_id: mov.id,
              ids: productosCreados.map(p => p.id),
              count: productosCreados.length,
            },
            user_id: req.user.id,
          });
        }
      }

      // Caja: egreso si caja_id elegida (mismo flujo que el single).
      if (caja_id && (tipo === 'pago' || tipo === 'compra')) {
        await postCajaMovimiento(client, {
          caja_id, fecha, tipo: 'egreso', monto, moneda, tc,
          origen: 'proveedor', ref_tabla: 'proveedor_movimientos', ref_id: mov.id,
          concepto: tipo === 'pago' ? 'Pago a proveedor' : 'Compra a proveedor (contado)',
          user_id: req.user.id,
        });
      }

      await audit(client, 'proveedor_movimientos', 'INSERT', mov.id, {
        despues: { ...mov, items: insertedItems, _bulk: true },
        user_id: req.user.id,
      });

      resultados.push({ ...mov, items: insertedItems, productos_creados: productosCreados });
    }

    await client.query('COMMIT');
    // 2026-07-12 (auditoría TOTAL P0-3 Stock): invalidar cache. Este es EL
    // endpoint del import XLSX de Inventario (`Inventario.jsx` → `bulk`).
    // Cada import de 100+ productos dejaba el dashboard stale hasta 20s.
    invalidateMetricas(req.tenantId).catch((err) => require('../lib/logger').warn({ err: err.message, tenantId: req.tenantId }, '[proveedores] invalidateMetricas post-COMMIT falló'));
    res.status(201).json({ movimientos: resultados, count: resultados.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

// 2026-06-23 F5a: gate inline. La capability `proveedores.eliminar_compra`
// reemplaza el viejo check `req.user.role !== 'admin'` (global admin) que
// se rompió con F4 — post-cutover los owners del tenant no son global admins.
// Ahora owner/admin del tenant bypassean; vendedor/encargado/lectura NO la
// tienen en default. La ownership check de abajo se mantiene como defensa
// en depth (incluso con la cap, no podés borrar lo que NO creaste a menos
// que seas owner/admin que bypassea ambos chequeos).
router.delete('/movimientos/:id', requireCapability('proveedores.eliminar_compra'), async (req, res, next) => {
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
    // Ownership check (auditoría #B-07) — defensa en depth además de la cap.
    const { rows: pre } = await client.query(
      'SELECT id, created_by_user_id FROM proveedor_movimientos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id]
    );
    if (!pre[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    // 2026-06-23 F5a: bypass de ownership para roles owner/admin del tenant
    // o admin global. El resto solo puede borrar lo que él mismo creó.
    const isBypass = req.user.role === 'admin'
      || req.user.tenant_cap_rol === 'owner'
      || req.user.tenant_cap_rol === 'admin';
    if (pre[0].created_by_user_id !== req.user.id && !isBypass) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'No tenés permiso para borrar este movimiento (lo creó otro usuario).' });
    }
    const { rows } = await client.query(
      'UPDATE proveedor_movimientos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }

    // Soft-delete en cascada de los productos creados por esta compra
    // (auditoría #B-02). Sólo si NINGUNO de esos productos se vendió ya:
    //   - cantidad cambió desde el insert original (alguien lo vendió) → 409.
    //   - estado pasó a 'vendido' → 409.
    // Esto evita el doble beneficio "recupero caja + mantengo stock".
    // #B-3: ORDER BY id antes de FOR UPDATE. Esta query lockea N productos
    // creados por la compra que se está borrando. Sin orden estable, dos
    // sesiones que borran compras distintas pero comparten productos
    // (cross-referenciados por el mismo proveedor) podrían deadlockearse:
    // PG por sí solo NO garantiza el orden de lock entre tuplas si el plan
    // usa bitmap heap scan o índice no-primario. Forzando ORDER BY id, el
    // optimizador entrega filas en orden ascendente y todas las sesiones
    // siguen la misma cadena de locks.
    const { rows: prods } = await client.query(
      `SELECT id, nombre, estado FROM productos
         WHERE proveedor_movimiento_id = $1 AND deleted_at IS NULL
         ORDER BY id FOR UPDATE`,
      [id]
    );
    const vendidos = prods.filter(p => p.estado === 'vendido');
    if (vendidos.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `No se puede borrar la compra: ${vendidos.length} producto(s) ya se vendieron: ${vendidos.map(p => p.nombre).slice(0, 3).join(', ')}${vendidos.length > 3 ? '…' : ''}`,
        productos_vendidos: vendidos.map(p => p.id),
      });
    }
    if (prods.length > 0) {
      await client.query(
        `UPDATE productos SET deleted_at = NOW()
           WHERE proveedor_movimiento_id = $1 AND deleted_at IS NULL`,
        [id]
      );
    }

    // Revertir el egreso de caja asociado (si lo hubo)
    await reverseCajaMovimientos(client, 'proveedor_movimientos', id);
    await audit(client, 'proveedor_movimientos', 'DELETE', id, {
      antes: rows[0], productos_borrados: prods.map(p => p.id), user_id: req.user.id,
    });
    await client.query('COMMIT');
    // 2026-07-12 (auditoría TOTAL P0-3 Stock): invalidar cache. El DELETE
    // soft-deletea productos (línea 897-901) — los KPIs de inventario los
    // seguían mostrando "vivos" hasta que expiraba el TTL.
    invalidateMetricas(req.tenantId).catch((err) => require('../lib/logger').warn({ err: err.message, tenantId: req.tenantId }, '[proveedores] invalidateMetricas post-COMMIT falló'));
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ─── RELEVO (ajuste manual del saldo del proveedor) ─────────────────────
//
// POST /proveedores/:id/relevo — ajuste manual del saldo real ("arqueo").
//
// Feature 2026-07-29: el user con capability `proveedores.relevar` (owner/admin
// por default) ajusta el saldo del proveedor al valor REAL. Casos:
//   - Pago olvidado en efectivo (le dimos plata que no cargamos).
//   - Compra no cargada (nos mandó mercadería que no anotamos).
//   - Devolución no registrada.
//   - Mobiliario intercambiado ("nos dio una silla").
//   - Cierre de cuenta con ajuste final.
//
// UX: user ingresa `saldo_nuevo_usd`. Server calcula
// `delta = saldo_nuevo - saldo_actual`, deriva el `tipo`:
//   - delta > 0 → 'relevo_incremento' (aumenta la deuda, monto=delta)
//   - delta < 0 → 'relevo_reduccion' (reduce la deuda, monto=abs(delta))
// Ver comentario en `lib/saldoProveedor.js` para el signo en SALDO_CASE.
//
// Diferencia con POST /movimientos:
//   - Movimiento manual: user ingresa monto + tipo (compra/pago) directamente.
//   - Relevo: user ingresa saldo_nuevo, server deriva tipo + monto.
//   - Movimiento: nota opcional. Relevo: OBLIGATORIA min 10 chars.
//   - Movimiento: capability `proveedores.trabajar` (mount-level).
//     Relevo: además `proveedores.relevar` (route-level, más restrictiva).
//
// Audit snapshot completo en `audit_logs.datos_despues`:
//   { accion_negocio: 'relevo_proveedor', saldo_anterior, saldo_nuevo, delta, nota }
//
// Reverte: no hay endpoint dedicado — user hace otro relevo con saldo_nuevo
// = el saldo original (delta opuesto). Trail forense preservado con notas
// de ambos relevos ("Revertir el relevo del 29/07 — motivo original: ...").
//
// Cross-tenant Red B2B: NO enviamos notificación al otro tenant en este PR.
// Backlog para siguiente iteración (requiere extender CHECK constraint de
// cross_tenant_notifications.type con 'relevo_divergent' + partnership lookup
// desde proveedor.id).
router.post('/:id(\\d+)/relevo', requireCapability('proveedores.relevar'),
  validate(proveedorRelevoSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { fecha, saldo_nuevo_usd, nota } = req.body;

    const result = await db.withTenant(req.tenantId, async (client) => {
      // Lock proveedor (FOR UPDATE simple) + verify existe. Sin GROUP BY
      // para no chocar con la restricción de Postgres (visto en cajas).
      const { rows: provRows } = await client.query(
        `SELECT id, nombre FROM proveedores
          WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id]
      );
      if (!provRows[0]) return { notFound: true };

      // Saldo actual: usa SALDO_CASE_M (fuente única de verdad).
      const { rows: saldoRows } = await client.query(
        `SELECT COALESCE(SUM(${SALDO_CASE_M}), 0) AS saldo_actual
           FROM proveedor_movimientos m
          WHERE m.proveedor_id = $1 AND m.deleted_at IS NULL`,
        [id]
      );
      const saldoActual = Number(saldoRows[0].saldo_actual);
      const saldoNuevo  = Number(saldo_nuevo_usd);
      const delta = Math.round((saldoNuevo - saldoActual) * 100) / 100;

      if (delta === 0) {
        return { badRequest: 'El saldo nuevo es igual al actual — no hay ajuste que registrar.' };
      }

      // Signo → tipo. Ambos tipos tienen monto/monto_usd positivos (el
      // CHECK del schema exige >=0). El signo se distingue por el `tipo`.
      const tipo  = delta > 0 ? 'relevo_incremento' : 'relevo_reduccion';
      const monto = Math.abs(delta);

      const { rows: movRows } = await client.query(
        `INSERT INTO proveedor_movimientos
           (proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, monto_usd,
            caja_id, notas, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'USD', NULL, $5,
                 NULL, $6, $7)
         RETURNING *`,
        [id, fecha, tipo, `Relevo — ajuste manual del saldo`, monto, nota, req.user.id]
      );
      const mov = movRows[0];

      await audit(client, 'proveedor_movimientos', 'INSERT', mov.id, {
        despues: {
          ...mov,
          accion_negocio: 'relevo_proveedor',
          saldo_anterior: saldoActual,
          saldo_nuevo:    saldoNuevo,
          delta,
          nota,
        },
        user_id: req.user.id,
      });

      return {
        mov,
        proveedor_nombre: provRows[0].nombre,
        saldo_anterior:   saldoActual,
        saldo_nuevo:      saldoNuevo,
        delta,
      };
    });

    if (result.notFound)   return res.status(404).json({ error: 'Proveedor no encontrado' });
    if (result.badRequest) return res.status(400).json({ error: result.badRequest });

    res.status(201).json({
      ok:               true,
      movimiento:       result.mov,
      proveedor_nombre: result.proveedor_nombre,
      saldo_anterior:   result.saldo_anterior,
      saldo_nuevo:      result.saldo_nuevo,
      delta:            result.delta,
    });
  } catch (err) { next(err); }
});

// ─── RESUMEN (saldos por proveedor) ─────────────────────────

router.get('/resumen/saldos', async (req, res, next) => {
  try {
    // Fórmula canónica en `lib/saldoProveedor.js` (task #150 consolidación).
    // Reglas: pago/devolucion/entrega_mercaderia bajan deuda; compra con
    // caja_id = contado (no deuda); compra sin caja_id + saldo_inicial suman.
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT p.id, p.nombre,
                COALESCE(SUM(${SALDO_CASE_M}), 0) AS saldo_usd
           FROM proveedores p
           LEFT JOIN proveedor_movimientos m ON m.proveedor_id = p.id AND m.deleted_at IS NULL
          WHERE p.deleted_at IS NULL
          GROUP BY p.id
         HAVING COALESCE(SUM(${SALDO_CASE_M}), 0) <> 0
          ORDER BY saldo_usd DESC`
      );
      return rows;
    });
    const total_deuda_usd = round2(rows.reduce((s, r) => s + Number(r.saldo_usd), 0));
    res.json({ proveedores: rows, total_deuda_usd });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id/productos-devolvibles — Productos devolvibles a este proveedor
// ─────────────────────────────────────────────────────────────────────────
//
// Alimenta el modal de "Devolución de mercadería" (task #236) con la lista
// de productos elegibles. Mismos criterios que el POST /:id/devoluciones,
// pero en modo consulta (sin lockear ni modificar):
//   - owned por ESTE proveedor (via productos.proveedor_movimiento_id →
//     proveedor_movimientos.proveedor_id)
//   - estado = 'disponible' + no soft-deleted + cantidad > 0
//   - costo_moneda = 'USD' (v1 constraint)
//
// Soporta `?buscar=<texto>` para filtro cliente-side sobre nombre o IMEI.
// Cap 500 filas — mismo orden de magnitud que Inventario en un tenant típico
// del proveedor más grande; suficiente para que el modal sea usable sin
// scroll infinito.
router.get('/:id(\\d+)/productos-devolvibles', async (req, res, next) => {
  try {
    const proveedorId = parseId(req.params.id);
    if (!proveedorId) return res.status(400).json({ error: 'ID de proveedor inválido' });

    const { buscar } = req.query;

    const rows = await db.withTenant(req.tenantId, async (client) => {
      // 1. Verificar proveedor existe + no eliminado (evita 200 con lista vacía
      //    cuando el proveedor no existe — mejor 404 explícito).
      const { rows: prov } = await client.query(
        `SELECT id FROM proveedores WHERE id = $1 AND deleted_at IS NULL`,
        [proveedorId]
      );
      if (!prov[0]) return null;

      const params = [proveedorId];
      const conds  = [
        `p.deleted_at IS NULL`,
        `p.estado = 'disponible'`,
        `p.cantidad > 0`,
        `pm.proveedor_id = $1`,
        `(p.costo_moneda IS NULL OR p.costo_moneda = 'USD')`,
      ];
      if (buscar && buscar.trim()) {
        params.push(`%${buscar.trim()}%`);
        conds.push(`(p.nombre ILIKE $${params.length} OR p.imei ILIKE $${params.length})`);
      }

      const { rows } = await client.query(
        `SELECT p.id, p.nombre, p.imei, p.color, p.gb,
                p.costo, p.costo_moneda,
                pm.id   AS proveedor_movimiento_id,
                pm.fecha AS fecha_compra,
                c.nombre AS categoria_nombre
           FROM productos p
           JOIN proveedor_movimientos pm ON pm.id = p.proveedor_movimiento_id
      LEFT JOIN categorias c            ON c.id = p.categoria_id
          WHERE ${conds.join(' AND ')}
       ORDER BY pm.fecha DESC, p.id DESC
          LIMIT 500`,
        params
      );
      return rows;
    });

    if (rows === null) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json({ data: rows });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/devoluciones — Devolución de mercadería al proveedor (task #236, 2026-07-27)
// ─────────────────────────────────────────────────────────────────────────
//
// El operador devuelve productos comprados a este proveedor. Casos típicos:
// error de envío del proveedor, defecto, arrepentimiento, cambio de modelo.
//
// Efectos:
//   1. Crea proveedor_movimiento tipo='devolucion' con monto_usd = SUM(costos)
//      → saldoProveedor.js ya cuenta este tipo con signo negativo, así que
//        automáticamente reduce lo que le debemos al proveedor.
//   2. INSERT proveedor_movimiento_items con snapshot de cada producto
//      (nombre, imei, valor) — mismo pattern que las compras.
//   3. Soft-delete de los productos (deleted_at=NOW(), oculto=true).
//      El proveedor_movimiento_id del producto se mantiene para trazabilidad
//      histórica (podés ver de qué compra vino cada producto devuelto).
//   4. Audit log del movimiento.
//   5. Invalida caché de inventario (productos ya no aparecen en Inventario)
//      y de cuentas de proveedor.
//
// Constraints v1:
//   - Todos los productos deben estar con estado='disponible' + no soft-deleted
//     + cantidad > 0. Un producto ya vendido no se puede devolver (no lo
//     tenemos físicamente).
//   - Todos los productos deben ser owned por este proveedor (traceable via
//     productos.proveedor_movimiento_id → proveedor_movimientos.proveedor_id).
//     Evita devolver a proveedor X algo comprado a proveedor Y por error.
//   - Solo productos con costo_moneda='USD'. Simplifica la suma sin ambigüedad
//     de TC. Casos ARS/UYU se rechazan con mensaje claro y se resuelven en v2.
//
// Idempotency: header `Idempotency-Key` UUID. Si se recibe 2 requests con la
// misma key, el 2do devuelve el movimiento del 1ro sin re-ejecutar (evita
// devolver el mismo producto 2 veces por retry del cliente).
//
// Cache: usa `.catch()` post-COMMIT igual que el resto del router (fire-and-
// forget, no bloquea la respuesta si Redis está caído).
router.post('/:id(\\d+)/devoluciones',
  compraMovimientoLimiter,
  validate(createDevolucionMercaderiaProveedorSchema),
  async (req, res, next) => {
    const idem = parseIdempotencyKey(req);
    if (idem.error) {
      return res.status(400).json({ error: idem.error, reason: 'idempotency_key_invalid' });
    }

    const proveedorId = parseId(req.params.id);
    if (!proveedorId) return res.status(400).json({ error: 'ID de proveedor inválido' });

    const { fecha, motivo, motivo_detalle, producto_ids } = req.body;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_tenant', $1::text, true)`,
        [String(req.tenantId)]
      );

      // Idempotency replay: si ya se procesó este key, devolver el mov original.
      if (idem.key) {
        const existing = await findExistingByIdempotencyKey(client, 'proveedor_movimientos', idem.key);
        if (existing) {
          await client.query('ROLLBACK');
          return res.status(200).json({ ...existing, idempotent_replay: true });
        }
      }

      // 1. Validar proveedor existe + no eliminado (FOR UPDATE lockea la fila
      //    para que updates concurrentes no cambien el nombre/data usada acá).
      const prov = await client.query(
        `SELECT id, nombre FROM proveedores WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [proveedorId]
      );
      if (!prov.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Proveedor no encontrado', reason: 'proveedor_not_found' });
      }

      // 2. SELECT productos con FOR UPDATE — validar en una sola query:
      //    - existen
      //    - no soft-deleted
      //    - estado = 'disponible'
      //    - cantidad > 0
      //    - JOIN con proveedor_movimientos para verificar owned por este proveedor
      //
      //    Retornamos costo/costo_moneda/nombre/imei para el snapshot + suma.
      const { rows: productos } = await client.query(
        `SELECT p.id, p.nombre, p.imei, p.costo, p.costo_moneda,
                p.proveedor_movimiento_id,
                pm.proveedor_id AS pm_proveedor_id
           FROM productos p
      LEFT JOIN proveedor_movimientos pm ON pm.id = p.proveedor_movimiento_id
          WHERE p.id = ANY($1::int[])
            AND p.deleted_at IS NULL
            AND p.estado = 'disponible'
            AND p.cantidad > 0
       ORDER BY p.id
            FOR UPDATE OF p`,
        [producto_ids]
      );

      // 2.a. Detectar productos NO elegibles (no existen o ya vendidos/eliminados).
      const foundIds = new Set(productos.map((r) => r.id));
      const invalidIds = producto_ids.filter((id) => !foundIds.has(id));
      if (invalidIds.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error:
            `${invalidIds.length} producto(s) no elegible(s) para devolución. ` +
            `Deben estar disponibles (no vendidos, no eliminados). IDs: ${invalidIds.join(', ')}`,
          reason: 'productos_no_elegibles',
          invalid_ids: invalidIds,
        });
      }

      // 2.b. Detectar productos que NO fueron comprados a este proveedor.
      //      Usamos el snapshot proveedor_movimiento_id → proveedor_movimientos.proveedor_id.
      //      Un producto sin proveedor_movimiento_id (ej. canje, seed manual)
      //      NO es elegible — no se puede rastrear a una compra a este proveedor.
      const wrongProvIds = productos
        .filter((p) => p.pm_proveedor_id !== proveedorId)
        .map((p) => p.id);
      if (wrongProvIds.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error:
            `${wrongProvIds.length} producto(s) no fueron comprados a este proveedor ` +
            `(o no tienen origen rastreable). IDs: ${wrongProvIds.join(', ')}`,
          reason: 'productos_wrong_proveedor',
          invalid_ids: wrongProvIds,
        });
      }

      // 2.c. V1 constraint: rechazar productos con costo_moneda != 'USD'.
      //      Devolvemos deuda en USD (equivalente contable) — sin conversión
      //      inambigua no podemos sumar montos de monedas mixtas.
      const nonUsdIds = productos
        .filter((p) => (p.costo_moneda || 'USD') !== 'USD')
        .map((p) => p.id);
      if (nonUsdIds.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error:
            `${nonUsdIds.length} producto(s) tienen costo en moneda distinta a USD. ` +
            `Devolución v1 solo soporta USD. IDs: ${nonUsdIds.join(', ')}`,
          reason: 'productos_moneda_no_usd',
          invalid_ids: nonUsdIds,
        });
      }

      // 3. Calcular monto total USD (suma de costos — todos ya son USD por 2.c).
      const monto_usd = round2(
        productos.reduce((sum, p) => sum + Number(p.costo || 0), 0)
      );

      // 4. Motivo labels para descripción legible en UI/reportes.
      const MOTIVO_LABELS = {
        error_proveedor:  'Error del proveedor',
        defecto:          'Defecto',
        arrepentimiento:  'Arrepentimiento',
        cambio_modelo:    'Cambio de modelo',
        otro:             'Otro',
      };
      const descripcion =
        `Devolución mercadería · ${MOTIVO_LABELS[motivo]} · ${productos.length} producto(s)`;

      // 5. INSERT proveedor_movimiento tipo='devolucion' (moneda=USD, tc=null
      //    porque es nativo USD, monto=monto_usd sin conversión).
      const { rows: movRows } = await client.query(
        `INSERT INTO proveedor_movimientos
            (proveedor_id, fecha, tipo, descripcion, monto, moneda, monto_usd,
             notas, created_by_user_id, client_generated_id)
         VALUES ($1, $2, 'devolucion', $3, $4, 'USD', $5, $6, $7, $8)
         RETURNING *`,
        [
          proveedorId,
          fecha,
          descripcion,
          monto_usd,
          monto_usd,
          motivo_detalle ?? null,
          req.user.id,
          idem.key,
        ]
      );
      const mov = movRows[0];

      // 6. INSERT proveedor_movimiento_items (bulk UNNEST — mismo pattern que
      //    compras). Snapshot inmutable — si el producto se re-crea con el mismo
      //    IMEI mañana, el registro histórico sigue intacto.
      await client.query(
        `INSERT INTO proveedor_movimiento_items
            (proveedor_movimiento_id, producto, imei_serial, valor, notas)
         SELECT $1, p, i, v, n
           FROM UNNEST($2::text[], $3::text[], $4::numeric[], $5::text[])
                AS u(p, i, v, n)`,
        [
          mov.id,
          productos.map((p) => p.nombre ?? null),
          productos.map((p) => p.imei ?? null),
          productos.map((p) => Number(p.costo || 0)),
          productos.map(() => `Devuelto · motivo: ${motivo}`),
        ]
      );

      // 7. Soft-delete de los productos. `oculto=true` los quita de listados
      //    default; `deleted_at=NOW()` los excluye de todos los queries de
      //    inventario. Mantenemos `proveedor_movimiento_id` para trazabilidad
      //    (podés ver qué productos originalmente vinieron de una compra dada
      //    y cuáles se devolvieron después).
      await client.query(
        `UPDATE productos
            SET deleted_at = NOW(),
                oculto = true
          WHERE id = ANY($1::int[])`,
        [producto_ids]
      );

      // 8. Audit log — firma canónica: audit(client, tabla, accion, registro_id, opts).
      //    (Hotfix Sentry 2026-07-28: la llamada anterior pasaba `req` como
      //    `tabla` y un objeto como `accion`, lo que hacía que PG intentara
      //    serializar el Socket circular → TypeError. Ver Sentry #20.)
      //
      //    Hotfix Sentry 2026-07-29 (regression latente desde PR #236 merge):
      //    `accion` DEBE ser uno de INSERT|UPDATE|DELETE|LOGIN|LOGIN_FAILED|
      //    LOCKOUT|LOGOUT|PASSWORD_RESET_REQUESTED (CHECK constraint
      //    `audit_logs_accion_check`). El semantic name
      //    "devolucion_mercaderia_proveedor" va al JSON `despues.accion_negocio`
      //    para trazabilidad, no como columna `accion`. Sin este fix la
      //    violation del CHECK rompía toda la request → user recibía 500 y
      //    la devolución no persistía (feature #236 quebrada desde el merge,
      //    ~2 semanas).
      await audit(client, 'proveedor_movimientos', 'INSERT', String(mov.id), {
        req,
        user_id: req.user.id,
        despues: {
          accion_negocio: 'devolucion_mercaderia_proveedor',
          proveedor_id: proveedorId,
          proveedor_nombre: prov.rows[0].nombre,
          motivo,
          motivo_detalle: motivo_detalle || null,
          monto_usd,
          productos_devueltos: productos.length,
          producto_ids,
        },
      });

      await client.query('COMMIT');

      // 9. Invalidate caches post-COMMIT. Fire-and-forget (no rompemos response
      //    si Redis está caído — el next boot los levantará frescos).
      invalidateMetricas(req.tenantId).catch((err) =>
        require('../lib/logger').warn(
          { err: err.message, tenantId: req.tenantId },
          '[proveedores.devoluciones] invalidateMetricas post-COMMIT falló'
        )
      );

      return res.status(201).json({
        movimiento: mov,
        productos_devueltos: productos.length,
        monto_total_usd: monto_usd,
      });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* swallow */ }
      if (isIdempotencyConflict(err)) {
        return res.status(409).json({
          error: 'Otro request con la misma Idempotency-Key está en curso. Reintentá en un instante.',
          reason: 'idempotency_conflict',
        });
      }
      return next(err);
    } finally {
      client.release();
    }
  }
);

module.exports = router;
