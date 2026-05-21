const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { createEnvioSchema, updateEnvioSchema, queryEnviosSchema } = require('../schemas/envios');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const parseId = require('../lib/parseId');

router.use(requireAuth);

router.get('/', validate(queryEnviosSchema, 'query'), async (req, res, next) => {
  try {
    const { estado, buscar, desde, hasta } = req.query;
    let query = `
      SELECT e.*,
        JSON_AGG(i ORDER BY i.tipo, i.id) FILTER (WHERE i.id IS NOT NULL) AS items
      FROM envios e
      LEFT JOIN envio_items i ON i.envio_id = e.id
      WHERE e.deleted_at IS NULL
    `;
    const params = [];
    if (estado) { params.push(estado);        query += ` AND e.estado = $${params.length}`; }
    if (desde)  { params.push(desde);          query += ` AND e.fecha >= $${params.length}`; }
    if (hasta)  { params.push(hasta);          query += ` AND e.fecha <= $${params.length}`; }
    if (buscar) {
      params.push(`%${buscar}%`);
      query += ` AND (e.cliente ILIKE $${params.length} OR e.direccion ILIKE $${params.length}
                   OR e.barrio ILIKE $${params.length} OR e.telefono ILIKE $${params.length}
                   OR e.notas ILIKE $${params.length})`;
    }
    // Contar sin paginación para el total
    const countQuery = query.replace(
      /SELECT e\.\*,[\s\S]*?FROM envios e/,
      'SELECT COUNT(DISTINCT e.id) FROM envios e'
    );
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });
    query += ` GROUP BY e.id ORDER BY e.fecha DESC, e.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    const [countRes, dataRes] = await Promise.all([
      db.query(countQuery, params),
      db.query(query, [...params, limit, offset]),
    ]);
    const total = parseInt(countRes.rows[0].count);
    res.json(paginatedResponse(dataRes.rows.map(r => ({ ...r, items: r.items || [] })), total, { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(createEnvioSchema), async (req, res, next) => {
  try {
    const {
      fecha, cliente, telefono, direccion, barrio,
      costo_envio, total_cobrado, horario, operador, notas, estado, prioridad, items,
    } = req.body;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO envios (fecha, cliente, telefono, direccion, barrio, costo_envio, total_cobrado, horario, operador, notas, estado, prioridad)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [fecha, cliente, telefono ?? null, direccion, barrio ?? null, costo_envio, total_cobrado,
         horario ?? null, operador ?? null, notas ?? null, estado, prioridad ?? null]
      );
      const envio = rows[0];

      for (const item of items) {
        await client.query(
          'INSERT INTO envio_items (envio_id, tipo, descripcion, monto, metodo_pago) VALUES ($1,$2,$3,$4,$5)',
          [envio.id, item.tipo, item.descripcion ?? null, item.monto, item.metodo_pago ?? null]
        );
      }
      await client.query('COMMIT');
      await audit('envios', 'INSERT', envio.id, { despues: envio, user_id: req.user.id });
      res.status(201).json(envio);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(updateEnvioSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows: before } = await db.query(
      'SELECT * FROM envios WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!before[0]) return res.status(404).json({ error: 'Envío no encontrado' });

    const {
      fecha, cliente, telefono, direccion, barrio,
      costo_envio, total_cobrado, horario, operador, notas, estado, prioridad, items,
    } = req.body;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE envios SET
          fecha         = COALESCE($1,  fecha),
          cliente       = COALESCE($2,  cliente),
          telefono      = COALESCE($3,  telefono),
          direccion     = COALESCE($4,  direccion),
          barrio        = COALESCE($5,  barrio),
          costo_envio   = COALESCE($6,  costo_envio),
          total_cobrado = COALESCE($7,  total_cobrado),
          horario       = COALESCE($8,  horario),
          operador      = COALESCE($9,  operador),
          notas         = COALESCE($10, notas),
          estado        = COALESCE($11, estado),
          prioridad     = COALESCE($12, prioridad)
        WHERE id = $13 RETURNING *`,
        [fecha, cliente, telefono, direccion, barrio, costo_envio, total_cobrado,
         horario, operador, notas, estado, prioridad, id]
      );

      if (items !== undefined) {
        await client.query('DELETE FROM envio_items WHERE envio_id = $1', [id]);
        for (const item of items) {
          await client.query(
            'INSERT INTO envio_items (envio_id, tipo, descripcion, monto, metodo_pago) VALUES ($1,$2,$3,$4,$5)',
            [id, item.tipo, item.descripcion ?? null, item.monto, item.metodo_pago ?? null]
          );
        }
      }
      await client.query('COMMIT');
      await audit('envios', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
      res.json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      'UPDATE envios SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Envío no encontrado' });
    await audit('envios', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
