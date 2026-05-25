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
              COALESCE(SUM(CASE WHEN m.tipo='compra' THEN m.monto_usd ELSE -m.monto_usd END), 0) AS saldo_usd,
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
  try {
    const { nombre, contacto_nombre, contacto_apellido, whatsapp, ubicacion, notas } = req.body;
    const { rows } = await db.query(
      `INSERT INTO proveedores (nombre, contacto_nombre, contacto_apellido, whatsapp, ubicacion, notas)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nombre, contacto_nombre ?? null, contacto_apellido ?? null, whatsapp ?? null, ubicacion ?? null, notas ?? null]
    );
    await audit('proveedores', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
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
      `SELECT m.*, mp.nombre AS caja_nombre
         FROM proveedor_movimientos m
         LEFT JOIN metodos_pago mp ON mp.id = m.caja_id
        WHERE m.proveedor_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.fecha DESC, m.id DESC`,
      [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/movimientos', validate(createMovimientoProveedorSchema), async (req, res, next) => {
  try {
    const { proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, caja_id, notas } = req.body;
    const prov = await db.query('SELECT id FROM proveedores WHERE id = $1 AND deleted_at IS NULL', [proveedor_id]);
    if (!prov.rows[0]) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const monto_usd = round2(toUsd(monto, moneda, tc));
    const { rows } = await db.query(
      `INSERT INTO proveedor_movimientos (proveedor_id, fecha, tipo, descripcion, monto, moneda, tc, monto_usd, caja_id, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [proveedor_id, fecha, tipo, descripcion ?? null, monto, moneda, tc ?? null, monto_usd, caja_id ?? null, notas ?? null]
    );
    await audit('proveedor_movimientos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
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
              COALESCE(SUM(CASE WHEN m.tipo='compra' THEN m.monto_usd ELSE -m.monto_usd END), 0) AS saldo_usd
         FROM proveedores p
         LEFT JOIN proveedor_movimientos m ON m.proveedor_id = p.id AND m.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
        GROUP BY p.id
       HAVING COALESCE(SUM(CASE WHEN m.tipo='compra' THEN m.monto_usd ELSE -m.monto_usd END), 0) <> 0
        ORDER BY saldo_usd DESC`
    );
    const total_deuda_usd = round2(rows.reduce((s, r) => s + Number(r.saldo_usd), 0));
    res.json({ proveedores: rows, total_deuda_usd });
  } catch (err) { next(err); }
});

module.exports = router;
