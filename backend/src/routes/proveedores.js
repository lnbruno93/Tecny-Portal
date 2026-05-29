// Módulo Proveedores — cuentas por pagar. Alta de proveedores + cuenta corriente
// (compras que les debemos y pagos que les hicimos). Montos normalizados a USD.
// Montado en /api/proveedores con requireAuth + requirePermission('proveedores') (app.js).
const rateLimit = require('express-rate-limit');
const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { toUsd, round2 } = require('../lib/money');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { syncContactoSafe } = require('../lib/contactosSync');
const {
  createProveedorSchema, updateProveedorSchema, createMovimientoProveedorSchema,
} = require('../schemas/proveedores');

// Rate-limit dedicado para POST /movimientos (auditoría #H-07): cuando una
// compra trae producto_stock, hace hasta 200 INSERTs productos + IMEI locks
// + audit. Sin tope dedicado, un script puede agotar conexiones del pool en
// minutos. 30 lotes / 15 min por user es generoso para uso humano.
const compraMovimientoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `prov-mov:${req.user?.id || req.ip}`,
  message: { error: 'Demasiadas compras a proveedor en poco tiempo. Probá en unos minutos.' },
});

// ─── PROVEEDORES ────────────────────────────────────────────

// Lista con saldo (lo que les debemos) en USD
router.get('/', async (req, res, next) => {
  try {
    const { buscar } = req.query;
    const params = [];
    let where = 'WHERE p.deleted_at IS NULL';
    if (buscar) { params.push(`%${buscar}%`); where += ` AND p.nombre ILIKE $${params.length}`; }

    // Cálculo de saldo (lo que les debemos):
    //   - 'pago'    : resta (les pagamos)
    //   - 'compra' con caja_id → contado, no genera deuda (se descuenta al instante)
    //   - 'compra' sin caja_id → a crédito, suma como deuda
    //   - 'saldo_inicial'      → suma (deuda heredada)
    const { rows } = await db.query(
      `SELECT p.id, p.nombre, p.contacto_nombre, p.contacto_apellido, p.whatsapp, p.ubicacion, p.notas,
              COALESCE(SUM(
                CASE
                  WHEN m.tipo='pago'                                  THEN -m.monto_usd
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
        ORDER BY p.nombre`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'SELECT * FROM proveedores WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.post('/', validate(createProveedorSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { nombre, contacto_nombre, contacto_apellido, whatsapp, ubicacion, notas, saldo_inicial } = req.body;
    await client.query('BEGIN');
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
    // Agenda central (best-effort, fuera de la transacción)
    await syncContactoSafe(db, {
      origen: 'proveedores', ref_tabla: 'proveedores', ref_id: prov.id,
      nombre: prov.contacto_nombre || prov.nombre, apellido: prov.contacto_apellido, telefono: prov.whatsapp,
    });
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
    // Agenda central (best-effort, fuera de la transacción)
    await syncContactoSafe(db, {
      origen: 'proveedores', ref_tabla: 'proveedores', ref_id: rows[0].id,
      nombre: rows[0].contacto_nombre || rows[0].nombre, apellido: rows[0].contacto_apellido, telefono: rows[0].whatsapp,
    });
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
    const { rows } = await db.query(
      'UPDATE proveedores SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proveedor no encontrado' });
    await audit('proveedores', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── MOVIMIENTOS (compras y pagos) ──────────────────────────

router.get('/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    const [countRes, dataRes] = await Promise.all([
      db.query('SELECT COUNT(*) FROM proveedor_movimientos WHERE proveedor_id = $1 AND deleted_at IS NULL', [id]),
      db.query(
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
      ),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

// Registro de compra/pago — igual al flujo B2B: una COMPRA carga ítems (productos
// comprados); un PAGO no. Transaccional (movimiento + ítems atómicos).
router.post('/movimientos', compraMovimientoLimiter, validate(createMovimientoProveedorSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, caja_id, notas, items = [] } = req.body;

    // #H-05 cross-module: si la compra crea productos en Inventario, exigir
    // también permiso `inventario` (no alcanza con solo `proveedores`).
    // Evita que un user al que se le quitó `inventario` siga creando stock
    // por la puerta de atrás.
    const creaStock = tipo === 'compra' && items.some(it => it.producto_stock);
    if (creaStock) {
      const { hasPermission } = require('../middleware/requirePermission');
      const ok = await hasPermission(req.user, 'inventario');
      if (!ok) {
        return res.status(403).json({
          error: 'Para registrar una compra que crea productos necesitás también permiso de Inventario.',
        });
      }
    }

    await client.query('BEGIN');
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
      `INSERT INTO proveedor_movimientos (proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, monto_usd, caja_id, notas, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [proveedor_id, fecha, tipo, descripcion ?? null, monto, moneda, tc ?? null, monto_usd, caja_id ?? null, notas ?? null, req.user.id]
    );
    const mov = rows[0];

    // Ítems solo en compras (los pagos no llevan productos)
    const insertedItems = [];
    const productosCreados = [];
    if (tipo === 'compra' && items.length > 0) {
      // Columnas del producto que persistimos al crear stock desde compra. Es
      // el mismo set que /api/inventario/productos POST (sin foto).
      const STOCK_COLS = [
        'tipo_carga', 'clase', 'nombre', 'imei', 'gb', 'color', 'bateria',
        'categoria_id', 'deposito_id', 'proveedor', 'costo', 'costo_moneda',
        'precio_venta', 'precio_moneda', 'trackear_stock', 'cantidad', 'estado',
        'observaciones', 'condicion', 'oculto',
        // Link al movimiento de origen (auditoría #B-02): permite borrar
        // productos en cascada cuando se borra la compra que los creó.
        'proveedor_movimiento_id',
      ];
      for (const it of items) {
        // 1) Log del item (siempre)
        const { rows: ir } = await client.query(
          `INSERT INTO proveedor_movimiento_items (proveedor_movimiento_id, producto, modelo, tamano, color, imei_serial, valor, verificado, notas)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [mov.id, it.producto ?? null, it.modelo ?? null, it.tamano ?? null, it.color ?? null,
           it.imei_serial ?? null, it.valor ?? null, it.verificado ?? false, it.notas ?? null]
        );
        insertedItems.push(ir[0]);

        // 2) Si vino producto_stock → crear el producto en Inventario.
        //    Auto-fill: proveedor = nombre del proveedor de la compra
        //    (se puede pisar si el cliente lo manda explícito).
        if (it.producto_stock) {
          const ps = {
            ...it.producto_stock,
            // #H-06: forzar nombre del proveedor (no aceptar override del
            // cliente). Antes `it.producto_stock.proveedor || prov.nombre`
            // permitía impersonar otro proveedor en reportes y desglose por
            // proveedor.
            proveedor:  prov.rows[0].nombre,
            condicion:  it.producto_stock.condicion ?? 'nuevo',
            oculto:     it.producto_stock.oculto    ?? false,
            // Link al movimiento de compra para borrado en cascada (#B-02)
            proveedor_movimiento_id: mov.id,
          };
          const values = STOCK_COLS.map(c => ps[c] ?? null);
          const placeholders = STOCK_COLS.map((_, i) => `$${i + 1}`).join(',');
          const { rows: pr } = await client.query(
            `INSERT INTO productos (${STOCK_COLS.join(',')}) VALUES (${placeholders}) RETURNING *`,
            values
          );
          productosCreados.push(pr[0]);
          // Audit del producto para que aparezca en su propio historial.
          await audit(client, 'productos', 'INSERT', pr[0].id,
            { despues: { ...pr[0], _origen: 'compra_proveedor', proveedor_movimiento_id: mov.id },
              user_id: req.user.id });
        }
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
    res.status(201).json({ ...mov, items: insertedItems, productos_creados: productosCreados });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/movimientos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Ownership check (auditoría #B-07)
    const { rows: pre } = await client.query(
      'SELECT id, created_by_user_id FROM proveedor_movimientos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id]
    );
    if (!pre[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    if (pre[0].created_by_user_id !== req.user.id && req.user.role !== 'admin') {
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
    const { rows: prods } = await client.query(
      `SELECT id, nombre, estado FROM productos
         WHERE proveedor_movimiento_id = $1 AND deleted_at IS NULL FOR UPDATE`,
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
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ─── RESUMEN (saldos por proveedor) ─────────────────────────

router.get('/resumen/saldos', async (_req, res, next) => {
  try {
    // Misma regla que el listado: compras con caja_id son contado, no deuda.
    const SALDO_EXPR = `
      CASE
        WHEN m.tipo='pago'                              THEN -m.monto_usd
        WHEN m.tipo='compra' AND m.caja_id IS NOT NULL  THEN 0
        ELSE m.monto_usd
      END
    `;
    const { rows } = await db.query(
      `SELECT p.id, p.nombre,
              COALESCE(SUM(${SALDO_EXPR}), 0) AS saldo_usd
         FROM proveedores p
         LEFT JOIN proveedor_movimientos m ON m.proveedor_id = p.id AND m.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
        GROUP BY p.id
       HAVING COALESCE(SUM(${SALDO_EXPR}), 0) <> 0
        ORDER BY saldo_usd DESC`
    );
    const total_deuda_usd = round2(rows.reduce((s, r) => s + Number(r.saldo_usd), 0));
    res.json({ proveedores: rows, total_deuda_usd });
  } catch (err) { next(err); }
});

module.exports = router;
