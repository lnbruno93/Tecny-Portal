const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const { createVendedorSchema } = require('../schemas/vendedores');
const parseId = require('../lib/parseId');

router.use(requireAuth);

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM vendedores WHERE deleted_at IS NULL ORDER BY nombre LIMIT 500');
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
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE vendedores SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Vendedor no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
