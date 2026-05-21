const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { createComprobanteSchema, queryComprobantesSchema } = require('../schemas/comprobantes');

router.use(requireAuth);

// ─── Totales con los mismos filtros que la lista ─────────────────────────────
router.get('/totales', validate(queryComprobantesSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta, vendedor, buscar } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (desde)   { params.push(desde);   where += ` AND c.fecha >= $${params.length}`; }
    if (hasta)   { params.push(hasta);   where += ` AND c.fecha <= $${params.length}`; }
    if (vendedor){ params.push(vendedor); where += ` AND v.nombre = $${params.length}`; }
    if (buscar)  {
      params.push(`%${buscar}%`);
      where += ` AND (c.cliente ILIKE $${params.length} OR c.referencia ILIKE $${params.length})`;
    }

    const { rows } = await db.query(`
      SELECT
        COUNT(*)                        AS count,
        COALESCE(SUM(c.monto),            0) AS total_monto,
        COALESCE(SUM(c.monto_financiera), 0) AS total_financiera,
        COALESCE(SUM(c.monto_neto),       0) AS total_neto
      FROM comprobantes c
      LEFT JOIN vendedores v ON v.id = c.vendedor_id
      ${where} AND c.deleted_at IS NULL
    `, params);

    const r = rows[0];
    res.json({
      count:            parseInt(r.count),
      total_monto:      parseFloat(r.total_monto),
      total_financiera: parseFloat(r.total_financiera),
      total_neto:       parseFloat(r.total_neto),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Lista paginada con filtros ───────────────────────────────────────────────
router.get('/', validate(queryComprobantesSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta, vendedor, buscar } = req.query;
    const { page, limit, offset } = parsePagination(req.query);

    let where = 'WHERE 1=1';
    const params = [];

    if (desde)   { params.push(desde);        where += ` AND c.fecha >= $${params.length}`; }
    if (hasta)   { params.push(hasta);         where += ` AND c.fecha <= $${params.length}`; }
    if (vendedor){ params.push(vendedor);       where += ` AND v.nombre = $${params.length}`; }
    if (buscar)  {
      params.push(`%${buscar}%`);
      where += ` AND (c.cliente ILIKE $${params.length} OR c.referencia ILIKE $${params.length})`;
    }

    const baseQuery = `
      FROM comprobantes c
      LEFT JOIN vendedores v ON v.id = c.vendedor_id
      ${where} AND c.deleted_at IS NULL
    `;

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) ${baseQuery}`, params),
      db.query(
        `SELECT c.*, v.nombre AS vendedor_nombre ${baseQuery}
         ORDER BY c.fecha DESC, c.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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
router.post('/', validate(createComprobanteSchema), async (req, res, next) => {
  try {
    const { fecha, cliente, vendedor_id, monto, monto_financiera, monto_neto, referencia, archivo_data, archivo_nombre, archivo_tipo } = req.body;
    const { rows } = await db.query(
      `INSERT INTO comprobantes (fecha, cliente, vendedor_id, monto, monto_financiera, monto_neto, referencia, archivo_data, archivo_nombre, archivo_tipo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [fecha, cliente, vendedor_id ?? null, monto, monto_financiera, monto_neto ?? monto, referencia ?? null,
       archivo_data ?? null, archivo_nombre ?? null, archivo_tipo ?? null]
    );
    await audit('comprobantes', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ─── Eliminar (soft delete) ───────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      'UPDATE comprobantes SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });

    await audit('comprobantes', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Archivo adjunto ──────────────────────────────────────────────────────────
router.get('/:id/archivo', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      'SELECT archivo_data, archivo_nombre, archivo_tipo FROM comprobantes WHERE id = $1',
      [id]
    );
    if (!rows[0]?.archivo_data) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.json({ data: rows[0].archivo_data, nombre: rows[0].archivo_nombre, tipo: rows[0].archivo_tipo });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
