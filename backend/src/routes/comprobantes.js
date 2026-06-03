const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const parseId = require('../lib/parseId');
const { computeNeto } = require('../lib/money');
const {
  createComprobanteSchema, queryComprobantesSchema,
  createManualComprobanteSchema, updateManualComprobanteSchema,
} = require('../schemas/comprobantes');

// Resolver el % de comisión efectivo para un comprobante manual: prioriza el
// del request, fallback al `pct_financiera` global de config (mismo valor que
// usa syncFinancieraComprobante para los auto-generados desde Ventas).
async function resolverPctFinanciera(client, pctRequest) {
  if (pctRequest != null) return Number(pctRequest);
  const { rows } = await client.query('SELECT pct_financiera FROM config LIMIT 1');
  return Number(rows[0]?.pct_financiera || 0);
}


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
        // Columnas explícitas SIN archivo_data (base64): no debe viajar en el listado.
        // El archivo se sirve aparte por GET /:id/archivo. tiene_archivo indica si hay adjunto.
        `SELECT c.id, c.fecha, c.cliente, c.vendedor_id, c.monto, c.monto_financiera, c.monto_neto,
                c.referencia, c.archivo_nombre, c.archivo_tipo, c.venta_id, c.created_at,
                (c.archivo_data IS NOT NULL) AS tiene_archivo,
                v.nombre AS vendedor_nombre
         ${baseQuery}
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
    // Excluir el base64 del audit (infla la tabla) y de la respuesta (el cliente ya lo tiene)
    const { archivo_data: _blob, ...comprobante } = rows[0];
    await audit('comprobantes', 'INSERT', rows[0].id, { despues: comprobante, user_id: req.user.id });
    res.status(201).json(comprobante);
  } catch (err) {
    next(err);
  }
});

// ─── Comprobante manual (venta previa al sistema) ────────────────────────────
// Réplica del modelo "cobro previo" de Tarjetas. Carga un comprobante con
// venta_id=NULL — para ventas históricas donde el cliente pagó con la caja
// Financiera pero la venta no está en el sistema. No impacta caja_movimientos
// (no hay venta real). Solo agrega al resumen de Financiera.
router.post('/manuales', validate(createManualComprobanteSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { fecha, cliente, vendedor_id, monto_bruto, pct, referencia } = req.body;
    await client.query('BEGIN');

    const pctEfectivo = await resolverPctFinanciera(client, pct);
    const { bruto, pct: pctFinal, comision, neto } = computeNeto(monto_bruto, pctEfectivo);

    const { rows } = await client.query(
      `INSERT INTO comprobantes
        (fecha, cliente, vendedor_id, monto, monto_financiera, monto_neto,
         referencia, venta_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
       RETURNING id, fecha, cliente, vendedor_id, monto, monto_financiera,
                 monto_neto, referencia, venta_id, created_at`,
      [fecha, cliente, vendedor_id ?? null, bruto, comision, neto, referencia ?? null]
    );
    await audit(client, 'comprobantes', 'INSERT', rows[0].id, {
      despues: rows[0], tipo: 'manual_venta_previa', pct_aplicado: pctFinal,
      user_id: req.user.id,
    });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// PATCH solo aplica a comprobantes manuales (venta_id IS NULL). Los
// autogenerados se ajustan editando la venta — bloqueamos con 400.
router.patch('/manuales/:id', validate(updateManualComprobanteSchema), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query(
      `SELECT id, fecha, cliente, vendedor_id, monto, monto_financiera,
              monto_neto, referencia, venta_id
         FROM comprobantes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id]
    );
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Comprobante no encontrado' }); }
    if (before[0].venta_id != null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este comprobante proviene de una venta. Se ajusta editando la venta, no desde acá.' });
    }
    const cur = before[0];
    const body = req.body;

    // Resolver valores: priorizar el body, fallback al row actual.
    const fecha       = body.fecha       ?? cur.fecha;
    const cliente     = body.cliente     ?? cur.cliente;
    const vendedor_id = body.vendedor_id === undefined ? cur.vendedor_id : (body.vendedor_id ?? null);
    const referencia  = body.referencia  === undefined ? cur.referencia  : (body.referencia ?? null);

    // Recalcular montos: el `pct` aplicado original NO se persiste en la tabla,
    // así que si el body trae solo `monto_bruto` (sin pct), usamos el pct
    // global actual de config. Esto puede dar un resultado distinto al original
    // — el operador puede mandar pct explícito si quiere preservar el viejo.
    const pctEfectivo = await resolverPctFinanciera(client, body.pct);
    const brutoInput  = body.monto_bruto ?? cur.monto;
    const { bruto, pct: pctFinal, comision, neto } = computeNeto(brutoInput, pctEfectivo);

    const { rows } = await client.query(
      `UPDATE comprobantes
          SET fecha = $2, cliente = $3, vendedor_id = $4, monto = $5,
              monto_financiera = $6, monto_neto = $7, referencia = $8
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, fecha, cliente, vendedor_id, monto, monto_financiera,
                  monto_neto, referencia, venta_id, created_at`,
      [id, fecha, cliente, vendedor_id, bruto, comision, neto, referencia]
    );
    await audit(client, 'comprobantes', 'UPDATE', id, {
      antes: cur, despues: rows[0], pct_aplicado: pctFinal, user_id: req.user.id,
    });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ─── Eliminar (soft delete) ───────────────────────────────────────────────────
// Solo elimina comprobantes manuales (venta_id IS NULL). Los autogenerados
// desde Ventas se reconcilian via syncFinancieraComprobante — borrarlos a mano
// rompería el invariante (si la venta sigue activa con pago financiera +
// archivo, el sync los recrearía igual).
//
// Audit-in-tx (regresión H6 que el sprint anterior arregló en otros módulos).
router.delete('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query(
      'SELECT * FROM comprobantes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id]
    );
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No encontrado' }); }
    if (before[0].venta_id != null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este comprobante proviene de una venta. Se ajusta editando o cancelando la venta, no desde acá.' });
    }
    const { rows } = await client.query(
      'UPDATE comprobantes SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    const { archivo_data: _blob, ...comprobante } = rows[0];
    await audit(client, 'comprobantes', 'DELETE', id, { antes: comprobante, user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ─── Archivo adjunto ──────────────────────────────────────────────────────────
router.get('/:id/archivo', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      'SELECT archivo_data, archivo_nombre, archivo_tipo FROM comprobantes WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (!rows[0]?.archivo_data) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.json({ data: rows[0].archivo_data, nombre: rows[0].archivo_nombre, tipo: rows[0].archivo_tipo });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
