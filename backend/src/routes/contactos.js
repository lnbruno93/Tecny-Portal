const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { createContactoSchema, updateContactoSchema } = require('../schemas/contactos');

router.use(requireAuth);

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM contactos WHERE deleted_at IS NULL ORDER BY nombre, apellido'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(createContactoSchema), async (req, res, next) => {
  try {
    const { nombre, apellido, tipo } = req.body;
    const { rows } = await db.query(
      'INSERT INTO contactos (nombre, apellido, tipo) VALUES ($1,$2,$3) RETURNING *',
      [nombre, apellido ?? null, tipo]
    );
    await audit('contactos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(updateContactoSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows: before } = await db.query(
      'SELECT * FROM contactos WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!before[0]) return res.status(404).json({ error: 'Contacto no encontrado' });

    const { nombre, apellido, tipo } = req.body;
    const { rows } = await db.query(
      `UPDATE contactos SET
        nombre   = COALESCE($1, nombre),
        apellido = COALESCE($2, apellido),
        tipo     = COALESCE($3, tipo)
       WHERE id = $4 RETURNING *`,
      [nombre, apellido, tipo, id]
    );
    await audit('contactos', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      'UPDATE contactos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Contacto no encontrado' });
    await audit('contactos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
