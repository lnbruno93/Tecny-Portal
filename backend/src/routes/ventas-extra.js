// Sub-recursos de Ventas: etiquetas, métodos de pago, plantillas de garantía,
// comprobantes de venta y ventas rápidas. (Egresos se movió a /api/egresos.)
// Se monta en /api/ventas junto al router principal (routes/ventas.js).
const router = require('express').Router();
const db = require('../config/database');
const requireAuth = require('../middleware/auth');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');
const { syncFinancieraComprobante } = require('../lib/financiera');
const {
  etiquetaSchema, garantiaSchema, updateGarantiaSchema, comprobanteVentaSchema,
  createVentaRapidaSchema, updateVentaRapidaSchema,
} = require('../schemas/ventas');

router.use(requireAuth);

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
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query('SELECT * FROM plantillas_garantia WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Garantía no encontrada' }); }
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

/* ═══════════════════════ COMPROBANTES DE VENTA ═══════════════════════ */

router.post('/:id/comprobantes', validate(comprobanteVentaSchema), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ventaRes = await client.query(
      'SELECT id, estado FROM ventas WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!ventaRes.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Venta no encontrada' }); }
    const venta = ventaRes.rows[0];

    const { archivo_data, archivo_nombre, archivo_tipo } = req.body;
    const { rows } = await client.query(
      `INSERT INTO venta_comprobantes (venta_id, archivo_data, archivo_nombre, archivo_tipo)
       VALUES ($1,$2,$3,$4) RETURNING id, archivo_nombre, archivo_tipo, created_at`,
      [id, archivo_data, archivo_nombre ?? null, archivo_tipo ?? null]
    );

    // Reconciliar el comprobante de Financiera (única fuente de verdad): si la venta
    // está activa y tiene un pago con la caja financiera, lo crea/recalcula con la
    // comisión = monto × pct_financiera (de Config), sin duplicar.
    const comprobanteFinanciera = await syncFinancieraComprobante(client, id, venta.estado);
    if (comprobanteFinanciera) {
      await audit('comprobantes', 'INSERT', comprobanteFinanciera.id, { despues: { venta_id: id, auto: true, monto: comprobanteFinanciera.monto, monto_financiera: comprobanteFinanciera.monto_financiera }, user_id: req.user.id });
    }

    await client.query('COMMIT');
    await audit('venta_comprobantes', 'INSERT', rows[0].id, { despues: { venta_id: id, nombre: archivo_nombre }, user_id: req.user.id });
    res.status(201).json({ ...rows[0], comprobante_financiera: comprobanteFinanciera });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
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
      `SELECT vc.archivo_data, vc.archivo_nombre, vc.archivo_tipo
         FROM venta_comprobantes vc
         JOIN ventas v ON v.id = vc.venta_id AND v.deleted_at IS NULL
        WHERE vc.id = $1`, [cid]
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

module.exports = router;
