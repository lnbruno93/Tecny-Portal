const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const { audit } = require('../lib/audit');
const { createUsadoSchema, updateUsadoSchema } = require('../schemas/usados');

// ── GET /api/usados ──────────────────────────────────────────────────────────
// Lista todos los productos del catálogo (con búsqueda opcional)
router.get('/', async (req, res, next) => {
  try {
    const { buscar } = req.query;
    const params = [];
    let where = 'WHERE deleted_at IS NULL';

    if (buscar) {
      params.push(`%${buscar}%`);
      where += ` AND (equipo ILIKE $${params.length} OR capacidad ILIKE $${params.length} OR comentarios ILIKE $${params.length})`;
    }

    const { rows } = await db.query(
      `SELECT id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at
       FROM catalogo_usados
       ${where}
       ORDER BY equipo ASC, capacidad ASC, pct_bateria ASC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/usados/:id ──────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at
       FROM catalogo_usados WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/usados ─────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const data = createUsadoSchema.parse(req.body);
    const { rows } = await db.query(
      `INSERT INTO catalogo_usados (equipo, capacidad, pct_bateria, precio_usd, comentarios)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at`,
      [data.equipo, data.capacidad ?? null, data.pct_bateria ?? null, data.precio_usd, data.comentarios ?? null]
    );
    await audit(req.user.id, 'CREATE', 'catalogo_usados', rows[0].id, null, rows[0]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/usados/:id ──────────────────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const data = updateUsadoSchema.parse(req.body);

    const prev = await db.query(
      `SELECT * FROM catalogo_usados WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!prev.rows.length) return res.status(404).json({ error: 'Producto no encontrado' });

    const fields = [];
    const params = [];
    const map = { equipo: 'equipo', capacidad: 'capacidad', pct_bateria: 'pct_bateria', precio_usd: 'precio_usd', comentarios: 'comentarios' };

    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) {
        params.push(data[key]);
        fields.push(`${col} = $${params.length}`);
      }
    }

    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE catalogo_usados SET ${fields.join(', ')} WHERE id = $${params.length} AND deleted_at IS NULL
       RETURNING id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at`,
      params
    );
    await audit(req.user.id, 'UPDATE', 'catalogo_usados', rows[0].id, prev.rows[0], rows[0]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/usados/:id ───────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE catalogo_usados SET deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    await audit(req.user.id, 'DELETE', 'catalogo_usados', rows[0].id, null, null);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
