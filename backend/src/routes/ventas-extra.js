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
const fileStore = require('../lib/fileStore');
const storageFlags = require('../lib/storageFlags');
const {
  etiquetaSchema, garantiaSchema, updateGarantiaSchema, comprobanteVentaSchema,
  createVentaRapidaSchema, updateVentaRapidaSchema,
} = require('../schemas/ventas');

router.use(requireAuth);

/* ═══════════════════════ ETIQUETAS ═══════════════════════ */

router.get('/etiquetas', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query('SELECT * FROM etiquetas WHERE deleted_at IS NULL ORDER BY nombre');
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/etiquetas', validate(etiquetaSchema), async (req, res, next) => {
  try {
    const { nombre, color } = req.body;
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'INSERT INTO etiquetas (nombre, color) VALUES ($1,$2) RETURNING *', [nombre, color ?? null]
      );
      await audit(client, 'etiquetas', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
      return rows[0];
    });
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una etiqueta con ese nombre' });
    next(err);
  }
});

router.delete('/etiquetas/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE etiquetas SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
      );
      if (!rows[0]) return null;
      await audit(client, 'etiquetas', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Etiqueta no encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ═══════════════════════ MÉTODOS DE PAGO ═══════════════════════ */

// Auditoría 2026-06-30 Q-02/Q-03: antes `SELECT *` filtraba `saldo_inicial`
// (info sensible — saldo de apertura de la caja) en la respuesta. El endpoint
// /api/metodos-pago (lite, sin gate de capability) ya usa un whitelist
// explícito; alineamos este endpoint a ese mismo shape para evitar el leak y
// dejar UN solo contrato de columnas. Los callers del frontend (Ventas.jsx vía
// `ventas.metodosPago()`) sólo consumen id/nombre/moneda/es_financiera/
// es_tarjeta/comision_pct — sin regresión funcional.
router.get('/metodos-pago', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, nombre, moneda, es_financiera, es_tarjeta, comision_pct, orden
           FROM metodos_pago
          WHERE deleted_at IS NULL AND activo = true
          ORDER BY orden, nombre`
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

/* ═══════════════════════ PLANTILLAS DE GARANTÍA ═══════════════════════ */

router.get('/garantias', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT id, nombre, texto, es_default FROM plantillas_garantia WHERE deleted_at IS NULL ORDER BY es_default DESC, nombre'
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/garantias', validate(garantiaSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { nombre, texto, es_default } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    if (es_default) await client.query('UPDATE plantillas_garantia SET es_default = false WHERE es_default = true');
    const { rows } = await client.query(
      'INSERT INTO plantillas_garantia (nombre, texto, es_default) VALUES ($1,$2,$3) RETURNING id, nombre, texto, es_default',
      [nombre, texto, !!es_default]
    );
    await audit(client, 'plantillas_garantia', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
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
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const { rows: before } = await client.query('SELECT * FROM plantillas_garantia WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Garantía no encontrada' }); }
    const { nombre, texto, es_default } = req.body;
    if (es_default) await client.query('UPDATE plantillas_garantia SET es_default = false WHERE es_default = true AND id <> $1', [id]);
    const { rows } = await client.query(
      `UPDATE plantillas_garantia SET nombre = COALESCE($1, nombre), texto = COALESCE($2, texto), es_default = COALESCE($3, es_default)
       WHERE id = $4 RETURNING id, nombre, texto, es_default`,
      [nombre, texto, es_default, id]
    );
    await audit(client, 'plantillas_garantia', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
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
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE plantillas_garantia SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
      );
      if (!rows[0]) return null;
      await audit(client, 'plantillas_garantia', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Garantía no encontrada' });
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
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const ventaRes = await client.query(
      'SELECT id, estado FROM ventas WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!ventaRes.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Venta no encontrada' }); }
    const venta = ventaRes.rows[0];

    const { archivo_data, archivo_nombre, archivo_tipo } = req.body;
    // P-03 Fase 5: bifurcación de upload por feature flag (mismo patrón que
    // comprobantes Financiera en Fase 3 y productos.foto en Fase 4).
    //   Flag ON + STORAGE_DRIVER=r2 → fileStore.put sube el blob a R2 y devuelve
    //     `{ data: null, key: '...' }`. INSERT guarda key+size, archivo_data NULL.
    //   Flag OFF o driver=db → bypass al path legacy (base64 directo a
    //     archivo_data). Preserva el comportamiento pre-fase-5 exacto.
    // Reads (GET /comprobantes/:cid) usan fileStore.get con fallback automático.
    const useR2 = fileStore._DRIVER === 'r2'
               && await storageFlags.isEnabled('storage_r2_ventas_comprobantes');

    let file;
    if (useR2) {
      file = await fileStore.put({
        tenantId: req.tenantId,  // PR 5 multi-tenant: prefix t{tenantId}/ en la key R2
        dataBase64: archivo_data ?? null,
        filename: archivo_nombre ?? null,
        mime: archivo_tipo ?? null,
        entity: 'venta-comprobantes',
        subpath: `venta-${id}`,
      });
    } else {
      file = {
        data: archivo_data ?? null,
        key: null,
        size: null,
        nombre: archivo_nombre ?? null,
        tipo: archivo_tipo ?? null,
      };
    }

    const { rows } = await client.query(
      `INSERT INTO venta_comprobantes
        (venta_id, archivo_data, archivo_nombre, archivo_tipo, archivo_key, archivo_size)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, archivo_nombre, archivo_tipo, created_at`,
      [id, file.data, file.nombre, file.tipo, file.key, file.size]
    );

    // Reconciliar el comprobante de Financiera (única fuente de verdad): si la venta
    // está activa y tiene un pago con la caja financiera, lo crea/recalcula con la
    // comisión = monto × pct_financiera (de Config), sin duplicar.
    const comprobanteFinanciera = await syncFinancieraComprobante(client, id, venta.estado);
    if (comprobanteFinanciera) {
      // Audit-in-tx (patrón H6) — auditoría 2026-06-06 Sol H1.
      // Antes pasaba `audit(...)` sin `client` (pool global, autocommit) →
      // si el proceso moría entre las líneas 160 y 163, quedaba el audit_log
      // persistido pero el comprobante no existía (rollback). Ahora atómico.
      await audit(client, 'comprobantes', 'INSERT', comprobanteFinanciera.id, { despues: { venta_id: id, auto: true, monto: comprobanteFinanciera.monto, monto_financiera: comprobanteFinanciera.monto_financiera }, user_id: req.user.id });
    }
    // Mismo fix para el audit de venta_comprobantes — debe ir DENTRO de la tx,
    // antes del COMMIT. Auditoría 2026-06-06 Sol M2.
    await audit(client, 'venta_comprobantes', 'INSERT', rows[0].id, { despues: { venta_id: id, nombre: archivo_nombre }, user_id: req.user.id });

    await client.query('COMMIT');
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
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, archivo_nombre, archivo_tipo, created_at
           FROM venta_comprobantes
          WHERE venta_id = $1 AND deleted_at IS NULL
          ORDER BY id`,
        [id]
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/comprobantes/:cid', async (req, res, next) => {
  try {
    const cid = parseId(req.params.cid);
    if (!cid) return res.status(400).json({ error: 'ID inválido' });
    // P-03 Fase 5: la lectura pasa por fileStore. Driver db lee archivo_data
    // directo. Driver r2 chequea primero archivo_key (baja de R2) y hace
    // fallback a archivo_data para filas legacy. Shape del response
    // { archivo_data, archivo_nombre, archivo_tipo } NO cambia — frontend
    // intacto. archivo_key se incluye en el SELECT para que el driver r2
    // pueda decidir el path.
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT vc.archivo_data, vc.archivo_key, vc.archivo_nombre, vc.archivo_tipo
           FROM venta_comprobantes vc
           JOIN ventas v ON v.id = vc.venta_id AND v.deleted_at IS NULL
          WHERE vc.id = $1 AND vc.deleted_at IS NULL`, [cid]
      );
      return rows[0] || null;
    });
    if (!row) return res.status(404).json({ error: 'Comprobante no encontrado' });
    const file = await fileStore.get(row, { prefix: 'archivo' });
    if (!file) return res.status(404).json({ error: 'Comprobante no encontrado' });
    res.json({ archivo_data: file.data, archivo_nombre: file.nombre, archivo_tipo: file.tipo });
  } catch (err) { next(err); }
});

/* ═══════════════════════ VENTAS RÁPIDAS ═══════════════════════ */

router.get('/ventas-rapidas', async (req, res, next) => {
  try {
    const { estado } = req.query;
    const params = [];
    let filter = '';
    if (estado === 'pendiente' || estado === 'procesada') { params.push(estado); filter = ` AND estado = $1`; }
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM ventas_rapidas WHERE deleted_at IS NULL${filter} ORDER BY fecha DESC, id DESC LIMIT 200`, params
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/ventas-rapidas', validate(createVentaRapidaSchema), async (req, res, next) => {
  try {
    const { vendedor_id, vendedor_nombre, cliente_texto, detalle, fecha, hora } = req.body;
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO ventas_rapidas (vendedor_id, vendedor_nombre, cliente_texto, detalle, fecha, hora, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [vendedor_id ?? null, vendedor_nombre ?? null, cliente_texto ?? null, detalle, fecha, hora ?? null, req.user.id]
      );
      await audit(client, 'ventas_rapidas', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
      return rows[0];
    });
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.put('/ventas-rapidas/:id', validate(updateVentaRapidaSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const result = await db.withTenant(req.tenantId, async (client) => {
      const { rows: before } = await client.query('SELECT * FROM ventas_rapidas WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!before[0]) return { notFound: true };
      const { detalle, cliente_texto, vendedor_nombre, estado, venta_id } = req.body;
      const { rows } = await client.query(
        `UPDATE ventas_rapidas SET
           detalle         = COALESCE($1, detalle),
           cliente_texto   = COALESCE($2, cliente_texto),
           vendedor_nombre = COALESCE($3, vendedor_nombre),
           estado          = COALESCE($4, estado),
           venta_id        = COALESCE($5, venta_id)
         WHERE id = $6 RETURNING *`,
        [detalle, cliente_texto, vendedor_nombre, estado, venta_id, id]
      );
      await audit(client, 'ventas_rapidas', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
      return { row: rows[0] };
    });
    if (result.notFound) return res.status(404).json({ error: 'Venta rápida no encontrada' });
    res.json(result.row);
  } catch (err) { next(err); }
});

router.delete('/ventas-rapidas/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE ventas_rapidas SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
      );
      if (!rows[0]) return null;
      await audit(client, 'ventas_rapidas', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Venta rápida no encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
