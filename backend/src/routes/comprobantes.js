const router = require('express').Router();
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const parseId = require('../lib/parseId');
const { computeNeto } = require('../lib/money');
const { postCajaMovimientoFinanciera } = require('../lib/financiera');
const { reverseCajaMovimientos } = require('../lib/cajaLedger');
const fileStore = require('../lib/fileStore');
const storageFlags = require('../lib/storageFlags');
const {
  createComprobanteSchema, queryComprobantesSchema,
  createManualComprobanteSchema, updateManualComprobanteSchema,
} = require('../schemas/comprobantes');

// Rate limit dedicado para el ZIP export: arma un paquete con los archivos del
// período (potencialmente cientos de MB). 10/15min/usuario es generoso para uso
// real (mensual al contador) y suficiente piso contra scripts que iteren períodos.
const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id != null
    ? `comprob-export:${req.user.id}`
    : `comprob-export:ip:${ipKeyGenerator(req)}`,
  message: { error: 'Demasiadas descargas masivas. Probá de nuevo en unos minutos.' },
});

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

    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(`
        SELECT
          COUNT(*)                        AS count,
          COALESCE(SUM(c.monto),            0) AS total_monto,
          COALESCE(SUM(c.monto_financiera), 0) AS total_financiera,
          COALESCE(SUM(c.monto_neto),       0) AS total_neto
        FROM comprobantes c
        LEFT JOIN vendedores v ON v.id = c.vendedor_id
        ${where} AND c.deleted_at IS NULL
      `, params);
      return rows;
    });

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

    const { countRes, dataRes } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(`SELECT COUNT(*) ${baseQuery}`, params);
      const dataRes = await client.query(
        // Columnas explícitas SIN archivo_data (base64): no debe viajar en el listado.
        // El archivo se sirve aparte por GET /:id/archivo. tiene_archivo indica si hay
        // adjunto en CUALQUIERA de los dos backends — archivo_data (legacy) o
        // archivo_key (R2, P-03 Fase 3+).
        `SELECT c.id, c.fecha, c.cliente, c.vendedor_id, c.monto, c.monto_financiera, c.monto_neto,
                c.referencia, c.archivo_nombre, c.archivo_tipo, c.venta_id, c.created_at,
                (c.archivo_data IS NOT NULL OR c.archivo_key IS NOT NULL) AS tiene_archivo,
                v.nombre AS vendedor_nombre
         ${baseQuery}
         ORDER BY c.fecha DESC, c.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      return { countRes, dataRes };
    });

    const total = parseInt(countRes.rows[0].count);
    res.json(paginatedResponse(dataRes.rows, total, { page, limit }));
  } catch (err) {
    next(err);
  }
});

// ─── Crear ────────────────────────────────────────────────────────────────────
router.post('/', validate(createComprobanteSchema), async (req, res, next) => {
  // Antes: el INSERT no estaba en tx y no impactaba caja_movimientos. Junio
  // 2026: trazabilidad Financiera → toda carga de comprobante (genérico o
  // manual) genera un ingreso de `monto_neto` en la caja `es_financiera=true`.
  // Misma tx para que si el postCajaMovimientoFinanciera falla (ej. no hay
  // caja FV configurada), el comprobante no quede huérfano.
  const client = await db.connect();
  try {
    const { fecha, cliente, vendedor_id, monto, monto_financiera, monto_neto, referencia, archivo_data, archivo_nombre, archivo_tipo } = req.body;
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // P-03 Fase 3: bifurcación de upload por feature flag.
    //   Si flag `storage_r2_comprobantes` ON + STORAGE_DRIVER=r2 → fileStore.put
    //   sube el blob a R2 y devuelve `{ data: null, key: '...' }`. El INSERT
    //   guarda key+size en las columnas nuevas y `archivo_data` queda NULL.
    //
    //   Si flag OFF o driver=db → bypass al path legacy: el base64 va directo
    //   a la columna `archivo_data` sin tocar R2 (preserva el comportamiento
    //   pre-fase-3 exacto). Eso permite que el deploy con flag OFF no cambie
    //   nada en producción hasta que el admin lo prenda explícitamente.
    //
    // Reads (GET /:id/archivo y GET /export-zip) usan fileStore.get/stream que
    // tienen fallback automático: si la fila tiene archivo_key → R2, sino
    // → archivo_data. Por eso flippear el flag NO rompe el acceso a uploads
    // anteriores.
    // 2026-07-20 F3 Rec proactiva #3: pasamos `req.tenantId` para que el
    // resolver aplique overrides tenant/plan/rollout (canary R2 por tenant
    // antes del rollout global).
    const useR2 = fileStore._DRIVER === 'r2'
               && await storageFlags.isEnabled('storage_r2_comprobantes', req.tenantId);

    let file;
    if (useR2) {
      file = await fileStore.put({
        tenantId: req.tenantId,  // PR 5 multi-tenant: prefix t{tenantId}/ en la key R2
        dataBase64: archivo_data ?? null,
        filename: archivo_nombre ?? null,
        mime: archivo_tipo ?? null,
        entity: 'comprobantes',
      });
    } else {
      // Path legacy — sin fileStore para evitar overhead. Mismo shape de
      // resultado para que el INSERT sea idéntico abajo.
      file = {
        data: archivo_data ?? null,
        key: null,
        size: null,
        nombre: archivo_nombre ?? null,
        tipo: archivo_tipo ?? null,
      };
    }

    const { rows } = await client.query(
      `INSERT INTO comprobantes
        (fecha, cliente, vendedor_id, monto, monto_financiera, monto_neto, referencia,
         archivo_data, archivo_nombre, archivo_tipo, archivo_key, archivo_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [fecha, cliente, vendedor_id ?? null, monto, monto_financiera, monto_neto ?? monto, referencia ?? null,
       file.data, file.nombre, file.tipo, file.key, file.size]
    );
    const compId = rows[0].id;
    const netoMov = Number(monto_neto ?? monto);

    // Ingreso en caja FV. Si no hay caja `es_financiera=true`, throwea con
    // mensaje claro al operador y el comprobante se rollbackea.
    await postCajaMovimientoFinanciera(client, {
      tipo: 'ingreso',
      fecha,
      monto: netoMov,
      ref_tabla: 'comprobantes',
      ref_id: compId,
      concepto: `Comprobante · ${cliente}${referencia ? ' · ' + referencia : ''}`,
      user_id: req.user.id,
    });

    // Excluir el base64 del audit (infla la tabla) y de la respuesta (el cliente ya lo tiene)
    const { archivo_data: _blob, ...comprobante } = rows[0];
    await audit(client, 'comprobantes', 'INSERT', compId, { despues: comprobante, user_id: req.user.id });
    await client.query('COMMIT');
    res.status(201).json(comprobante);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

// ─── Comprobante manual (venta previa al sistema) ────────────────────────────
// Réplica del modelo "cobro previo" de Tarjetas. Carga un comprobante con
// venta_id=NULL — para ventas históricas donde el cliente pagó con la caja
// Financiera pero la venta no está en el sistema.
//
// Junio 2026: AHORA impacta caja_movimientos. La decisión original ("no impacta
// caja, no hay venta real") rompía trazabilidad — el operador tenía dinero
// REAL entrando a la caja Financiera y el saldo del libro caja no lo reflejaba.
// Ahora se postea un ingreso de `monto_neto` en la caja `es_financiera=true`,
// con `ref_tabla='comprobantes'` para que reverseCajaMovimientos lo revierta
// al borrar/editar.
router.post('/manuales', validate(createManualComprobanteSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { fecha, cliente, vendedor_id, monto_bruto, pct, referencia } = req.body;
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

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
    const compId = rows[0].id;

    await postCajaMovimientoFinanciera(client, {
      tipo: 'ingreso',
      fecha,
      monto: neto,
      ref_tabla: 'comprobantes',
      ref_id: compId,
      concepto: `Venta previa · ${cliente}${referencia ? ' · ' + referencia : ''}`,
      user_id: req.user.id,
    });

    await audit(client, 'comprobantes', 'INSERT', compId, {
      despues: rows[0], tipo: 'manual_venta_previa', pct_aplicado: pctFinal,
      user_id: req.user.id,
    });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
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
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
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

    // Recalcular montos solo si el body trae monto_bruto o pct. Si solo se
    // editan metadatos (cliente, vendedor, referencia, fecha), preservamos
    // los montos originales — antes el PATCH siempre recomputaba con el pct
    // global actual de config, lo que cambiaba el neto al editar solo el
    // cliente si la config había cambiado desde la carga original.
    //
    // Trazabilidad junio 2026: este fix es clave porque ahora el caja_movimiento
    // en FV se revierte/repostea cuando cambia el neto. Sin esta guarda, editar
    // solo el cliente movería el saldo de la caja FV sin razón.
    const recalcMontos = (body.monto_bruto !== undefined) || (body.pct !== undefined);
    let bruto, pctFinal, comision, neto;
    if (recalcMontos) {
      const pctEfectivo = await resolverPctFinanciera(client, body.pct);
      const brutoInput  = body.monto_bruto ?? cur.monto;
      ({ bruto, pct: pctFinal, comision, neto } = computeNeto(brutoInput, pctEfectivo));
    } else {
      bruto    = Number(cur.monto);
      comision = Number(cur.monto_financiera);
      neto     = Number(cur.monto_neto);
      pctFinal = null; // no aplica — no recalculamos
    }

    const { rows } = await client.query(
      `UPDATE comprobantes
          SET fecha = $2, cliente = $3, vendedor_id = $4, monto = $5,
              monto_financiera = $6, monto_neto = $7, referencia = $8
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, fecha, cliente, vendedor_id, monto, monto_financiera,
                  monto_neto, referencia, venta_id, created_at`,
      [id, fecha, cliente, vendedor_id, bruto, comision, neto, referencia]
    );

    // Trazabilidad caja FV: si cambió el neto o la fecha, revertimos el
    // caja_movimiento viejo y posteamos uno nuevo. Si solo cambiaron campos
    // de metadata (cliente, referencia, vendedor), no tocamos la caja.
    const netoCambio  = Number(cur.monto_neto) !== neto;
    const fechaCambio = String(cur.fecha).slice(0, 10) !== String(fecha).slice(0, 10);
    if (netoCambio || fechaCambio) {
      await reverseCajaMovimientos(client, 'comprobantes', id);
      await postCajaMovimientoFinanciera(client, {
        tipo: 'ingreso',
        fecha,
        monto: neto,
        ref_tabla: 'comprobantes',
        ref_id: id,
        concepto: `Venta previa (editado) · ${cliente}${referencia ? ' · ' + referencia : ''}`,
        user_id: req.user.id,
      });
    }

    await audit(client, 'comprobantes', 'UPDATE', id, {
      antes: cur, despues: rows[0], pct_aplicado: pctFinal, user_id: req.user.id,
    });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
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
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
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
    // Revertir el caja_movimiento en caja FV (si existe — los comprobantes
    // pre-junio 2026 no tienen mov asociado, así que reverseCajaMovimientos
    // es no-op para ellos).
    await reverseCajaMovimientos(client, 'comprobantes', id);

    const { archivo_data: _blob, ...comprobante } = rows[0];
    await audit(client, 'comprobantes', 'DELETE', id, { antes: comprobante, user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

// ─── Archivo adjunto ──────────────────────────────────────────────────────────
router.get('/:id/archivo', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // P-03 Fase 3: la lectura pasa por fileStore. Driver db lee archivo_data
    // directo. Driver r2 chequea primero archivo_key (baja de R2 si existe)
    // y hace fallback a archivo_data para filas legacy. El shape del response
    // { data, nombre, tipo } no cambia — frontend intacto. archivo_key se
    // incluye en el SELECT para que el driver r2 pueda decidir el path.
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT archivo_data, archivo_key, archivo_nombre, archivo_tipo FROM comprobantes WHERE id = $1 AND deleted_at IS NULL',
        [id]
      );
      return rows;
    });
    if (!rows[0]) return res.status(404).json({ error: 'Archivo no encontrado' });
    const file = await fileStore.get(rows[0], { prefix: 'archivo' });
    if (!file) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.json(file);
  } catch (err) {
    next(err);
  }
});

// ─── Export ZIP: archivos del período + manifest CSV ──────────────────────────
//
// Devuelve un .zip stream con:
//   · Un archivo por cada comprobante del período que tenga `archivo_data`,
//     nombrado `YYYY-MM-DD_cliente_id.{ext}` (ext detectada del MIME).
//   · `_manifest.csv` con la grilla de comprobantes (id, fecha, cliente,
//     vendedor, referencia, montos, archivo) — sirve para cruzar contra
//     planillas del contador.
//
// Diseño:
//   · Stream — no buffereamos el ZIP completo en memoria. Para un período de
//     ~300 comprobantes × 1MB c/u (300MB), la RAM del proceso queda en MB
//     bajos, no en cientos.
//   · Filtros idénticos a GET /api/comprobantes (desde, hasta, vendedor, buscar)
//     para que el ZIP coincida exactamente con lo que el usuario está viendo.
//   · Trae `archivo_data` (la única query que lo hace en este módulo además del
//     archivo individual). Si el período tiene mucho contenido, esta query
//     puede tardar — `query_timeout` 15s a nivel del pool actúa como techo.
router.get('/export-zip', exportLimiter, validate(queryComprobantesSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta, vendedor, buscar } = req.query;
    let where = 'WHERE c.deleted_at IS NULL';
    const params = [];

    if (desde)   { params.push(desde);    where += ` AND c.fecha >= $${params.length}`; }
    if (hasta)   { params.push(hasta);    where += ` AND c.fecha <= $${params.length}`; }
    if (vendedor){ params.push(vendedor); where += ` AND v.nombre = $${params.length}`; }
    if (buscar)  {
      params.push(`%${buscar}%`);
      where += ` AND (c.cliente ILIKE $${params.length} OR c.referencia ILIKE $${params.length})`;
    }

    // 2026-06-11 SE-10: cap defensivo. Antes este endpoint cargaba TODOS los
    // comprobantes que matcheaban filtros en RAM (cada uno con su archivo_data
    // base64 = 1-5 MB). Un filtro amplio con 1000+ comprobantes podía explotar
    // la RAM del proceso (Railway Hobby = 512MB-1GB). Pre-count para rechazar
    // queries demasiado amplias con un mensaje claro al operador.
    const EXPORT_CAP = 1000;
    const { countN, rows } = await db.withTenant(req.tenantId, async (client) => {
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS n FROM comprobantes c LEFT JOIN vendedores v ON v.id = c.vendedor_id ${where}`,
        params
      );
      const countN = countRows[0].n;
      if (countN > EXPORT_CAP) {
        return { countN, rows: null };
      }
      // P-03 Fase 3: incluir archivo_key para que fileStore.stream pueda decidir
      // entre R2 (si key existe) y legacy (archivo_data). Con driver r2 y filas
      // migradas, el stream sale directo del GetObjectResponse sin materializar
      // el blob a memoria del proceso (mejora picos de RAM en exports grandes).
      const { rows } = await client.query(`
        SELECT c.id, c.fecha, c.cliente, v.nombre AS vendedor, c.referencia,
               c.monto, c.monto_financiera, c.monto_neto,
               c.archivo_data, c.archivo_key, c.archivo_nombre, c.archivo_tipo
        FROM comprobantes c
        LEFT JOIN vendedores v ON v.id = c.vendedor_id
        ${where}
        ORDER BY c.fecha ASC, c.id ASC
      `, params);
      return { countN, rows };
    });
    if (countN > EXPORT_CAP) {
      return res.status(400).json({
        error: `El filtro matchea ${countN} comprobantes (máximo ${EXPORT_CAP}). Restringí el período o el cliente.`,
      });
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No hay comprobantes en el período seleccionado.' });
    }

    // Headers de descarga ANTES de escribir contenido. Si después algo falla en
    // medio del stream el response ya está commiteado, pero al menos el browser
    // ofrece guardar lo descargado. Nombre del archivo refleja el rango.
    const rangeTag = desde && hasta
      ? `${desde}_${hasta}`
      : (desde || hasta || new Date().toISOString().slice(0, 10));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="comprobantes_${rangeTag}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });

    // En caso de error del archiver, abortamos el response. El browser ve la
    // descarga truncada pero el cliente ya tiene los bytes que llegaron.
    archive.on('error', (err) => {
      // No podemos res.status() acá (headers ya enviados) — solo log + abort.
      req.log?.error({ err }, 'export-zip: archiver error');
      try { res.destroy(err); } catch { /* ignore */ }
    });
    archive.pipe(res);

    // Manifest CSV (BOM UTF-8 para que Excel lo abra con tildes bien).
    const csvLines = ['id,fecha,cliente,vendedor,referencia,monto,monto_financiera,monto_neto,archivo'];
    const usedNames = new Set();

    for (const c of rows) {
      const fechaIso = c.fecha instanceof Date
        ? c.fecha.toISOString().slice(0, 10)
        : String(c.fecha).slice(0, 10);
      // Si hay archivo: lo metemos al zip con nombre derivado de fecha+cliente+id.
      // El cliente puede tener tildes/espacios/slash; sanitizamos.
      let nombreArchivo = '';
      if (c.archivo_data) {
        const ext = extensionFromMime(c.archivo_tipo) || extensionFromFilename(c.archivo_nombre) || 'bin';
        const clienteSlug = String(c.cliente || 'sin-cliente')
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-zA-Z0-9_-]+/g, '_')
          .slice(0, 40)
          .replace(/^_+|_+$/g, '');
        let candidato = `${fechaIso}_${clienteSlug || 'sin-cliente'}_${c.id}.${ext}`;
        // Defensa contra colisión (improbable porque incluye id, pero por las dudas)
        let n = 1;
        while (usedNames.has(candidato)) {
          candidato = `${fechaIso}_${clienteSlug || 'sin-cliente'}_${c.id}_${n}.${ext}`;
          n++;
        }
        usedNames.add(candidato);
        nombreArchivo = candidato;
        // P-03 Fase 1: stream en lugar de Buffer. Driver db wrappea el base64
        // en un Readable de un solo chunk (footprint similar al buffer). Driver
        // r2 (Fase 2+) devolverá el stream del GetObjectResponse directo, lo
        // que va a reducir picos de RAM en exports grandes.
        const stream = await fileStore.stream(c, { prefix: 'archivo' });
        archive.append(stream, { name: candidato });
      }
      // CSV row — escape mínimo (comillas dobles cuando hay comas o quotes).
      csvLines.push([
        c.id,
        fechaIso,
        csvEscape(c.cliente),
        csvEscape(c.vendedor),
        csvEscape(c.referencia),
        c.monto,
        c.monto_financiera,
        c.monto_neto,
        csvEscape(nombreArchivo),
      ].join(','));
    }

    // BOM + CSV. El BOM (EF BB BF) hace que Excel lo abra como UTF-8.
    archive.append('﻿' + csvLines.join('\n'), { name: '_manifest.csv' });
    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

// Helpers locales para el ZIP export (no usados en otro lado).
function extensionFromMime(mime) {
  if (!mime) return null;
  const m = String(mime).toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('heic')) return 'heic';
  return null;
}
function extensionFromFilename(name) {
  if (!name) return null;
  const dot = String(name).lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}
function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

module.exports = router;
