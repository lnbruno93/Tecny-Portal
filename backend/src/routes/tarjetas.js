// Módulo Tarjetas de Crédito — cuenta corriente con tarjetas/procesadores.
// Cobro: bruto → comisión → neto pendiente (no toca caja). Liquidación: el
// procesador deposita el neto → ingreso a una caja (ledger origen 'tarjeta').
// Los cobros también se generan solos desde Ventas (lib/tarjetas.js).
// Montado en /api/tarjetas con requireAuth + requirePermission('tarjetas') (app.js).
const router   = require('express').Router();
const db       = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const { round2 } = require('../lib/money');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const {
  createEntidadSchema, updateEntidadSchema, createPlanSchema, updatePlanSchema,
  createCobroSchema, createLiquidacionSchema,
} = require('../schemas/tarjetas');

// Saldo pendiente por moneda: neto de cobros − neto de liquidaciones (lo que falta cobrar).
const saldoExpr = (moneda) => `
  COALESCE(SUM(CASE WHEN m.moneda ${moneda} AND m.tipo='cobro'       THEN m.monto_neto ELSE 0 END),0)
- COALESCE(SUM(CASE WHEN m.moneda ${moneda} AND m.tipo='liquidacion' THEN m.monto_neto ELSE 0 END),0)`;
const RESUMEN_SQL = `
  ${saldoExpr("= 'ARS'")} AS saldo_ars,
  ${saldoExpr("IN ('USD','USDT')")} AS saldo_usd,
  COALESCE(SUM(CASE WHEN m.tipo='cobro' THEN m.monto_comision ELSE 0 END),0) AS comision_total,
  COUNT(m.id) AS movimientos`;

// ─── ENTIDADES ───────────────────────────────────────────────────────────────
router.get('/entidades', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT e.*, ${RESUMEN_SQL}
         FROM tarjeta_entidades e
         LEFT JOIN tarjeta_movimientos m ON m.entidad_id = e.id AND m.deleted_at IS NULL
        WHERE e.deleted_at IS NULL GROUP BY e.id ORDER BY e.nombre`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/entidades/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows: e } = await db.query('SELECT * FROM tarjeta_entidades WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!e[0]) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    const [{ rows: planes }, { rows: tot }] = await Promise.all([
      db.query('SELECT * FROM tarjeta_planes WHERE entidad_id = $1 AND deleted_at IS NULL ORDER BY pct, nombre', [id]),
      db.query(`SELECT ${RESUMEN_SQL} FROM tarjeta_movimientos m WHERE m.entidad_id = $1 AND m.deleted_at IS NULL`, [id]),
    ]);
    res.json({ ...e[0], planes, resumen: tot[0] });
  } catch (err) { next(err); }
});

router.post('/entidades', validate(createEntidadSchema), async (req, res, next) => {
  try {
    const { nombre, activo } = req.body;
    const { rows } = await db.query('INSERT INTO tarjeta_entidades (nombre, activo) VALUES ($1,$2) RETURNING *', [nombre, activo]);
    await audit('tarjeta_entidades', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json({ ...rows[0], saldo_ars: 0, saldo_usd: 0, comision_total: 0, movimientos: 0 });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una tarjeta con ese nombre' });
    next(err);
  }
});

router.put('/entidades/:id', validate(updateEntidadSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { nombre, activo } = req.body;
    const { rows } = await db.query(
      'UPDATE tarjeta_entidades SET nombre = COALESCE($1, nombre), activo = COALESCE($2, activo) WHERE id = $3 AND deleted_at IS NULL RETURNING *',
      [nombre ?? null, activo ?? null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    await audit('tarjeta_entidades', 'UPDATE', id, { despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una tarjeta con ese nombre' });
    next(err);
  }
});

router.delete('/entidades/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query('UPDATE tarjeta_entidades SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    await audit('tarjeta_entidades', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── PLANES (comisiones) ─────────────────────────────────────────────────────
router.post('/planes', validate(createPlanSchema), async (req, res, next) => {
  try {
    const { entidad_id, nombre, pct, activo } = req.body;
    const ent = await db.query('SELECT id FROM tarjeta_entidades WHERE id = $1 AND deleted_at IS NULL', [entidad_id]);
    if (!ent.rows[0]) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    const { rows } = await db.query(
      'INSERT INTO tarjeta_planes (entidad_id, nombre, pct, activo) VALUES ($1,$2,$3,$4) RETURNING *',
      [entidad_id, nombre, pct, activo]
    );
    await audit('tarjeta_planes', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/planes/:id', validate(updatePlanSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { nombre, pct, activo } = req.body;
    const { rows } = await db.query(
      'UPDATE tarjeta_planes SET nombre = COALESCE($1, nombre), pct = COALESCE($2, pct), activo = COALESCE($3, activo) WHERE id = $4 AND deleted_at IS NULL RETURNING *',
      [nombre ?? null, pct ?? null, activo ?? null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Plan no encontrado' });
    await audit('tarjeta_planes', 'UPDATE', id, { despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/planes/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query('UPDATE tarjeta_planes SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Plan no encontrado' });
    await audit('tarjeta_planes', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── MOVIMIENTOS ─────────────────────────────────────────────────────────────
router.get('/entidades/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      `SELECT m.*, p.nombre AS plan_nombre, mp.nombre AS caja_nombre, v.order_id AS venta_order_id
         FROM tarjeta_movimientos m
         LEFT JOIN tarjeta_planes p ON p.id = m.plan_id
         LEFT JOIN metodos_pago mp ON mp.id = m.caja_id
         LEFT JOIN ventas v ON v.id = m.venta_id
        WHERE m.entidad_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.fecha DESC, m.id DESC`, [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Cobro manual
router.post('/cobros', validate(createCobroSchema), async (req, res, next) => {
  try {
    const { entidad_id, plan_id, fecha, moneda, monto_bruto, pct, comentarios } = req.body;
    const ent = await db.query('SELECT id FROM tarjeta_entidades WHERE id = $1 AND deleted_at IS NULL', [entidad_id]);
    if (!ent.rows[0]) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    // pct: override explícito, o el del plan, o 0
    let usePct = pct;
    if ((usePct === undefined || usePct === null) && plan_id) {
      const pl = await db.query('SELECT pct FROM tarjeta_planes WHERE id = $1 AND deleted_at IS NULL', [plan_id]);
      usePct = pl.rows[0] ? Number(pl.rows[0].pct) : 0;
    }
    usePct = Number(usePct || 0);
    const bruto = round2(Number(monto_bruto));
    const comision = round2(bruto * usePct / 100);
    const neto = round2(bruto - comision);
    const { rows } = await db.query(
      `INSERT INTO tarjeta_movimientos (entidad_id, plan_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, comentarios, user_id)
       VALUES ($1,$2,$3,'cobro',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [entidad_id, plan_id ?? null, fecha, moneda, bruto, usePct, comision, neto, comentarios ?? null, req.user.id]
    );
    await audit('tarjeta_movimientos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// Liquidación → ingreso a una caja
router.post('/liquidaciones', validate(createLiquidacionSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { entidad_id, fecha, monto, caja_id, comentarios } = req.body;
    await client.query('BEGIN');
    const ent = await client.query('SELECT id FROM tarjeta_entidades WHERE id = $1 AND deleted_at IS NULL', [entidad_id]);
    if (!ent.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tarjeta no encontrada' }); }
    const caja = await client.query('SELECT moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [caja_id]);
    if (!caja.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La caja seleccionada no existe.' }); }
    const moneda = caja.rows[0].moneda;
    const m = round2(Number(monto));
    const { rows } = await client.query(
      `INSERT INTO tarjeta_movimientos (entidad_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, caja_id, comentarios, user_id)
       VALUES ($1,$2,'liquidacion',$3,$4,0,0,$4,$5,$6,$7) RETURNING *`,
      [entidad_id, fecha, moneda, m, caja_id, comentarios ?? null, req.user.id]
    );
    await postCajaMovimiento(client, {
      caja_id, fecha, tipo: 'ingreso', monto: m, moneda, tc: null,
      origen: 'tarjeta', ref_tabla: 'tarjeta_movimientos', ref_id: rows[0].id,
      concepto: 'Liquidación tarjeta', user_id: req.user.id,
    });
    await client.query('COMMIT');
    await audit('tarjeta_movimientos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
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
    const { rows } = await client.query('UPDATE tarjeta_movimientos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    await reverseCajaMovimientos(client, 'tarjeta_movimientos', id); // revierte la caja si era una liquidación
    await client.query('COMMIT');
    await audit('tarjeta_movimientos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;
