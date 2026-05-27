// Módulo Egresos (bajo Cajas). Gastos de la empresa con categoría, agenda y
// estado pendiente/pagado. Recién al marcar 'pagado' descuenta de la caja
// elegida (ledger, origen 'egreso'). Soporta plantillas recurrentes mensuales.
// Montado en /api/egresos con requireAuth + requirePermission('cajas') (app.js).
const router   = require('express').Router();
const db       = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { toUsd, round2 } = require('../lib/money');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const {
  createCategoriaSchema, updateCategoriaSchema,
  createRecurrenteSchema, updateRecurrenteSchema,
  createEgresoSchema, updateEgresoSchema, queryEgresosSchema, generarPeriodoSchema,
} = require('../schemas/egresos');

// Postea el egreso al ledger de su caja (solo si está pagado y tiene caja).
async function postEgresoLedger(client, e) {
  if (e.estado !== 'pagado' || !e.metodo_pago_id) return;
  await postCajaMovimiento(client, {
    caja_id: e.metodo_pago_id, fecha: e.fecha, tipo: 'egreso',
    monto: Number(e.monto), moneda: e.moneda, tc: e.tc,
    origen: 'egreso', ref_tabla: 'egresos', ref_id: e.id,
    concepto: e.concepto || 'Egreso', user_id: e.user_id,
  });
}

// ─── CATEGORÍAS ──────────────────────────────────────────────────────────────
router.get('/categorias', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM egreso_categorias WHERE deleted_at IS NULL ORDER BY nombre');
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/categorias', validate(createCategoriaSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'INSERT INTO egreso_categorias (nombre) VALUES ($1) RETURNING *', [req.body.nombre]
    );
    await audit('egreso_categorias', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    next(err);
  }
});

router.put('/categorias/:id', validate(updateCategoriaSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE egreso_categorias SET nombre = COALESCE($1, nombre) WHERE id = $2 AND deleted_at IS NULL RETURNING *',
      [req.body.nombre ?? null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    await audit('egreso_categorias', 'UPDATE', id, { despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    next(err);
  }
});

router.delete('/categorias/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE egreso_categorias SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    await audit('egreso_categorias', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── RECURRENTES (plantillas) ────────────────────────────────────────────────
router.get('/recurrentes', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.*, c.nombre AS categoria_nombre, mp.nombre AS caja_nombre
         FROM egresos_recurrentes r
         LEFT JOIN egreso_categorias c ON c.id = r.categoria_id
         LEFT JOIN metodos_pago mp ON mp.id = r.metodo_pago_id
        WHERE r.deleted_at IS NULL ORDER BY r.concepto`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/recurrentes', validate(createRecurrenteSchema), async (req, res, next) => {
  try {
    const { concepto, categoria_id, monto, moneda, tc, metodo_pago_id, dia_del_mes, activo } = req.body;
    const { rows } = await db.query(
      `INSERT INTO egresos_recurrentes (concepto, categoria_id, monto, moneda, tc, metodo_pago_id, dia_del_mes, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [concepto, categoria_id ?? null, monto, moneda, tc ?? null, metodo_pago_id ?? null, dia_del_mes, activo]
    );
    await audit('egresos_recurrentes', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/recurrentes/:id', validate(updateRecurrenteSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { concepto, categoria_id, monto, moneda, tc, metodo_pago_id, dia_del_mes, activo } = req.body;
    const { rows } = await db.query(
      `UPDATE egresos_recurrentes SET
         concepto       = COALESCE($1, concepto),
         categoria_id   = COALESCE($2, categoria_id),
         monto          = COALESCE($3, monto),
         moneda         = COALESCE($4, moneda),
         tc             = COALESCE($5, tc),
         metodo_pago_id = COALESCE($6, metodo_pago_id),
         dia_del_mes    = COALESCE($7, dia_del_mes),
         activo         = COALESCE($8, activo)
       WHERE id = $9 AND deleted_at IS NULL RETURNING *`,
      [concepto ?? null, categoria_id ?? null, monto ?? null, moneda ?? null, tc ?? null,
       metodo_pago_id ?? null, dia_del_mes ?? null, activo ?? null, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Recurrente no encontrado' });
    await audit('egresos_recurrentes', 'UPDATE', id, { despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/recurrentes/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE egresos_recurrentes SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Recurrente no encontrado' });
    await audit('egresos_recurrentes', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Genera egresos PENDIENTES de los recurrentes activos para un período (YYYY-MM).
// Idempotente: el índice único (recurrente_id, periodo) evita duplicar.
router.post('/generar', validate(generarPeriodoSchema), async (req, res, next) => {
  try {
    const { periodo } = req.body;
    const [y, m] = periodo.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const { rows: recs } = await db.query('SELECT * FROM egresos_recurrentes WHERE activo = true AND deleted_at IS NULL');
    let generados = 0;
    for (const r of recs) {
      const dia = Math.min(r.dia_del_mes, lastDay);
      const fecha = `${periodo}-${String(dia).padStart(2, '0')}`;
      const monto_usd = round2(toUsd(Number(r.monto), r.moneda, r.tc));
      const { rows } = await db.query(
        `INSERT INTO egresos (fecha, concepto, monto, moneda, tc, monto_usd, metodo_pago_id, categoria_id, estado, recurrente_id, periodo, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendiente',$9,$10,$11)
         ON CONFLICT (recurrente_id, periodo) WHERE recurrente_id IS NOT NULL AND deleted_at IS NULL
         DO NOTHING RETURNING id`,
        [fecha, r.concepto, r.monto, r.moneda, r.tc ?? null, monto_usd, r.metodo_pago_id, r.categoria_id, r.id, periodo, req.user.id]
      );
      if (rows[0]) generados++;
    }
    res.json({ ok: true, generados, periodo });
  } catch (err) { next(err); }
});

// ─── EGRESOS ─────────────────────────────────────────────────────────────────
router.get('/', validate(queryEgresosSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta, estado, categoria_id } = req.query;
    const conditions = ['e.deleted_at IS NULL'];
    const params = [];
    if (desde)        { params.push(desde);        conditions.push(`e.fecha >= $${params.length}`); }
    if (hasta)        { params.push(hasta);        conditions.push(`e.fecha <= $${params.length}`); }
    if (estado)       { params.push(estado);       conditions.push(`e.estado = $${params.length}`); }
    if (categoria_id) { params.push(categoria_id); conditions.push(`e.categoria_id = $${params.length}`); }
    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM egresos e WHERE ${where}`, params),
      db.query(
        `SELECT e.*, c.nombre AS categoria_nombre, mp.nombre AS caja_nombre
           FROM egresos e
           LEFT JOIN egreso_categorias c ON c.id = e.categoria_id
           LEFT JOIN metodos_pago mp ON mp.id = e.metodo_pago_id
          WHERE ${where}
          ORDER BY e.fecha DESC, e.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

router.post('/', validate(createEgresoSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { fecha, concepto, categoria_id, monto, moneda, tc, metodo_pago_id, estado, notas } = req.body;
    const monto_usd = round2(toUsd(Number(monto), moneda, tc));
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO egresos (fecha, concepto, categoria_id, monto, moneda, tc, monto_usd, metodo_pago_id, estado, notas, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [fecha, concepto, categoria_id ?? null, monto, moneda, tc ?? null, monto_usd, metodo_pago_id ?? null, estado, notas ?? null, req.user.id]
    );
    await postEgresoLedger(client, rows[0]);
    await client.query('COMMIT');
    await audit('egresos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.put('/:id', validate(updateEgresoSchema), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query('SELECT * FROM egresos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Egreso no encontrado' }); }

    const b = before[0];
    const next_ = {
      fecha:          req.body.fecha          ?? b.fecha,
      concepto:       req.body.concepto       ?? b.concepto,
      categoria_id:   req.body.categoria_id   !== undefined ? req.body.categoria_id   : b.categoria_id,
      monto:          req.body.monto          ?? b.monto,
      moneda:         req.body.moneda         ?? b.moneda,
      tc:             req.body.tc             !== undefined ? req.body.tc             : b.tc,
      metodo_pago_id: req.body.metodo_pago_id !== undefined ? req.body.metodo_pago_id : b.metodo_pago_id,
      estado:         req.body.estado         ?? b.estado,
      notas:          req.body.notas          !== undefined ? req.body.notas          : b.notas,
    };
    if (next_.estado === 'pagado' && !next_.metodo_pago_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Para marcar un egreso como pagado hay que indicar de qué caja sale' });
    }
    const monto_usd = round2(toUsd(Number(next_.monto), next_.moneda, next_.tc));
    const { rows } = await client.query(
      `UPDATE egresos SET fecha=$1, concepto=$2, categoria_id=$3, monto=$4, moneda=$5, tc=$6,
              monto_usd=$7, metodo_pago_id=$8, estado=$9, notas=$10
        WHERE id=$11 RETURNING *`,
      [next_.fecha, next_.concepto, next_.categoria_id, next_.monto, next_.moneda, next_.tc,
       monto_usd, next_.metodo_pago_id, next_.estado, next_.notas, id]
    );
    // Resincroniza el ledger: revierte lo anterior y re-postea si ahora está pagado.
    await reverseCajaMovimientos(client, 'egresos', id);
    await postEgresoLedger(client, { ...rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    await audit('egresos', 'UPDATE', id, { antes: b, despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.delete('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE egresos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Egreso no encontrado' }); }
    await reverseCajaMovimientos(client, 'egresos', id);
    await client.query('COMMIT');
    await audit('egresos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;
