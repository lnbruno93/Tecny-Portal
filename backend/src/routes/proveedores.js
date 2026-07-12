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
  createProveedorSchema, updateProveedorSchema, createMovimientoProveedorSchema,
  bulkCreateMovimientosProveedorSchema, nombresBulkProveedoresSchema,
} = require('../schemas/proveedores');

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

    // Cálculo de saldo (lo que les debemos):
    //   - 'pago'    : resta (les pagamos)
    //   - 'compra' con caja_id → contado, no genera deuda (se descuenta al instante)
    //   - 'compra' sin caja_id → a crédito, suma como deuda
    //   - 'saldo_inicial'      → suma (deuda heredada)
    //
    // 2026-06-15 multi-tenant (PR 4.4): count + data en una sola withTenant
    // → comparten SET LOCAL. RLS filtra proveedores y proveedor_movimientos.
    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(`SELECT COUNT(*) FROM proveedores p ${where}`, params);
      const dataRes = await client.query(
        `SELECT p.id, p.nombre, p.contacto_nombre, p.contacto_apellido, p.whatsapp, p.ubicacion, p.notas,
                COALESCE(SUM(
                  CASE
                    WHEN m.tipo='pago'                                  THEN -m.monto_usd
                    -- COR-2 audit 2026-07-06: devolución cross-tenant baja
                    -- la deuda al proveedor (equivalente contable a pago).
                    WHEN m.tipo='devolucion'                            THEN -m.monto_usd
                    WHEN m.tipo='compra' AND m.caja_id IS NOT NULL      THEN 0
                    ELSE m.monto_usd
                  END
                ), 0) AS saldo_usd,
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
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
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
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
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
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
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
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

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
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

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
    invalidateMetricas(req.tenantId).catch(() => {});
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
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

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
    invalidateMetricas(req.tenantId).catch(() => {});
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
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
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
    invalidateMetricas(req.tenantId).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ─── RESUMEN (saldos por proveedor) ─────────────────────────

router.get('/resumen/saldos', async (req, res, next) => {
  try {
    // Misma regla que el listado: compras con caja_id son contado, no deuda.
    // COR-2 audit 2026-07-06: 'devolucion' cross-tenant baja la deuda (= pago).
    const SALDO_EXPR = `
      CASE
        WHEN m.tipo='pago'                              THEN -m.monto_usd
        WHEN m.tipo='devolucion'                        THEN -m.monto_usd
        WHEN m.tipo='compra' AND m.caja_id IS NOT NULL  THEN 0
        ELSE m.monto_usd
      END
    `;
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT p.id, p.nombre,
                COALESCE(SUM(${SALDO_EXPR}), 0) AS saldo_usd
           FROM proveedores p
           LEFT JOIN proveedor_movimientos m ON m.proveedor_id = p.id AND m.deleted_at IS NULL
          WHERE p.deleted_at IS NULL
          GROUP BY p.id
         HAVING COALESCE(SUM(${SALDO_EXPR}), 0) <> 0
          ORDER BY saldo_usd DESC`
      );
      return rows;
    });
    const total_deuda_usd = round2(rows.reduce((s, r) => s + Number(r.saldo_usd), 0));
    res.json({ proveedores: rows, total_deuda_usd });
  } catch (err) { next(err); }
});

module.exports = router;
