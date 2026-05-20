const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const { createPagoSchema } = require('../schemas/pagos');

router.use(requireAuth);

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM pagos ORDER BY fecha DESC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

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
