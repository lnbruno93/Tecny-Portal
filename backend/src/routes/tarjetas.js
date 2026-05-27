// Módulo Tarjetas de Crédito (solo lectura + liquidaciones).
// La "tarjeta" es un método de pago marcado como tal en Cajas (es_tarjeta, con su
// comision_pct). Los cobros se generan SOLOS desde Ventas (lib/tarjetas.js):
// bruto → comisión de la financiera → neto que nos deben. Acá se ve el saldo
// pendiente por método y se registra la liquidación (cuando nos pagan → entra a
// una caja real y baja el saldo). No se configura nada en esta pantalla.
// Montado en /api/tarjetas con requireAuth + requirePermission('tarjetas') (app.js).
const router   = require('express').Router();
const db       = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const { round2 } = require('../lib/money');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { createLiquidacionSchema } = require('../schemas/tarjetas');

// Saldo pendiente de un método = neto cobrado − neto liquidado (lo que falta cobrar).
const RESUMEN_SQL = `
  COALESCE(SUM(CASE WHEN m.tipo='cobro'       THEN m.monto_neto ELSE 0 END),0)
  - COALESCE(SUM(CASE WHEN m.tipo='liquidacion' THEN m.monto_neto ELSE 0 END),0) AS saldo,
  COALESCE(SUM(CASE WHEN m.tipo='cobro' THEN m.monto_comision ELSE 0 END),0) AS comision_total,
  COALESCE(SUM(CASE WHEN m.tipo='cobro' THEN m.monto_bruto ELSE 0 END),0) AS bruto_total,
  COUNT(m.id) AS movimientos`;

// Lista de tarjetas = métodos de pago marcados como tarjeta, con su saldo pendiente.
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT mp.id, mp.nombre, mp.moneda, mp.comision_pct, mp.activo, ${RESUMEN_SQL}
         FROM metodos_pago mp
         LEFT JOIN tarjeta_movimientos m ON m.metodo_pago_id = mp.id AND m.deleted_at IS NULL
        WHERE mp.es_tarjeta = true AND mp.deleted_at IS NULL
        GROUP BY mp.id
        ORDER BY mp.nombre`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows: mp } = await db.query(
      'SELECT id, nombre, moneda, comision_pct, activo FROM metodos_pago WHERE id = $1 AND es_tarjeta = true AND deleted_at IS NULL', [id]
    );
    if (!mp[0]) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    const { rows: tot } = await db.query(
      `SELECT ${RESUMEN_SQL} FROM tarjeta_movimientos m WHERE m.metodo_pago_id = $1 AND m.deleted_at IS NULL`, [id]
    );
    res.json({ ...mp[0], resumen: tot[0] });
  } catch (err) { next(err); }
});

router.get('/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      `SELECT m.*, mp.nombre AS caja_nombre, v.order_id AS venta_order_id
         FROM tarjeta_movimientos m
         LEFT JOIN metodos_pago mp ON mp.id = m.caja_id
         LEFT JOIN ventas v ON v.id = m.venta_id
        WHERE m.metodo_pago_id = $1 AND m.deleted_at IS NULL
        ORDER BY m.fecha DESC, m.id DESC`, [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Liquidación: nos depositan el neto → ingreso a una caja real (origen 'tarjeta').
router.post('/liquidaciones', validate(createLiquidacionSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { metodo_pago_id, fecha, monto, caja_id, comentarios } = req.body;
    await client.query('BEGIN');
    const mp = await client.query('SELECT moneda FROM metodos_pago WHERE id = $1 AND es_tarjeta = true AND deleted_at IS NULL', [metodo_pago_id]);
    if (!mp.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Tarjeta no encontrada' }); }
    const caja = await client.query('SELECT moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [caja_id]);
    if (!caja.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'La caja seleccionada no existe.' }); }
    const moneda = caja.rows[0].moneda;
    const m = round2(Number(monto));
    const { rows } = await client.query(
      `INSERT INTO tarjeta_movimientos (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, caja_id, comentarios, user_id)
       VALUES ($1,$2,'liquidacion',$3,$4,0,0,$4,$5,$6,$7) RETURNING *`,
      [metodo_pago_id, fecha, moneda, m, caja_id, comentarios ?? null, req.user.id]
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
