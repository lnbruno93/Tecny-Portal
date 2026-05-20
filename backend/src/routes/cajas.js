const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const {
  createDeudaSchema, queryDeudasSchema,
  createInversionSchema, queryInversionesSchema,
} = require('../schemas/cajas');

router.use(requireAuth);

// ─── DEUDAS ─────────────────────────────────────────────────

router.get('/deudas', validate(queryDeudasSchema, 'query'), async (req, res, next) => {
  try {
    const { contacto_id } = req.query;
    let query = `
      SELECT m.*, c.nombre, c.apellido, c.tipo
      FROM movimientos_deudas m
      JOIN contactos c ON c.id = m.contacto_id
      WHERE c.deleted_at IS NULL
    `;
    const params = [];
    if (contacto_id) { params.push(contacto_id); query += ` AND m.contacto_id = $${params.length}`; }
    query += ' ORDER BY m.fecha DESC, m.id DESC';
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/deudas', validate(createDeudaSchema), async (req, res, next) => {
  try {
    const { fecha, contacto_id, tipo, monto_ars, monto_usd, concepto } = req.body;
    const { rows } = await db.query(
      `INSERT INTO movimientos_deudas (fecha, contacto_id, tipo, monto_ars, monto_usd, concepto)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [fecha, contacto_id, tipo, monto_ars, monto_usd, concepto ?? null]
    );
    await audit('movimientos_deudas', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/deudas/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query('SELECT * FROM movimientos_deudas WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Movimiento no encontrado' });
    await db.query('DELETE FROM movimientos_deudas WHERE id = $1', [id]);
    await audit('movimientos_deudas', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── INVERSIONES ────────────────────────────────────────────

router.get('/inversiones', validate(queryInversionesSchema, 'query'), async (req, res, next) => {
  try {
    const { contacto_id } = req.query;
    let query = `
      SELECT m.*, c.nombre, c.apellido, c.tipo
      FROM movimientos_inversiones m
      JOIN contactos c ON c.id = m.contacto_id
      WHERE c.deleted_at IS NULL
    `;
    const params = [];
    if (contacto_id) { params.push(contacto_id); query += ` AND m.contacto_id = $${params.length}`; }
    query += ' ORDER BY m.fecha DESC, m.id DESC';
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/inversiones', validate(createInversionSchema), async (req, res, next) => {
  try {
    const { fecha, contacto_id, monto, tasa } = req.body;
    const { rows } = await db.query(
      `INSERT INTO movimientos_inversiones (fecha, contacto_id, monto, tasa)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [fecha, contacto_id, monto, tasa ?? null]
    );
    await audit('movimientos_inversiones', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/inversiones/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query('SELECT * FROM movimientos_inversiones WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Inversión no encontrada' });
    await db.query('DELETE FROM movimientos_inversiones WHERE id = $1', [id]);
    await audit('movimientos_inversiones', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── RESUMEN ────────────────────────────────────────────────

router.get('/resumen', async (_req, res, next) => {
  try {
    const [{ rows: deudas }, { rows: inv }] = await Promise.all([
      db.query(`
        SELECT m.contacto_id,
          SUM(CASE WHEN m.tipo='debe' THEN m.monto_ars ELSE -m.monto_ars END) AS saldo_ars,
          SUM(CASE WHEN m.tipo='debe' THEN m.monto_usd ELSE -m.monto_usd END) AS saldo_usd,
          COUNT(*) AS movimientos
        FROM movimientos_deudas m
        JOIN contactos c ON c.id = m.contacto_id AND c.deleted_at IS NULL
        GROUP BY m.contacto_id
      `),
      db.query(`
        SELECT m.contacto_id,
          SUM(m.monto) AS total_invertido,
          COUNT(*) AS movimientos,
          (SELECT tasa FROM movimientos_inversiones
           WHERE contacto_id = m.contacto_id AND tasa IS NOT NULL
           ORDER BY fecha DESC, id DESC LIMIT 1) AS ultima_tasa
        FROM movimientos_inversiones m
        JOIN contactos c ON c.id = m.contacto_id AND c.deleted_at IS NULL
        GROUP BY m.contacto_id
      `),
    ]);
    res.json({ deudas, inversiones: inv });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
