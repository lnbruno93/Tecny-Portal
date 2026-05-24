const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { createPagoSchema, queryPagosSchema } = require('../schemas/pagos');
const parseId = require('../lib/parseId');
const audit  = require('../lib/audit');


// ─── Totales globales ─────────────────────────────────────────────────────────
router.get('/totales', async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*) AS count, COALESCE(SUM(monto), 0) AS total_monto
      FROM pagos WHERE deleted_at IS NULL
    `);
    res.json({
      count:       parseInt(rows[0].count),
      total_monto: parseFloat(rows[0].total_monto),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Lista paginada ───────────────────────────────────────────────────────────
router.get('/', validate(queryPagosSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta, buscar } = req.query;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    const conditions = ['deleted_at IS NULL'];
    const params = [];

    if (desde)  { params.push(desde);          conditions.push(`fecha >= $${params.length}`); }
    if (hasta)  { params.push(hasta);           conditions.push(`fecha <= $${params.length}`); }
    if (buscar) { params.push(`%${buscar}%`);   conditions.push(`referencia ILIKE $${params.length}`); }

    const where = conditions.join(' AND ');

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM pagos WHERE ${where}`, params),
      db.query(
        `SELECT * FROM pagos WHERE ${where} ORDER BY fecha DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countRes.rows[0].count);
    res.json(paginatedResponse(dataRes.rows, total, { page, limit }));
  } catch (err) {
    next(err);
  }
});

// ─── Crear ────────────────────────────────────────────────────────────────────
router.post('/', validate(createPagoSchema), async (req, res, next) => {
  try {
    const { fecha, monto, referencia } = req.body;
    const { rows } = await db.query(
      'INSERT INTO pagos (fecha, monto, referencia) VALUES ($1,$2,$3) RETURNING *',
      [fecha, monto, referencia ?? null]
    );
    await audit('pagos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ─── Eliminar (soft delete) ───────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE pagos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });
    await audit('pagos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
