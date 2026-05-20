const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { createComprobanteSchema, queryComprobantesSchema } = require('../schemas/comprobantes');

router.use(requireAuth);

router.get('/', validate(queryComprobantesSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta, vendedor, buscar } = req.query;
    let query = `
      SELECT c.*, v.nombre AS vendedor_nombre
      FROM comprobantes c
      LEFT JOIN vendedores v ON v.id = c.vendedor_id
      WHERE 1=1
    `;
    const params = [];

    if (desde)   { params.push(desde);        query += ` AND c.fecha >= $${params.length}`; }
    if (hasta)   { params.push(hasta);         query += ` AND c.fecha <= $${params.length}`; }
    if (vendedor){ params.push(vendedor);       query += ` AND v.nombre = $${params.length}`; }
    if (buscar)  {
      params.push(`%${buscar}%`);
      query += ` AND (c.cliente ILIKE $${params.length} OR c.referencia ILIKE $${params.length})`;
    }

    query += ' ORDER BY c.fecha DESC, c.id DESC';
    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

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

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query('SELECT * FROM comprobantes WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });

    await db.query('DELETE FROM comprobantes WHERE id = $1', [id]);
    await audit('comprobantes', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

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
