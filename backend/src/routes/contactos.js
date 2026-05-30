const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { createContactoSchema, updateContactoSchema, queryContactosSchema } = require('../schemas/contactos');


router.get('/', validate(queryContactosSchema, 'query'), async (req, res, next) => {
  try {
    const { buscar, tipo, origen } = req.query;
    // Post-audit quick-win: paginar contactos (puede crecer a miles si el
    // negocio acumula histórico de clientes). Default 500 conservador para
    // preservar comportamiento de callers que cargan el listado completo
    // (Ventas, Cajas); página 1 + limit 500 reproduce el shape viejo.
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 500, maxLimit: 500 });
    const conditions = ['deleted_at IS NULL'];
    const params = [];

    if (buscar) {
      params.push(`%${buscar}%`);
      const i = params.length;
      conditions.push(`(nombre ILIKE $${i} OR apellido ILIKE $${i} OR email ILIKE $${i} OR telefono ILIKE $${i} OR dni ILIKE $${i})`);
    }
    if (tipo) {
      params.push(tipo);
      conditions.push(`tipo = $${params.length}`);
    }
    if (origen) {
      params.push(origen);
      conditions.push(`origen = $${params.length}`);
    }

    const where = conditions.join(' AND ');
    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM contactos WHERE ${where}`, params),
      db.query(
        `SELECT * FROM contactos WHERE ${where} ORDER BY nombre, apellido LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(createContactoSchema), async (req, res, next) => {
  try {
    const { nombre, apellido, telefono, dni, email, fecha_nacimiento, tipo, origen } = req.body;
    const { rows } = await db.query(
      `INSERT INTO contactos (nombre, apellido, telefono, dni, email, fecha_nacimiento, tipo, origen)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'cliente'),COALESCE($8,'manual')) RETURNING *`,
      [nombre, apellido ?? null, telefono ?? null, dni ?? null, (email || null),
       (fecha_nacimiento || null), tipo ?? null, origen ?? null]
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

    const { nombre, apellido, telefono, dni, email, fecha_nacimiento, tipo, origen } = req.body;
    const { rows } = await db.query(
      `UPDATE contactos SET
        nombre           = COALESCE($1, nombre),
        apellido         = COALESCE($2, apellido),
        telefono         = COALESCE($3, telefono),
        dni              = COALESCE($4, dni),
        email            = COALESCE($5, email),
        fecha_nacimiento = COALESCE($6, fecha_nacimiento),
        tipo             = COALESCE($7, tipo),
        origen           = COALESCE($8, origen)
       WHERE id = $9 RETURNING *`,
      [nombre, apellido, telefono, dni, (email === '' ? null : email),
       (fecha_nacimiento === '' ? null : fecha_nacimiento), tipo, origen, id]
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
