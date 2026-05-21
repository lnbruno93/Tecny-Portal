const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { createPagoSchema } = require('../schemas/pagos');

router.use(requireAuth);

// ─── Totales globales ─────────────────────────────────────────────────────────
router.get('/totales', async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*) AS count, COALESCE(SUM(monto), 0) AS total_monto
      FROM pagos
    `);
    res.json({
      count:       parseInt(rows[0].count),
      total_monto: parseFloat(rows[0].total_monto),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Lista paginada ───────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    const [countRes, dataRes] = await Promise.all([
      db.query('SELECT COUNT(*) FROM pagos'),
      db.query('SELECT * FROM pagos ORDER BY fecha DESC, id DESC LIMIT $1 OFFSET $2', [limit, offset]),
    ]);

    const total = parseInt(countRes.rows[0].count);
    res.json(paginatedResponse(dataRes.rows, total, { page, limit }));
  } catch (err) {
    next(err);
  }
});

// ─── Crear ────────────────────────────────────────────────────────────────────
router.post('/', validate(createPagoSchema), async (req, res, next) => {
  try {
    const { fecha, monto, referencia } = req.body;
    const { rows } = await db.query(
      'INSERT INTO pagos (fecha, monto, referencia) VALUES ($1,$2,$3) RETURNING *',
      [fecha, monto, referencia ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ─── Eliminar ─────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
    await db.query('DELETE FROM pagos WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
