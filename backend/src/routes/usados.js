const express  = require('express');
const router   = express.Router();
const db       = require('../config/database');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const validate = require('../lib/validate');
const { createUsadoSchema, updateUsadoSchema, bulkUpdateUsadosSchema } = require('../schemas/usados');

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
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      `SELECT id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at
       FROM catalogo_usados WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/usados ─────────────────────────────────────────────────────────
router.post('/', validate(createUsadoSchema), async (req, res, next) => {
  try {
    const data = req.body;
    const { rows } = await db.query(
      `INSERT INTO catalogo_usados (equipo, capacidad, pct_bateria, precio_usd, comentarios)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at`,
      [data.equipo, data.capacidad ?? null, data.pct_bateria ?? null, data.precio_usd, data.comentarios ?? null]
    );
    await audit('catalogo_usados', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/usados/bulk ─────────────────────────────────────────────────────
// Actualiza precio_usd y comentarios de múltiples productos en una sola transacción.
router.put('/bulk', validate(bulkUpdateUsadosSchema), async (req, res, next) => {
  try {
    const { updates } = req.body;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let count = 0;
      for (const u of updates) {
        const { rowCount } = await client.query(
          `UPDATE catalogo_usados
              SET precio_usd   = $1,
                  comentarios  = NULLIF($2::text, '')
            WHERE id = $3 AND deleted_at IS NULL`,
          [u.precio_usd, u.comentarios ?? null, u.id]
        );
        count += rowCount;
      }
      // Audit-in-tx (auditoría 2026-06-06 Sol M2) — antes corría en pool
      // global después del COMMIT, dejando ventana para audit huérfano si
      // el proceso moría entre commit y audit.
      await audit(client, 'catalogo_usados', 'UPDATE', null, {
        despues: { count, ids: updates.map(u => u.id) },
        user_id: req.user.id,
      });
      await client.query('COMMIT');
      res.json({ updated: count });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// ── PUT /api/usados/:id ──────────────────────────────────────────────────────
router.put('/:id', validate(updateUsadoSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const data = req.body;

    const prev = await db.query(
      `SELECT * FROM catalogo_usados WHERE id = $1 AND deleted_at IS NULL`,
      [id]
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

    params.push(id);
    const { rows } = await db.query(
      `UPDATE catalogo_usados SET ${fields.join(', ')} WHERE id = $${params.length} AND deleted_at IS NULL
       RETURNING id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at`,
      params
    );
    await audit('catalogo_usados', 'UPDATE', rows[0].id, { antes: prev.rows[0], despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/usados/:id ───────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      `UPDATE catalogo_usados SET deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    await audit('catalogo_usados', 'DELETE', rows[0].id, { user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
