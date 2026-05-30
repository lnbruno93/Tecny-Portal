// Rutas administrativas — protegidas por adminOnly (req.user.role === 'admin').
// Endpoints para herramientas de operación que no son parte del flow normal:
//   - Disparar manualmente el check de invariantes (útil después de un fix
//     para verificar que el drift se resolvió).
//   - (Futuro) reset password de usuarios, listado de audit logs, etc.

const router = require('express').Router();
const adminOnly = require('../middleware/adminOnly');
const { runInvariantsCheck } = require('../jobs/invariantsJob');
const { evaluarTodos, resumir } = require('../lib/checkInvariants');

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

module.exports = router;
