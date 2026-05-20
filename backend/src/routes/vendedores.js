const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const { createVendedorSchema } = require('../schemas/vendedores');

router.use(requireAuth);

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM vendedores ORDER BY nombre');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(createVendedorSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'INSERT INTO vendedores (nombre) VALUES ($1) RETURNING *',
      [req.body.nombre]
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
    await db.query('DELETE FROM vendedores WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
