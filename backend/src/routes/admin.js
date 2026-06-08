// Rutas administrativas — protegidas por adminOnly (req.user.role === 'admin').
// Endpoints para herramientas de operación que no son parte del flow normal:
//   - Disparar manualmente el check de invariantes (útil después de un fix
//     para verificar que el drift se resolvió).
//   - (Futuro) reset password de usuarios, listado de audit logs, etc.

const router = require('express').Router();
const adminOnly = require('../middleware/adminOnly');
const { runInvariantsCheck } = require('../jobs/invariantsJob');
const { evaluarTodos, resumir } = require('../lib/checkInvariants');
const { runBackfill } = require('../../scripts/backfill-caja-financiera');
const { runBackfill: runBackfillTarjetas } = require('../../scripts/backfill-caja-tarjetas');
const { invalidateCajas } = require('../lib/cajasCache');

// Todas las rutas de este módulo requieren rol admin (no solo permiso).
router.use(adminOnly);

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
router.get('/backfill-caja-financiera', async (_req, res, next) => {
  try {
    const result = await runBackfill({ apply: false, silent: true });
    res.json(result);
  } catch (err) {
    // El script throwea con mensaje claro si no hay caja FV (status 400 implícito).
    if (err.message && /es_financiera|Cajas → Config/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.post('/backfill-caja-financiera/apply', async (req, res, next) => {
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
    if (err.message && /es_financiera|Cajas → Config|negativo/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// ─── Backfill cajas-tarjeta ──────────────────────────────────────────────────
//
// Análogo al de Financiera pero para tarjetas. Reconstruye la trazabilidad
// histórica de cada caja-tarjeta (cada metodo_pago con es_tarjeta=true).
// Ver scripts/backfill-caja-tarjetas.js.
router.get('/backfill-caja-tarjetas', async (_req, res, next) => {
  try {
    const result = await runBackfillTarjetas({ apply: false, silent: true });
    res.json(result);
  } catch (err) {
    if (err.message && /es_tarjeta|Cajas → Config/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.post('/backfill-caja-tarjetas/apply', async (req, res, next) => {
  try {
    const result = await runBackfillTarjetas({ apply: true, silent: true, userId: req.user?.id ?? null });
    invalidateCajas();  // B1: ver comentario en /backfill-caja-financiera/apply
    res.json(result);
  } catch (err) {
    if (err.message && /es_tarjeta|Cajas → Config|negativo/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
