// Módulo Proyectos — agrupa proyectos y trackea desarrollo + inversiones.
// Montado en /api/proyectos con requireAuth + requirePermission('proyectos') (app.js).
const router  = require('express').Router();
const db      = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const { toUsd, round2 } = require('../lib/money');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { createProyectoSchema, updateProyectoSchema, createMovimientoProyectoSchema } = require('../schemas/proyectos');

// Calcula el monto en USD de un movimiento: si hay $ + tc → $/tc; si no, el USD directo.
function calcUsd({ monto, tc, monto_usd }) {
  if (Number(monto) > 0 && Number(tc) > 0) return round2(toUsd(Number(monto), 'ARS', Number(tc)));
  if (Number(monto_usd) > 0) return round2(Number(monto_usd));
  return 0;
}

// ─── PROYECTOS ──────────────────────────────────────────────────────────────

// Lista de proyectos con totales invertidos ($ y USD) y cantidad de movimientos.
router.get('/', async (req, res, next) => {
  try {
    const { buscar } = req.query;
    const params = [];
    const filters = ['p.deleted_at IS NULL'];
    if (buscar) { params.push(`%${buscar}%`); filters.push(`(p.nombre ILIKE $${params.length} OR p.objetivo ILIKE $${params.length})`); }
    const { rows } = await db.query(
      `SELECT p.*,
              COALESCE(m.total_ars, 0) AS total_ars,
              COALESCE(m.total_usd, 0) AS total_usd,
              COALESCE(m.cant, 0)      AS cant_movimientos
       FROM proyectos p
       LEFT JOIN (
         SELECT proyecto_id, SUM(monto) AS total_ars, SUM(monto_usd) AS total_usd, COUNT(*) AS cant,
                MIN(fecha) AS desde, MAX(fecha) AS hasta
         FROM proyecto_movimientos WHERE deleted_at IS NULL GROUP BY proyecto_id
       ) m ON m.proyecto_id = p.id
       WHERE ${filters.join(' AND ')}
       ORDER BY p.fecha_creacion DESC, p.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Detalle: proyecto + participantes (con nombre) + totales + rango de fechas de movimientos.
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows: p } = await db.query('SELECT * FROM proyectos WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!p[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });

    const [{ rows: parts }, { rows: tot }] = await Promise.all([
      db.query(
        `SELECT c.id, c.nombre, c.apellido FROM proyecto_participantes pp
           JOIN contactos c ON c.id = pp.contacto_id
          WHERE pp.proyecto_id = $1 ORDER BY c.nombre, c.apellido`, [id]
      ),
      db.query(
        `SELECT COALESCE(SUM(monto), 0) AS total_ars, COALESCE(SUM(monto_usd), 0) AS total_usd,
                COUNT(*) AS cant_movimientos, MIN(fecha) AS desde, MAX(fecha) AS hasta
           FROM proyecto_movimientos WHERE proyecto_id = $1 AND deleted_at IS NULL`, [id]
      ),
    ]);
    res.json({ ...p[0], participantes: parts, resumen: tot[0] });
  } catch (err) { next(err); }
});

router.post('/', validate(createProyectoSchema), async (req, res, next) => {
  const { nombre, objetivo, fecha_creacion, participantes = [] } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO proyectos (nombre, objetivo, fecha_creacion)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE)) RETURNING *`,
      [nombre, objetivo ?? null, fecha_creacion ?? null]
    );
    const proyecto = rows[0];
    for (const cid of participantes) {
      await client.query(
        'INSERT INTO proyecto_participantes (proyecto_id, contacto_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [proyecto.id, cid]
      );
    }
    await client.query('COMMIT');
    await audit('proyectos', 'INSERT', proyecto.id, { despues: proyecto, user_id: req.user.id });
    res.status(201).json({ ...proyecto, total_ars: 0, total_usd: 0, cant_movimientos: 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.put('/:id', validate(updateProyectoSchema), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const { nombre, objetivo, fecha_creacion, participantes } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE proyectos SET
         nombre = COALESCE($1, nombre), objetivo = COALESCE($2, objetivo),
         fecha_creacion = COALESCE($3, fecha_creacion)
       WHERE id = $4 AND deleted_at IS NULL RETURNING *`,
      [nombre ?? null, objetivo ?? null, fecha_creacion ?? null, id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Proyecto no encontrado' }); }
    if (participantes !== undefined) {
      await client.query('DELETE FROM proyecto_participantes WHERE proyecto_id = $1', [id]);
      for (const cid of participantes) {
        await client.query('INSERT INTO proyecto_participantes (proyecto_id, contacto_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, cid]);
      }
    }
    await client.query('COMMIT');
    await audit('proyectos', 'UPDATE', id, { despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE proyectos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    await audit('proyectos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── MOVIMIENTOS (hoja del proyecto) ─────────────────────────────────────────

router.get('/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    const [countRes, dataRes] = await Promise.all([
      db.query('SELECT COUNT(*) FROM proyecto_movimientos WHERE proyecto_id = $1 AND deleted_at IS NULL', [id]),
      db.query(
        `SELECT m.*, (c.nombre || COALESCE(' ' || c.apellido, '')) AS inversor_nombre
           FROM proyecto_movimientos m
           LEFT JOIN contactos c ON c.id = m.inversor_contacto_id
          WHERE m.proyecto_id = $1 AND m.deleted_at IS NULL
          ORDER BY m.fecha DESC, m.id DESC
          LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      ),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

router.post('/movimientos', validate(createMovimientoProyectoSchema), async (req, res, next) => {
  try {
    const { proyecto_id, fecha, detalle, categoria, monto, tc, monto_usd, inversor_contacto_id, comentarios } = req.body;
    const { rows: p } = await db.query('SELECT id FROM proyectos WHERE id = $1 AND deleted_at IS NULL', [proyecto_id]);
    if (!p[0]) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const usd = calcUsd({ monto, tc, monto_usd });
    const { rows } = await db.query(
      `INSERT INTO proyecto_movimientos
         (proyecto_id, fecha, detalle, categoria, monto, tc, monto_usd, inversor_contacto_id, comentarios)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [proyecto_id, fecha, detalle ?? null, categoria ?? null, Number(monto) || 0, tc ?? null, usd, inversor_contacto_id ?? null, comentarios ?? null]
    );
    await audit('proyecto_movimientos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/movimientos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE proyecto_movimientos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Movimiento no encontrado' });
    await audit('proyecto_movimientos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
