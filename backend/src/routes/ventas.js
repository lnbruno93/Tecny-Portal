const router = require('express').Router();
const crypto = require('crypto');
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const {
  createVentaSchema, updateVentaSchema, queryVentasSchema,
  etiquetaSchema,
  garantiaSchema, updateGarantiaSchema,
  comprobanteVentaSchema,
  createEgresoSchema, queryEgresosSchema, queryDashboardSchema,
  createVentaRapidaSchema, updateVentaRapidaSchema,
} = require('../schemas/ventas');

router.use(requireAuth);

// Convierte un monto a USD. ARS usa el TC provisto (o el de la venta como fallback).
function toUsd(monto, moneda, tc) {
  const m = Number(monto) || 0;
  if (moneda === 'USD' || moneda === 'USDT') return m;
  if (moneda === 'ARS') return tc && Number(tc) > 0 ? m / Number(tc) : 0;
  return m;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function genOrderId() {
  const yy = new Date().getFullYear().toString().slice(-2);
  return `ORD-${yy}-${crypto.randomBytes(4).toString('hex')}`;
}

/* ═══════════════════════ ETIQUETAS ═══════════════════════ */

router.get('/etiquetas', async (_req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM etiquetas WHERE deleted_at IS NULL ORDER BY nombre');
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/etiquetas', validate(etiquetaSchema), async (req, res, next) => {
  try {
    const { nombre, color } = req.body;
    const { rows } = await db.query(
      'INSERT INTO etiquetas (nombre, color) VALUES ($1,$2) RETURNING *', [nombre, color ?? null]
    );
    await audit('etiquetas', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una etiqueta con ese nombre' });
    next(err);
  }
});

router.delete('/etiquetas/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE etiquetas SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Etiqueta no encontrada' });
    await audit('etiquetas', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ═══════════════════════ MÉTODOS DE PAGO ═══════════════════════ */

router.get('/metodos-pago', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM metodos_pago WHERE deleted_at IS NULL AND activo = true ORDER BY orden, nombre"
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ═══════════════════════ PLANTILLAS DE GARANTÍA ═══════════════════════ */

router.get('/garantias', async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, nombre, texto, es_default FROM plantillas_garantia WHERE deleted_at IS NULL ORDER BY es_default DESC, nombre'
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/garantias', validate(garantiaSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { nombre, texto, es_default } = req.body;
    await client.query('BEGIN');
    if (es_default) await client.query('UPDATE plantillas_garantia SET es_default = false WHERE es_default = true');
    const { rows } = await client.query(
      'INSERT INTO plantillas_garantia (nombre, texto, es_default) VALUES ($1,$2,$3) RETURNING id, nombre, texto, es_default',
      [nombre, texto, !!es_default]
    );
    await client.query('COMMIT');
    await audit('plantillas_garantia', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una garantía con ese nombre' });
    next(err);
  } finally { client.release(); }
});

router.put('/garantias/:id', validate(updateGarantiaSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const id = parseId(req.params.id);
    if (!id) { client.release(); return res.status(400).json({ error: 'ID inválido' }); }
    await client.query('BEGIN');
    const { rows: before } = await client.query('SELECT * FROM plantillas_garantia WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before[0]) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ error: 'Garantía no encontrada' }); }
    const { nombre, texto, es_default } = req.body;
    if (es_default) await client.query('UPDATE plantillas_garantia SET es_default = false WHERE es_default = true AND id <> $1', [id]);
    const { rows } = await client.query(
      `UPDATE plantillas_garantia SET nombre = COALESCE($1, nombre), texto = COALESCE($2, texto), es_default = COALESCE($3, es_default)
       WHERE id = $4 RETURNING id, nombre, texto, es_default`,
      [nombre, texto, es_default, id]
    );
    await client.query('COMMIT');
    await audit('plantillas_garantia', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una garantía con ese nombre' });
    next(err);
  } finally { client.release(); }
});

router.delete('/garantias/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE plantillas_garantia SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Garantía no encontrada' });
    await audit('plantillas_garantia', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ═══════════════════════ DASHBOARD (agregaciones) ═══════════════════════ */

router.get('/dashboard', validate(queryDashboardSchema, 'query'), async (req, res, next) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const desde = req.query.desde || hoy;
    const hasta = req.query.hasta || hoy;
    const p = [desde, hasta];
    // Filtro base de ventas del período (excluye canceladas y borradas)
    const BASE = `v.deleted_at IS NULL AND v.estado <> 'cancelado' AND v.fecha >= $1 AND v.fecha <= $2`;

    const [totales, pagos, unidades, canjes, egresos, dif, horario, etiquetas] = await Promise.all([
      // Totales de ventas
      db.query(`SELECT COUNT(*) AS count, COALESCE(SUM(total_usd),0) AS ingresos_usd, COALESCE(SUM(ganancia_usd),0) AS ganancia_bruta_usd FROM ventas v WHERE ${BASE}`, p),
      // Por método de pago (monto en moneda original + equivalente USD)
      db.query(`SELECT pp.metodo_nombre, pp.moneda, COALESCE(SUM(pp.monto),0) AS total, COALESCE(SUM(pp.monto_usd),0) AS total_usd, COUNT(*) AS n
                FROM venta_pagos pp JOIN ventas v ON v.id = pp.venta_id WHERE ${BASE}
                GROUP BY pp.metodo_nombre, pp.moneda ORDER BY total_usd DESC`, p),
      // Unidades por clase + costos en USD
      db.query(`SELECT
                  COALESCE(SUM(vi.cantidad) FILTER (WHERE pr.clase = 'celular' OR pr.id IS NULL),0) AS celulares,
                  COALESCE(SUM(vi.cantidad) FILTER (WHERE pr.clase = 'accesorio'),0) AS accesorios,
                  COALESCE(SUM(CASE WHEN vi.moneda = 'ARS' AND v.tc_venta > 0 THEN vi.costo*vi.cantidad/v.tc_venta ELSE vi.costo*vi.cantidad END),0) AS costos_usd
                FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id LEFT JOIN productos pr ON pr.id = vi.producto_id WHERE ${BASE}`, p),
      // Inversión en canjes (USD)
      db.query(`SELECT COALESCE(SUM(CASE WHEN c.moneda = 'ARS' AND v.tc_venta > 0 THEN c.valor_toma/v.tc_venta ELSE c.valor_toma END),0) AS canjes_usd
                FROM canjes c JOIN ventas v ON v.id = c.venta_id WHERE ${BASE}`, p),
      // Egresos del período (USD)
      db.query(`SELECT COALESCE(SUM(monto_usd),0) AS egresos_usd FROM egresos WHERE deleted_at IS NULL AND fecha >= $1 AND fecha <= $2`, p),
      // Diferencias de pago (sobrepagos / faltantes)
      db.query(`WITH dif AS (
                  SELECT v.total_usd,
                    COALESCE((SELECT SUM(monto_usd) FROM venta_pagos pp WHERE pp.venta_id = v.id),0)
                    + COALESCE((SELECT SUM(CASE WHEN cc.moneda='ARS' AND v.tc_venta>0 THEN cc.valor_toma/v.tc_venta ELSE cc.valor_toma END) FROM canjes cc WHERE cc.venta_id = v.id),0) AS cubierto
                  FROM ventas v WHERE ${BASE}
                )
                SELECT COALESCE(SUM(CASE WHEN cubierto-total_usd > 0 THEN cubierto-total_usd ELSE 0 END),0) AS sobrepagos,
                       COALESCE(SUM(CASE WHEN cubierto-total_usd < 0 THEN total_usd-cubierto ELSE 0 END),0) AS faltantes FROM dif`, p),
      // Ventas por hora
      db.query(`SELECT EXTRACT(HOUR FROM v.hora)::int AS hora, COUNT(*) AS n FROM ventas v WHERE ${BASE} AND v.hora IS NOT NULL GROUP BY 1 ORDER BY 1`, p),
      // Ventas por etiqueta
      db.query(`SELECT COALESCE(e.nombre,'Sin etiqueta') AS etiqueta, COUNT(*) AS n FROM ventas v LEFT JOIN etiquetas e ON e.id = v.etiqueta_id WHERE ${BASE} GROUP BY 1 ORDER BY n DESC`, p),
    ]);

    // Ingresos por moneda (a partir del desglose de métodos)
    const ingresos_por_moneda = { USD: 0, ARS: 0, USDT: 0 };
    let ingresos_usd_equiv = 0;
    for (const r of pagos.rows) {
      ingresos_por_moneda[r.moneda] = (ingresos_por_moneda[r.moneda] || 0) + Number(r.total);
      ingresos_usd_equiv += Number(r.total_usd);
    }

    const t = totales.rows[0];
    const gananciaBruta = Number(t.ganancia_bruta_usd);
    const egresosUsd = Number(egresos.rows[0].egresos_usd);
    const gananciaNeta = round2(gananciaBruta - egresosUsd);
    const ingresosVentas = Number(t.ingresos_usd);
    const margenPct = ingresosVentas > 0 ? round2((gananciaNeta / ingresosVentas) * 100) : 0;

    res.json({
      periodo: { desde, hasta },
      ventas_count: parseInt(t.count),
      ingresos: {
        usd: round2(ingresos_por_moneda.USD),
        ars: round2(ingresos_por_moneda.ARS),
        usdt: round2(ingresos_por_moneda.USDT),
        total_usd_equiv: round2(ingresos_usd_equiv),
        ventas_total_usd: round2(ingresosVentas),
      },
      unidades: { celulares: parseInt(unidades.rows[0].celulares), accesorios: parseInt(unidades.rows[0].accesorios) },
      ganancia_bruta_usd: round2(gananciaBruta),
      egresos_usd: round2(egresosUsd),
      ganancia_neta_usd: gananciaNeta,
      margen_pct: margenPct,
      costos_usd: round2(Number(unidades.rows[0].costos_usd)),
      inversion_canjes_usd: round2(Number(canjes.rows[0].canjes_usd)),
      metodos_pago: pagos.rows.map(r => ({ metodo_nombre: r.metodo_nombre, moneda: r.moneda, total: round2(Number(r.total)), total_usd: round2(Number(r.total_usd)), n: parseInt(r.n) })),
      diferencias: { sobrepagos: round2(Number(dif.rows[0].sobrepagos)), faltantes: round2(Number(dif.rows[0].faltantes)), neto: round2(Number(dif.rows[0].sobrepagos) - Number(dif.rows[0].faltantes)) },
      por_horario: horario.rows.map(r => ({ hora: r.hora, n: parseInt(r.n) })),
      por_etiqueta: etiquetas.rows.map(r => ({ etiqueta: r.etiqueta, n: parseInt(r.n) })),
    });
  } catch (err) { next(err); }
});

/* ═══════════════════════ EGRESOS ═══════════════════════ */

router.get('/egresos', validate(queryEgresosSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const conditions = ['deleted_at IS NULL'];
    const params = [];
    if (desde) { params.push(desde); conditions.push(`fecha >= $${params.length}`); }
    if (hasta) { params.push(hasta); conditions.push(`fecha <= $${params.length}`); }
    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });
    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM egresos WHERE ${where}`, params),
      db.query(`SELECT * FROM egresos WHERE ${where} ORDER BY fecha DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

router.post('/egresos', validate(createEgresoSchema), async (req, res, next) => {
  try {
    const { fecha, concepto, monto, moneda, tc, metodo_pago_id, notas } = req.body;
    const monto_usd = round2(toUsd(monto, moneda, tc));
    const { rows } = await db.query(
      `INSERT INTO egresos (fecha, concepto, monto, moneda, tc, monto_usd, metodo_pago_id, notas, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [fecha, concepto, monto, moneda, tc ?? null, monto_usd, metodo_pago_id ?? null, notas ?? null, req.user.id]
    );
    await audit('egresos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/egresos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE egresos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Egreso no encontrado' });
    await audit('egresos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ═══════════════════════ COMPROBANTES DE VENTA ═══════════════════════ */

router.post('/:id/comprobantes', validate(comprobanteVentaSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const venta = await db.query('SELECT id FROM ventas WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!venta.rows[0]) return res.status(404).json({ error: 'Venta no encontrada' });
    const { archivo_data, archivo_nombre, archivo_tipo } = req.body;
    const { rows } = await db.query(
      `INSERT INTO venta_comprobantes (venta_id, archivo_data, archivo_nombre, archivo_tipo)
       VALUES ($1,$2,$3,$4) RETURNING id, archivo_nombre, archivo_tipo, created_at`,
      [id, archivo_data, archivo_nombre ?? null, archivo_tipo ?? null]
    );
    await audit('venta_comprobantes', 'INSERT', rows[0].id, { despues: { venta_id: id, nombre: archivo_nombre }, user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.get('/:id/comprobantes', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'SELECT id, archivo_nombre, archivo_tipo, created_at FROM venta_comprobantes WHERE venta_id = $1 ORDER BY id', [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/comprobantes/:cid', async (req, res, next) => {
  try {
    const cid = parseId(req.params.cid);
    if (!cid) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'SELECT archivo_data, archivo_nombre, archivo_tipo FROM venta_comprobantes WHERE id = $1', [cid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Comprobante no encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ═══════════════════════ VENTAS RÁPIDAS ═══════════════════════ */

router.get('/ventas-rapidas', async (req, res, next) => {
  try {
    const { estado } = req.query;
    const params = [];
    let filter = '';
    if (estado === 'pendiente' || estado === 'procesada') { params.push(estado); filter = ` AND estado = $1`; }
    const { rows } = await db.query(
      `SELECT * FROM ventas_rapidas WHERE deleted_at IS NULL${filter} ORDER BY fecha DESC, id DESC LIMIT 200`, params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/ventas-rapidas', validate(createVentaRapidaSchema), async (req, res, next) => {
  try {
    const { vendedor_id, vendedor_nombre, cliente_texto, detalle, fecha, hora } = req.body;
    const { rows } = await db.query(
      `INSERT INTO ventas_rapidas (vendedor_id, vendedor_nombre, cliente_texto, detalle, fecha, hora, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [vendedor_id ?? null, vendedor_nombre ?? null, cliente_texto ?? null, detalle, fecha, hora ?? null, req.user.id]
    );
    await audit('ventas_rapidas', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/ventas-rapidas/:id', validate(updateVentaRapidaSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows: before } = await db.query('SELECT * FROM ventas_rapidas WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before[0]) return res.status(404).json({ error: 'Venta rápida no encontrada' });
    const { detalle, cliente_texto, vendedor_nombre, estado, venta_id } = req.body;
    const { rows } = await db.query(
      `UPDATE ventas_rapidas SET
         detalle         = COALESCE($1, detalle),
         cliente_texto   = COALESCE($2, cliente_texto),
         vendedor_nombre = COALESCE($3, vendedor_nombre),
         estado          = COALESCE($4, estado),
         venta_id        = COALESCE($5, venta_id)
       WHERE id = $6 RETURNING *`,
      [detalle, cliente_texto, vendedor_nombre, estado, venta_id, id]
    );
    await audit('ventas_rapidas', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/ventas-rapidas/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows } = await db.query(
      'UPDATE ventas_rapidas SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Venta rápida no encontrada' });
    await audit('ventas_rapidas', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ═══════════════════════ VENTAS ═══════════════════════ */

router.get('/', validate(queryVentasSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta, estado, etiqueta_id, buscar } = req.query;
    const conditions = ['v.deleted_at IS NULL'];
    const params = [];
    if (desde)       { params.push(desde);       conditions.push(`v.fecha >= $${params.length}`); }
    if (hasta)       { params.push(hasta);       conditions.push(`v.fecha <= $${params.length}`); }
    if (estado)      { params.push(estado);      conditions.push(`v.estado = $${params.length}`); }
    if (etiqueta_id) { params.push(etiqueta_id); conditions.push(`v.etiqueta_id = $${params.length}`); }
    if (buscar) {
      params.push(`%${buscar}%`);
      conditions.push(`(v.order_id ILIKE $${params.length} OR v.cliente_nombre ILIKE $${params.length}
                        OR EXISTS (SELECT 1 FROM venta_items vi WHERE vi.venta_id = v.id AND (vi.descripcion ILIKE $${params.length} OR vi.imei ILIKE $${params.length})))`);
    }
    const where = conditions.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });

    const dataQuery = `
      SELECT v.*, e.nombre AS etiqueta_nombre, e.color AS etiqueta_color,
        COALESCE((SELECT json_agg(i ORDER BY i.id) FROM venta_items i WHERE i.venta_id = v.id), '[]') AS items,
        COALESCE((SELECT json_agg(p ORDER BY p.id) FROM venta_pagos p WHERE p.venta_id = v.id), '[]') AS pagos,
        COALESCE((SELECT json_agg(c ORDER BY c.id) FROM canjes c WHERE c.venta_id = v.id), '[]') AS canjes,
        COALESCE((SELECT COUNT(*) FROM venta_comprobantes vc WHERE vc.venta_id = v.id), 0) AS comprobantes_count
      FROM ventas v
      LEFT JOIN etiquetas e ON e.id = v.etiqueta_id
      WHERE ${where}
      ORDER BY v.fecha DESC, v.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM ventas v WHERE ${where}`, params),
      db.query(dataQuery, [...params, limit, offset]),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) { next(err); }
});

router.post('/', validate(createVentaSchema), async (req, res, next) => {
  const b = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Totales en USD (normalizados por TC)
    let totalUsd = 0, costoUsd = 0, comisionUsd = 0;
    for (const it of b.items) {
      totalUsd    += toUsd(it.precio_vendido * it.cantidad, it.moneda, b.tc_venta);
      costoUsd    += toUsd(it.costo * it.cantidad, it.moneda, b.tc_venta);
      comisionUsd += toUsd(it.comision, it.moneda, b.tc_venta);
    }
    const gananciaUsd = round2(totalUsd - costoUsd - comisionUsd);

    const { rows: vrows } = await client.query(
      `INSERT INTO ventas (order_id, fecha, hora, cliente_id, cliente_cc_id, cliente_nombre, etiqueta_id, garantia_id, estado, tc_venta, tc_compra, total_usd, ganancia_usd, notas, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [genOrderId(), b.fecha, b.hora ?? null, b.cliente_id ?? null, b.cliente_cc_id ?? null, b.cliente_nombre ?? null,
       b.etiqueta_id ?? null, b.garantia_id ?? null, b.estado, b.tc_venta ?? null, b.tc_compra ?? null, round2(totalUsd), gananciaUsd, b.notas ?? null, req.user.id]
    );
    const venta = vrows[0];

    // Items + descuento de stock
    for (const it of b.items) {
      const ganancia = round2((it.precio_vendido - it.costo) * it.cantidad - it.comision);
      await client.query(
        `INSERT INTO venta_items (venta_id, producto_id, vendedor_id, descripcion, imei, cantidad, precio_vendido, precio_original, costo, moneda, comision, ganancia)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [venta.id, it.producto_id ?? null, it.vendedor_id ?? null, it.descripcion, it.imei ?? null, it.cantidad,
         it.precio_vendido, it.precio_original ?? null, it.costo, it.moneda, it.comision, ganancia]
      );
      if (it.producto_id) {
        await client.query(
          `UPDATE productos
             SET cantidad = GREATEST(cantidad - $1, 0),
                 estado   = CASE WHEN tipo_carga = 'unitario' THEN 'vendido' ELSE estado END
           WHERE id = $2 AND deleted_at IS NULL`,
          [it.cantidad, it.producto_id]
        );
      }
    }

    // Pagos
    for (const p of b.pagos) {
      const montoUsd = round2(toUsd(p.monto, p.moneda, p.tc ?? b.tc_venta));
      await client.query(
        `INSERT INTO venta_pagos (venta_id, metodo_pago_id, metodo_nombre, monto, moneda, tc, monto_usd, es_cuenta_corriente)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [venta.id, p.metodo_pago_id ?? null, p.metodo_nombre, p.monto, p.moneda, p.tc ?? null, montoUsd, p.es_cuenta_corriente]
      );
    }

    // Canjes (opcionalmente ingresan al stock como producto usado)
    for (const c of b.canjes) {
      let prodId = null;
      if (c.agregar_stock) {
        const { rows: pr } = await client.query(
          `INSERT INTO productos (tipo_carga, clase, nombre, imei, gb, color, bateria, costo, costo_moneda, precio_venta, precio_moneda, estado, observaciones)
           VALUES ('unitario','celular',$1,$2,$3,$4,$5,$6,$7,0,$7,'disponible',$8) RETURNING id`,
          [c.descripcion, c.imei ?? null, c.gb ?? null, c.color ?? null, c.bateria ?? null, c.valor_toma, c.moneda, `Ingresado por canje (venta ${venta.order_id})`]
        );
        prodId = pr[0].id;
      }
      await client.query(
        `INSERT INTO canjes (venta_id, descripcion, imei, gb, color, bateria, valor_toma, moneda, producto_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [venta.id, c.descripcion, c.imei ?? null, c.gb ?? null, c.color ?? null, c.bateria ?? null, c.valor_toma, c.moneda, prodId]
      );
    }

    await client.query('COMMIT');
    await audit('ventas', 'INSERT', venta.id, { despues: venta, user_id: req.user.id });
    res.status(201).json(venta);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', validate(updateVentaSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { rows: before } = await db.query('SELECT * FROM ventas WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before[0]) return res.status(404).json({ error: 'Venta no encontrada' });

    const { estado, etiqueta_id, garantia_id, cliente_id, cliente_nombre, notas } = req.body;
    const { rows } = await db.query(
      `UPDATE ventas SET
         estado         = COALESCE($1, estado),
         etiqueta_id    = COALESCE($2, etiqueta_id),
         garantia_id    = COALESCE($3, garantia_id),
         cliente_id     = COALESCE($4, cliente_id),
         cliente_nombre = COALESCE($5, cliente_nombre),
         notas          = COALESCE($6, notas)
       WHERE id = $7 RETURNING *`,
      [estado, etiqueta_id, garantia_id, cliente_id, cliente_nombre, notas, id]
    );
    await audit('ventas', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  const client = await db.connect();
  try {
    const id = parseId(req.params.id);
    if (!id) { client.release(); return res.status(400).json({ error: 'ID inválido' }); }

    await client.query('BEGIN');
    const { rows: before } = await client.query('SELECT * FROM ventas WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before[0]) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ error: 'Venta no encontrada' }); }

    // Reponer stock de los items que descontaron
    const { rows: items } = await client.query('SELECT producto_id, cantidad FROM venta_items WHERE venta_id = $1 AND producto_id IS NOT NULL', [id]);
    for (const it of items) {
      await client.query(
        `UPDATE productos
           SET cantidad = cantidad + $1,
               estado   = CASE WHEN tipo_carga = 'unitario' AND estado = 'vendido' THEN 'disponible' ELSE estado END
         WHERE id = $2 AND deleted_at IS NULL`,
        [it.cantidad, it.producto_id]
      );
    }
    const { rows } = await client.query('UPDATE ventas SET deleted_at = NOW() WHERE id = $1 RETURNING *', [id]);
    await client.query('COMMIT');
    await audit('ventas', 'DELETE', id, { antes: before[0], user_id: req.user.id });
    res.json({ ok: true, stock_repuesto: items.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
