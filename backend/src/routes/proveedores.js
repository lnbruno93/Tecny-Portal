// Módulo Proveedores — cuentas por pagar. Alta de proveedores + cuenta corriente
// (compras que les debemos y pagos que les hicimos). Montos normalizados a USD.
// Montado en /api/proveedores con requireAuth + requirePermission('proveedores') (app.js).
const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { toUsd, round2 } = require('../lib/money');
const {
  createProveedorSchema, updateProveedorSchema, createMovimientoProveedorSchema,
} = require('../schemas/proveedores');

// ─── PROVEEDORES ────────────────────────────────────────────

// Lista con saldo (lo que les debemos) en USD
router.get('/', async (req, res, next) => {
  try {
    const { buscar } = req.query;
    const params = [];
    let where = 'WHERE p.deleted_at IS NULL';
    if (buscar) { params.push(`%${buscar}%`); where += ` AND p.nombre ILIKE $${params.length}`; }

    const { rows } = await db.query(
      `SELECT p.id, p.nombre, p.contacto_nombre, p.contacto_apellido, p.whatsapp, p.ubicacion, p.notas,
              COALESCE(SUM(CASE WHEN m.tipo='pago' THEN -m.monto_usd ELSE m.monto_usd END), 0) AS saldo_usd,
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

    await client.query('COMMIT');
    await audit('proveedores', 'INSERT', prov.id, { despues: { ...prov, saldo_inicial: ini }, user_id: req.user.id });
    res.status(201).json({ ...prov, saldo_usd: ini, movimientos: ini > 0 ? 1 : 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.put('/:id', validate(updateProveedorSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const before = await db.query('SELECT * FROM proveedores WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const { nombre, contacto_nombre, contacto_apellido, whatsapp, ubicacion, notas } = req.body;
    const { rows } = await db.query(
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
    await audit('proveedores', 'UPDATE', id, { antes: before.rows[0], despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
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
    const { rows } = await db.query(
      `SELECT m.*, mp.nombre AS caja_nombre,
              COALESCE(
                (SELECT json_agg(i.* ORDER BY i.id)
                   FROM proveedor_movimiento_items i
                  WHERE i.proveedor_movimiento_id = m.id), '[]'
              ) AS items
         FROM proveedor_movimientos m
         LEFT JOIN metodos_pago mp ON mp.id = m.caja_id
        WHERE m.proveedor_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.fecha DESC, m.id DESC`,
      [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Registro de compra/pago — igual al flujo B2B: una COMPRA carga ítems (productos
// comprados); un PAGO no. Transaccional (movimiento + ítems atómicos).
router.post('/movimientos', validate(createMovimientoProveedorSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, caja_id, notas, items = [] } = req.body;

    await client.query('BEGIN');
    const prov = await client.query('SELECT id FROM proveedores WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [proveedor_id]);
    if (!prov.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Proveedor no encontrado' }); }

    const monto_usd = round2(toUsd(monto, moneda, tc));
    const { rows } = await client.query(
      `INSERT INTO proveedor_movimientos (proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, monto_usd, caja_id, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [proveedor_id, fecha, tipo, descripcion ?? null, monto, moneda, tc ?? null, monto_usd, caja_id ?? null, notas ?? null]
    );
    const mov = rows[0];

    // Ítems solo en compras (los pagos no llevan productos)
    const insertedItems = [];
    if (tipo === 'compra' && items.length > 0) {
      for (const it of items) {
        const { rows: ir } = await client.query(
          `INSERT INTO proveedor_movimiento_items (proveedor_movimiento_id, producto, modelo, tamano, color, imei_serial, valor, verificado, notas)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [mov.id, it.producto ?? null, it.modelo ?? null, it.tamano ?? null, it.color ?? null,
           it.imei_serial ?? null, it.valor ?? null, it.verificado ?? false, it.notas ?? null]
        );
        insertedItems.push(ir[0]);
      }
    }

    await client.query('COMMIT');
    await audit('proveedor_movimientos', 'INSERT', mov.id, { despues: { ...mov, items: insertedItems }, user_id: req.user.id });
    res.status(201).json({ ...mov, items: insertedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/movimientos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE proveedor_movimientos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Movimiento no encontrado' });
    await audit('proveedor_movimientos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── RESUMEN (saldos por proveedor) ─────────────────────────

router.get('/resumen/saldos', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.id, p.nombre,
              COALESCE(SUM(CASE WHEN m.tipo='pago' THEN -m.monto_usd ELSE m.monto_usd END), 0) AS saldo_usd
         FROM proveedores p
         LEFT JOIN proveedor_movimientos m ON m.proveedor_id = p.id AND m.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
        GROUP BY p.id
       HAVING COALESCE(SUM(CASE WHEN m.tipo='pago' THEN -m.monto_usd ELSE m.monto_usd END), 0) <> 0
        ORDER BY saldo_usd DESC`
    );
    const total_deuda_usd = round2(rows.reduce((s, r) => s + Number(r.saldo_usd), 0));
    res.json({ proveedores: rows, total_deuda_usd });
  } catch (err) { next(err); }
});

module.exports = router;
