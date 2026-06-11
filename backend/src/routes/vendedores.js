const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const { createVendedorSchema, queryVendedoresSchema } = require('../schemas/vendedores');
const parseId = require('../lib/parseId');
const audit  = require('../lib/audit');


router.get('/', validate(queryVendedoresSchema, 'query'), async (req, res, next) => {
  try {
    const { buscar } = req.query;
    const params = [];
    let filter = '';
    if (buscar) {
      params.push(`%${buscar}%`);
      filter = ` AND nombre ILIKE $1`;
    }
    const { rows } = await db.query(
      `SELECT * FROM vendedores WHERE deleted_at IS NULL${filter} ORDER BY nombre LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// 2026-06-11 S-05: INSERT/UPDATE + audit en la misma TX (antes post-write con pool).
router.post('/', validate(createVendedorSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO vendedores (nombre) VALUES ($1) RETURNING *',
      [req.body.nombre]
    );
    await audit(client, 'vendedores', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id, req });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un vendedor con ese nombre' });
    next(err);
  } finally { client.release(); }
});

router.delete('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE vendedores SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Vendedor no encontrado' }); }
    await audit(client, 'vendedores', 'DELETE', id, { antes: rows[0], user_id: req.user.id, req });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
});

module.exports = router;
