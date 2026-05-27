// Módulo Cambios de Divisa — cuenta corriente con financieras de cambio.
// Dos lados: 'entrega_ars' (les damos pesos, egreso de una caja ARS) y
// 'recibo_usd' (nos devuelven dólares, ingreso a una caja USD). El saldo en USD
// muestra lo que la financiera todavía nos debe. Integrado al ledger (origen 'cambio').
// Montado en /api/cambios con requireAuth + requirePermission('cambios') (app.js).
const router   = require('express').Router();
const db       = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { round2 } = require('../lib/money');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { createEntidadSchema, updateEntidadSchema, createMovimientoSchema } = require('../schemas/cambios');

// saldo_usd por entidad: lo entregado (USD equiv) menos lo recibido = lo que nos deben.
const SALDO_SQL = `
  COALESCE(SUM(CASE WHEN m.tipo = 'entrega_ars' THEN m.monto_usd ELSE -m.monto_usd END), 0)`;

// ─── ENTIDADES (financieras de cambio) ───────────────────────────────────────
router.get('/entidades', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT e.*,
              ${SALDO_SQL} AS saldo_usd,
              COALESCE(SUM(CASE WHEN m.tipo='entrega_ars' THEN m.monto_usd ELSE 0 END),0) AS entregado_usd,
              COALESCE(SUM(CASE WHEN m.tipo='recibo_usd'  THEN m.monto_usd ELSE 0 END),0) AS recibido_usd,
              COUNT(m.id) AS movimientos
         FROM cambio_entidades e
         LEFT JOIN cambio_movimientos m ON m.entidad_id = e.id AND m.deleted_at IS NULL
        WHERE e.deleted_at IS NULL
        GROUP BY e.id
        ORDER BY e.nombre`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/entidades/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows: e } = await db.query('SELECT * FROM cambio_entidades WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!e[0]) return res.status(404).json({ error: 'Financiera no encontrada' });
    const { rows: tot } = await db.query(
      `SELECT ${SALDO_SQL} AS saldo_usd,
              COALESCE(SUM(CASE WHEN m.tipo='entrega_ars' THEN m.monto_usd ELSE 0 END),0) AS entregado_usd,
              COALESCE(SUM(CASE WHEN m.tipo='recibo_usd'  THEN m.monto_usd ELSE 0 END),0) AS recibido_usd,
              COUNT(m.id) AS movimientos
         FROM cambio_movimientos m WHERE m.entidad_id = $1 AND m.deleted_at IS NULL`, [id]
    );
    res.json({ ...e[0], resumen: tot[0] });
  } catch (err) { next(err); }
});

router.post('/entidades', validate(createEntidadSchema), async (req, res, next) => {
  try {
    const { nombre, activo } = req.body;
    const { rows } = await db.query(
      'INSERT INTO cambio_entidades (nombre, activo) VALUES ($1,$2) RETURNING *', [nombre, activo]
    );
    await audit('cambio_entidades', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json({ ...rows[0], saldo_usd: 0, entregado_usd: 0, recibido_usd: 0, movimientos: 0 });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una financiera con ese nombre' });
    next(err);
  }
});

router.put('/entidades/:id', validate(updateEntidadSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { nombre, activo } = req.body;
    const { rows } = await db.query(
      `UPDATE cambio_entidades SET nombre = COALESCE($1, nombre), activo = COALESCE($2, activo)
        WHERE id = $3 AND deleted_at IS NULL RETURNING *`,
      [nombre ?? null, activo ?? null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Financiera no encontrada' });
    await audit('cambio_entidades', 'UPDATE', id, { despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una financiera con ese nombre' });
    next(err);
  }
});

router.delete('/entidades/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE cambio_entidades SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Financiera no encontrada' });
    await audit('cambio_entidades', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── MOVIMIENTOS ─────────────────────────────────────────────────────────────
router.get('/entidades/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    const [countRes, dataRes] = await Promise.all([
      db.query('SELECT COUNT(*) FROM cambio_movimientos WHERE entidad_id = $1 AND deleted_at IS NULL', [id]),
      db.query(
        `SELECT m.*, mp.nombre AS caja_nombre
           FROM cambio_movimientos m
           LEFT JOIN metodos_pago mp ON mp.id = m.caja_id
          WHERE m.entidad_id = $1 AND m.deleted_at IS NULL
          ORDER BY m.fecha DESC, m.id DESC
          LIMIT $2 OFFSET $3`, [id, limit, offset]
      ),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

router.post('/movimientos', validate(createMovimientoSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { entidad_id, fecha, tipo, monto_ars, tc, monto_usd, caja_id, comentarios } = req.body;
    await client.query('BEGIN');
    const { rows: ent } = await client.query('SELECT id FROM cambio_entidades WHERE id = $1 AND deleted_at IS NULL', [entidad_id]);
    if (!ent[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Financiera no encontrada' }); }

    // Normaliza montos según el tipo y postea al ledger de la caja.
    let ars = 0, usd = 0, ledgerMonto, ledgerMoneda, ledgerTipo;
    if (tipo === 'entrega_ars') {
      ars = round2(Number(monto_ars));
      usd = round2(ars / Number(tc));        // USD equivalente que nos deben
      ledgerMonto = ars; ledgerMoneda = 'ARS'; ledgerTipo = 'egreso';
    } else { // recibo_usd
      usd = round2(Number(monto_usd));
      ledgerMonto = usd; ledgerMoneda = 'USD'; ledgerTipo = 'ingreso';
    }

    const { rows } = await client.query(
      `INSERT INTO cambio_movimientos (entidad_id, fecha, tipo, monto_ars, tc, monto_usd, caja_id, comentarios, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [entidad_id, fecha, tipo, ars, tc ?? null, usd, caja_id, comentarios ?? null, req.user.id]
    );
    // Integrado al ledger: la moneda del movimiento debe coincidir con la de la caja
    // (postCajaMovimiento valida grupo de moneda y lanza 400 si no coincide).
    await postCajaMovimiento(client, {
      caja_id, fecha, tipo: ledgerTipo, monto: ledgerMonto, moneda: ledgerMoneda, tc: tipo === 'entrega_ars' ? tc : null,
      origen: 'cambio', ref_tabla: 'cambio_movimientos', ref_id: rows[0].id,
      concepto: tipo === 'entrega_ars' ? 'Cambio: entrega ARS' : 'Cambio: recibo USD', user_id: req.user.id,
    });
    await client.query('COMMIT');
    await audit('cambio_movimientos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
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
    const { rows } = await client.query(
      'UPDATE cambio_movimientos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    await reverseCajaMovimientos(client, 'cambio_movimientos', id);
    await client.query('COMMIT');
    await audit('cambio_movimientos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;
