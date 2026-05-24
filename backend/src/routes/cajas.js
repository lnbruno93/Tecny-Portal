const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const {
  createDeudaSchema, queryDeudasSchema,
  createInversionSchema, queryInversionesSchema,
} = require('../schemas/cajas');


// ─── DEUDAS ─────────────────────────────────────────────────

router.get('/deudas', validate(queryDeudasSchema, 'query'), async (req, res, next) => {
  try {
    const { contacto_id } = req.query;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    let where = 'WHERE c.deleted_at IS NULL AND m.deleted_at IS NULL';
    const params = [];
    if (contacto_id) { params.push(contacto_id); where += ` AND m.contacto_id = $${params.length}`; }

    const baseQuery = `
      FROM movimientos_deudas m
      JOIN contactos c ON c.id = m.contacto_id
      ${where}
    `;

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) ${baseQuery}`, params),
      db.query(
        `SELECT m.id, m.fecha, m.contacto_id, m.tipo AS mov_tipo,
                m.monto_ars, m.monto_usd, m.concepto, m.created_at,
                c.nombre, c.apellido, c.tipo AS contacto_tipo
         ${baseQuery}
         ORDER BY m.fecha DESC, m.id DESC
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

router.post('/deudas', validate(createDeudaSchema), async (req, res, next) => {
  try {
    const { fecha, contacto_id, tipo, monto_ars, monto_usd, concepto } = req.body;
    const { rows } = await db.query(
      `INSERT INTO movimientos_deudas (fecha, contacto_id, tipo, monto_ars, monto_usd, concepto)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [fecha, contacto_id, tipo, monto_ars, monto_usd, concepto ?? null]
    );
    await audit('movimientos_deudas', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/deudas/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      'UPDATE movimientos_deudas SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Movimiento no encontrado' });
    await audit('movimientos_deudas', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── INVERSIONES ────────────────────────────────────────────

router.get('/inversiones', validate(queryInversionesSchema, 'query'), async (req, res, next) => {
  try {
    const { contacto_id } = req.query;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    let where = 'WHERE c.deleted_at IS NULL AND m.deleted_at IS NULL';
    const params = [];
    if (contacto_id) { params.push(contacto_id); where += ` AND m.contacto_id = $${params.length}`; }

    const baseQuery = `
      FROM movimientos_inversiones m
      JOIN contactos c ON c.id = m.contacto_id
      ${where}
    `;

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) ${baseQuery}`, params),
      db.query(
        `SELECT m.id, m.fecha, m.contacto_id, m.monto, m.tasa, m.created_at,
                c.nombre, c.apellido, c.tipo AS contacto_tipo
         ${baseQuery}
         ORDER BY m.fecha DESC, m.id DESC
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

router.post('/inversiones', validate(createInversionSchema), async (req, res, next) => {
  try {
    const { fecha, contacto_id, monto, tasa } = req.body;
    const { rows } = await db.query(
      `INSERT INTO movimientos_inversiones (fecha, contacto_id, monto, tasa)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [fecha, contacto_id, monto, tasa ?? null]
    );
    await audit('movimientos_inversiones', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/inversiones/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      'UPDATE movimientos_inversiones SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Inversión no encontrada' });
    await audit('movimientos_inversiones', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── RESUMEN ────────────────────────────────────────────────

router.get('/resumen', async (_req, res, next) => {
  try {
    const [{ rows: deudas }, { rows: inv }] = await Promise.all([
      db.query(`
        SELECT m.contacto_id,
          SUM(CASE WHEN m.tipo='debe' THEN m.monto_ars ELSE -m.monto_ars END) AS saldo_ars,
          SUM(CASE WHEN m.tipo='debe' THEN m.monto_usd ELSE -m.monto_usd END) AS saldo_usd,
          COUNT(*) AS movimientos
        FROM movimientos_deudas m
        JOIN contactos c ON c.id = m.contacto_id AND c.deleted_at IS NULL
        WHERE m.deleted_at IS NULL
        GROUP BY m.contacto_id
      `),
      db.query(`
        WITH ultima_tasa AS (
          SELECT DISTINCT ON (contacto_id)
            contacto_id, tasa
          FROM movimientos_inversiones
          WHERE tasa IS NOT NULL AND deleted_at IS NULL
          ORDER BY contacto_id, fecha DESC, id DESC
        )
        SELECT m.contacto_id,
          SUM(m.monto) AS total_invertido,
          COUNT(*) AS movimientos,
          ut.tasa AS ultima_tasa
        FROM movimientos_inversiones m
        JOIN contactos c ON c.id = m.contacto_id AND c.deleted_at IS NULL
        LEFT JOIN ultima_tasa ut ON ut.contacto_id = m.contacto_id
        WHERE m.deleted_at IS NULL
        GROUP BY m.contacto_id, ut.tasa
      `),
    ]);
    res.json({ deudas, inversiones: inv });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
