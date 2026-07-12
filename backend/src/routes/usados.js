const express  = require('express');
const router   = express.Router();
const db       = require('../config/database');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const validate = require('../lib/validate');
const requireCapability = require('../middleware/requireCapability');
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

    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at
         FROM catalogo_usados
         ${where}
         ORDER BY equipo ASC, capacidad ASC, pct_bateria ASC`,
        params
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/usados/:id ──────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at
         FROM catalogo_usados WHERE id = $1 AND deleted_at IS NULL`,
        [id]
      );
      return rows;
    });
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/usados ─────────────────────────────────────────────────────────
// 2026-06-23 F5a: gate inline. El módulo está gateado por `usados.ver`
// (vendedor lo tiene = puede ver el catálogo). Agregar un equipo es
// capability separada `usados.agregar_equipo` — encargado lo tiene en
// default, vendedor NO. Owner/admin del tenant bypassean.
router.post('/', requireCapability('usados.agregar_equipo'), validate(createUsadoSchema), async (req, res, next) => {
  try {
    const data = req.body;
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO catalogo_usados (equipo, capacidad, pct_bateria, precio_usd, comentarios)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at`,
        [data.equipo, data.capacidad ?? null, data.pct_bateria ?? null, data.precio_usd, data.comentarios ?? null]
      );
      await audit(client, 'catalogo_usados', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
      return rows;
    });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/usados/bulk ─────────────────────────────────────────────────────
// Actualiza precio_usd y comentarios de múltiples productos en una sola transacción.
//
// 2026-07-12 (auditoría TOTAL P0-1 Stock): agregado `requireCapability`. Antes,
// el módulo estaba gateado a nivel router solo por `usados.ver` (que TODO
// vendedor + lectura tienen por default). Sin gate inline, un rol lectura
// podía reescribir el listado en masa vía DevTools. Mismo criterio semántico
// que POST /: "modificar el catálogo" = capability `usados.agregar_equipo`.
router.put('/bulk', requireCapability('usados.agregar_equipo'), validate(bulkUpdateUsadosSchema), async (req, res, next) => {
  try {
    const { updates } = req.body;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
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
// 2026-07-12 (auditoría TOTAL P0-1 Stock): cap gate (ver PUT /bulk arriba).
router.put('/:id', requireCapability('usados.agregar_equipo'), validate(updateUsadoSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const data = req.body;

    const result = await db.withTenant(req.tenantId, async (client) => {
      const prev = await client.query(
        `SELECT * FROM catalogo_usados WHERE id = $1 AND deleted_at IS NULL`,
        [id]
      );
      if (!prev.rows.length) return { notFound: true };

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
      const { rows } = await client.query(
        `UPDATE catalogo_usados SET ${fields.join(', ')} WHERE id = $${params.length} AND deleted_at IS NULL
         RETURNING id, equipo, capacidad, pct_bateria, precio_usd, comentarios, created_at`,
        params
      );
      await audit(client, 'catalogo_usados', 'UPDATE', rows[0].id, { antes: prev.rows[0], despues: rows[0], user_id: req.user.id });
      return { rows };
    });
    if (result.notFound) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/usados/:id ───────────────────────────────────────────────────
// 2026-07-12 (auditoría TOTAL P0-1 Stock): cap gate. Usamos la misma
// `usados.agregar_equipo` que PUT — el DELETE también es "modificar el
// catálogo". Si en el futuro querés granularidad extra ("no puedo agregar,
// pero sí archivar"), separá con `usados.eliminar_equipo` nueva.
router.delete('/:id', requireCapability('usados.agregar_equipo'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE catalogo_usados SET deleted_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id]
      );
      if (rows.length) {
        await audit(client, 'catalogo_usados', 'DELETE', rows[0].id, { user_id: req.user.id });
      }
      return rows;
    });
    if (!rows.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
