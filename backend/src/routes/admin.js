// Rutas administrativas — protegidas por adminOnly (req.user.role === 'admin').
// Endpoints para herramientas de operación que no son parte del flow normal:
//   - Disparar manualmente el check de invariantes (útil después de un fix
//     para verificar que el drift se resolvió).
//   - (Futuro) reset password de usuarios, listado de audit logs, etc.

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const adminOnly = require('../middleware/adminOnly');
const { runInvariantsCheck } = require('../jobs/invariantsJob');
const { evaluarTodos, resumir } = require('../lib/checkInvariants');
const { runBackfill } = require('../../scripts/backfill-caja-financiera');
const { runBackfill: runBackfillTarjetas } = require('../../scripts/backfill-caja-tarjetas');
const { invalidateCajas } = require('../lib/cajasCache');
const { invalidateMetricas } = require('../lib/inventarioCache');
const db = require('../config/database');
const audit = require('../lib/audit');
const parseId = require('../lib/parseId');

// Todas las rutas de este módulo requieren rol admin (no solo permiso).
router.use(adminOnly);

// H1 (TANDA 1 trazab): rate-limit específico para los endpoints de backfill.
// Defensa adicional contra escenario "admin token leakeado" o un bug que dispare
// múltiples calls. Los backfills son operaciones pesadas (escanean toda la BD,
// reservan advisory lock) y no hay caso de uso legítimo de >5 calls en 5 min.
// Skipea en tests: las suites pueden invocar varias veces seguidas.
const isTestEnv = process.env.NODE_ENV === 'test';
const backfillLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas operaciones de backfill — esperá 5 minutos.' },
  skip: () => isTestEnv,
});

// H8 (TANDA 1 trazab): handler común. Antes cada endpoint hacía regex sobre
// err.message para detectar el 400; frágil si el copy cambia. Ahora confiamos
// en `err.status` (que los helpers ponen al throw) — patrón consistente con
// pagos.js / comprobantes.js. Fallback al regex SOLO mientras existan paths
// que aún throwean sin status (a deprecar en TANDA 4 Hygiene).
function handleBackfillError(err, res, next) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.message && /es_financiera|es_tarjeta|Cajas → Config|negativ/i.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
}

// GET /api/admin/invariants — corre el check on-demand y devuelve el reporte completo.
//
// A diferencia del job nocturno, este endpoint NO reporta a Sentry — es para
// inspección manual. Si querés gatillar la alerta (ej. para testear setup de
// Sentry), usar el job programado o llamar a runInvariantsCheck() en server.
router.get('/invariants', async (_req, res, next) => {
  try {
    const t0 = Date.now();
    const resultados = await evaluarTodos();
    const resumen = resumir(resultados);
    const elapsed_ms = Date.now() - t0;
    res.json({
      generado_en: new Date().toISOString(),
      elapsed_ms,
      resumen,
      // Resultados con un sample de violaciones por cada invariante violada.
      invariantes: resultados.map(r => ({
        id:          r.id,
        descripcion: r.descripcion,
        severity:    r.severity,
        ok:          r.ok,
        violaciones: r.violaciones.length,
        // Solo primer 10 para no inflar el response. Si querés más, query directo.
        muestras:    r.violaciones.slice(0, 10).map(v => v._fmt),
        ...(r.error && { error: r.error }),
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/invariants/run — corre el check Y dispara reporte a Sentry
// si hay violaciones (mismo path que el cron). Para testear que el Sentry
// pipeline funciona o forzar el reporte sin esperar el cron diario.
router.post('/invariants/run', async (_req, res, next) => {
  try {
    const result = await runInvariantsCheck();
    if (!result) return res.status(500).json({ error: 'Falló el check' });
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ─── Backfill caja Financiera ─────────────────────────────────────────────────
//
// Trazabilidad junio 2026: dos endpoints que disparan el script de backfill
// histórico (lib/scripts/backfill-caja-financiera.js) desde la UI admin.
// Reemplazan la necesidad de correr `node scripts/...` por SSH/Railway CLI.
//
//   GET  /api/admin/backfill-caja-financiera          → DRY-RUN, devuelve reporte JSON.
//   POST /api/admin/backfill-caja-financiera/apply    → APPLY, devuelve resultado.
//
// Ambos respetan `adminOnly` (req.user.role === 'admin'). El script ya está
// envuelto en transacción y valida saldo final >= 0 antes de COMMIT.
router.get('/backfill-caja-financiera', backfillLimiter, async (_req, res, next) => {
  try {
    const result = await runBackfill({ apply: false, silent: true });
    res.json(result);
  } catch (err) {
    handleBackfillError(err, res, next);
  }
});

router.post('/backfill-caja-financiera/apply', backfillLimiter, async (req, res, next) => {
  try {
    // B2 audit trail: el user_id del admin que dispara el backfill queda
    // estampado en cada caja_movimiento creado, para trazar quién lo corrió.
    const result = await runBackfill({ apply: true, silent: true, userId: req.user?.id ?? null });
    // B1 cache invalidation: cacheCajas tiene TTL 15s — sin esto, el siguiente
    // GET /cajas devuelve saldos viejos. invalidateCajas es process-local
    // (en multi-instance la otra réplica se entera al expirar el TTL — ok).
    invalidateCajas();
    res.json(result);
  } catch (err) {
    handleBackfillError(err, res, next);
  }
});

// ─── Backfill cajas-tarjeta ──────────────────────────────────────────────────
//
// Análogo al de Financiera pero para tarjetas. Reconstruye la trazabilidad
// histórica de cada caja-tarjeta (cada metodo_pago con es_tarjeta=true).
// Ver scripts/backfill-caja-tarjetas.js.
router.get('/backfill-caja-tarjetas', backfillLimiter, async (_req, res, next) => {
  try {
    const result = await runBackfillTarjetas({ apply: false, silent: true });
    res.json(result);
  } catch (err) {
    handleBackfillError(err, res, next);
  }
});

router.post('/backfill-caja-tarjetas/apply', backfillLimiter, async (req, res, next) => {
  try {
    const result = await runBackfillTarjetas({ apply: true, silent: true, userId: req.user?.id ?? null });
    invalidateCajas();  // B1: ver comentario en /backfill-caja-financiera/apply
    res.json(result);
  } catch (err) {
    handleBackfillError(err, res, next);
  }
});

// ─── Diagnóstico de stock ─────────────────────────────────────────────────────
// Surgió en testing pre-salida 2026-06-09: Lucas reportó productos que
// quedaron en estado='vendido' después de borrar la venta B2B que los descontó.
// Mi reproducción local del flujo (multi-item venta B2B → DELETE) restauró
// stock correctamente, pero los datos en prod mostraban lo contrario. Hacía
// falta una forma read-only de inspeccionar el historial completo de un
// producto sin abrir SQL directo contra la DB.
//
// GET /api/admin/diagnose-producto?imei=350909000000001  → busca por IMEI
// GET /api/admin/diagnose-producto?producto_id=123       → busca por ID
//
// Devuelve TODOS los productos que matchean (vivos y soft-deleted, porque al
// vaciar + reimportar pueden coexistir múltiples filas con el mismo IMEI), y
// para cada uno, el árbol completo de items_movimiento_cc que lo referencian
// con la info del movimiento padre (vivo o borrado).
router.get('/diagnose-producto', async (req, res, next) => {
  try {
    const { imei, producto_id } = req.query;
    let productos = [];
    if (producto_id) {
      const id = parseId(producto_id);
      if (!id) return res.status(400).json({ error: 'producto_id inválido' });
      const r = await db.query('SELECT * FROM productos WHERE id = $1', [id]);
      productos = r.rows;
    } else if (imei && typeof imei === 'string' && imei.trim()) {
      // Sin filtro deleted_at: queremos ver también los soft-deleted (huérfanos
      // de vaciados + reimportaciones).
      const r = await db.query(
        'SELECT * FROM productos WHERE imei = $1 ORDER BY id DESC',
        [imei.trim()]
      );
      productos = r.rows;
    } else {
      return res.status(400).json({ error: 'Pasá imei o producto_id como query param' });
    }

    if (productos.length === 0) {
      return res.json({ productos: [], movimientos_cc: [] });
    }

    // Cargar todos los items_movimiento_cc + movimiento_cc relacionados
    // a estos producto_id en una sola query. JOIN al movimiento incluye
    // borrados (sin filtrar deleted_at).
    const prodIds = productos.map(p => p.id);
    const { rows: trail } = await db.query(
      `SELECT
         i.id              AS item_id,
         i.movimiento_cc_id,
         i.producto_id,
         i.cantidad        AS item_cantidad,
         i.valor           AS item_valor,
         i.producto        AS item_producto_txt,
         i.imei_serial,
         m.id              AS mov_id,
         m.cliente_cc_id,
         m.fecha           AS mov_fecha,
         m.tipo            AS mov_tipo,
         m.monto_total     AS mov_monto,
         m.caja_id         AS mov_caja_id,
         m.created_at      AS mov_created_at,
         m.deleted_at      AS mov_deleted_at,
         m.created_by_user_id AS mov_created_by,
         c.nombre          AS cliente_nombre,
         c.apellido        AS cliente_apellido
       FROM items_movimiento_cc i
       JOIN movimientos_cc m  ON m.id = i.movimiento_cc_id
       LEFT JOIN clientes_cc c ON c.id = m.cliente_cc_id
       WHERE i.producto_id = ANY($1::int[])
       ORDER BY m.created_at DESC, i.id DESC`,
      [prodIds]
    );

    res.json({
      productos: productos.map(p => ({
        id: p.id,
        nombre: p.nombre,
        imei: p.imei,
        clase: p.clase,
        cantidad: Number(p.cantidad),
        estado: p.estado,
        costo: p.costo,
        costo_moneda: p.costo_moneda,
        precio_venta: p.precio_venta,
        precio_moneda: p.precio_moneda,
        created_at: p.created_at,
        deleted_at: p.deleted_at,
      })),
      movimientos_cc: trail,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Restaurar producto al stock (limpieza puntual) ───────────────────────────
// Compañero del diagnose. Usar SOLO cuando ya diagnosticamos que un producto
// quedó incorrectamente en 'vendido' y necesitamos restaurarlo sin tener que
// reimportar todo el inventario. Audit log obligatorio (incluye `reason` del
// admin para trazabilidad) e invalida cache de métricas.
//
// POST body: { producto_id: number, cantidad?: number = 1, reason: string }
router.post('/restore-producto', async (req, res, next) => {
  const { producto_id, cantidad: cantBody, reason } = req.body || {};
  // parseId requiere string; el body JSON puede mandar number. Coerción defensiva.
  const id = parseId(producto_id == null ? '' : String(producto_id));
  if (!id) return res.status(400).json({ error: 'producto_id inválido' });
  const cantidad = Number.isFinite(Number(cantBody)) && Number(cantBody) > 0 ? Number(cantBody) : 1;
  if (typeof reason !== 'string' || reason.trim().length < 5) {
    return res.status(400).json({ error: 'reason es obligatorio (mínimo 5 caracteres) para auditoría' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: pre } = await client.query(
      'SELECT * FROM productos WHERE id = $1 FOR UPDATE', [id]
    );
    if (!pre[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    if (pre[0].deleted_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Producto está soft-deleted. Restaurarlo manualmente desde Inventario antes.' });
    }
    const { rows: post } = await client.query(
      `UPDATE productos
         SET cantidad = $2, estado = 'disponible'
         WHERE id = $1
         RETURNING *`,
      [id, cantidad]
    );
    // audit_logs.accion tiene CHECK constraint a INSERT/UPDATE/DELETE.
    // Usamos UPDATE (semánticamente correcto: cambia estado+cantidad) y
    // marcamos el origen del UPDATE en `_origen: 'admin_restore'` dentro del
    // JSONB para que sea filtrable en queries de auditoría.
    await audit(client, 'productos', 'UPDATE', id, {
      antes: { cantidad: pre[0].cantidad, estado: pre[0].estado },
      despues: { cantidad: post[0].cantidad, estado: post[0].estado },
      user_id: req.user.id,
      _origen: 'admin_restore',
      _reason: reason.trim(),
    });
    await client.query('COMMIT');
    invalidateMetricas();
    res.json({ ok: true, producto: post[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
