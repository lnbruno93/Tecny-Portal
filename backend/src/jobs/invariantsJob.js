// Job nocturno que valida invariantes de integridad financiera.
//
// Por qué setInterval interno y no pg_cron / Railway Scheduler:
//   - Cero infra extra. Single-instance only — cuando escalemos a múltiples
//     workers, migrar a Railway Scheduler con advisory lock entre workers.
//   - Mismo patrón que startPurgaJob en lib/audit.js (precedente del proyecto).
//
// Frecuencia: cada 24h, default 03:00 UTC (madrugada AR). Si una corrida tarda
// >5 min, el siguiente intervalo lo encuentra ya terminado.
//
// Política de alerta:
//   - Si hay violaciones de severity 'critica': Sentry captureException (error).
//   - Si hay solo 'alta' o 'media': Sentry captureMessage (warning).
//   - Siempre: log estructurado con resumen.

const logger = require('../lib/logger');
const { evaluarTodos, resumir } = require('../lib/checkInvariants');
const { withAdvisoryLock } = require('../lib/withAdvisoryLock');

async function runInvariantsCheck() {
  const t0 = Date.now();
  let resultados;
  try {
    resultados = await evaluarTodos();
  } catch (err) {
    // Fallo total del evaluador — Promise.all interno no debería tirar,
    // pero defendemos por las dudas.
    logger.error({ err }, 'invariants check — fallo del evaluador');
    reportToSentry(err, { fatal: true });
    return null;
  }

  const resumen = resumir(resultados);
  const elapsed_ms = Date.now() - t0;
  const log = { resumen, elapsed_ms };

  if (resumen.violados === 0 && resumen.con_error === 0) {
    logger.info(log, 'invariants check — OK, todas las invariantes pasan');
    return { resumen, resultados, elapsed_ms };
  }

  // Hay algo: detalle de cada invariante violada (top 5 violaciones c/u).
  const detalle = resultados
    .filter(r => !r.ok || r.error)
    .map(r => ({
      id:          r.id,
      severity:    r.severity,
      violaciones: r.violaciones.length,
      muestras:    r.violaciones.slice(0, 5).map(v => v._fmt),
      ...(r.error && { error: r.error }),
    }));

  if (resumen.por_severity.critica > 0) {
    logger.error({ ...log, detalle }, 'invariants check — VIOLACIONES CRÍTICAS detectadas');
    reportToSentry(
      new Error(`Invariants check: ${resumen.por_severity.critica} crítica(s) violadas`),
      { resumen, detalle, level: 'error' }
    );
  } else {
    logger.warn({ ...log, detalle }, 'invariants check — violaciones detectadas');
    reportToSentry(
      `Invariants check: ${resumen.violados} invariante(s) con violaciones`,
      { resumen, detalle, level: 'warning' }
    );
  }

  return { resumen, resultados, elapsed_ms };
}

function reportToSentry(errOrMsg, { resumen, detalle, level, fatal } = {}) {
  try {
    const Sentry = require('@sentry/node');
    if (!process.env.SENTRY_DSN) return;
    const extra = { resumen, detalle };
    const tags = { source: 'invariants_job', ...(fatal && { fatal: 'true' }) };
    if (typeof errOrMsg === 'string') {
      Sentry.captureMessage(errOrMsg, { level: level || 'warning', tags, extra });
    } else {
      Sentry.captureException(errOrMsg, { level: level || 'error', tags, extra });
    }
  } catch { /* Sentry no disponible — log es suficiente */ }
}

// Wrapper que envuelve runInvariantsCheck con un advisory lock. Si esta
// instancia no logra adquirirlo, otra instancia ya lo está corriendo y
// hacemos no-op (logueado). Multi-instance safe.
async function runWithLock() {
  return withAdvisoryLock('ipro-job-invariants', () => runInvariantsCheck());
}

// Programador: corre una vez al startup (si runOnStartup=true, útil en dev) y
// luego cada `intervalHours`. Devuelve el handle del setInterval para tests/shutdown.
//
// Multi-instance safe: con N replicas, el setInterval dispara en todas a la
// misma hora aprox, pero el advisory lock garantiza que SOLO UNA ejecuta el
// check real. Las demás logean "skipped".
function startInvariantsJob({ intervalHours = 24, runOnStartup = false } = {}) {
  // No correr en tests para no contaminar / ralentizar la suite.
  if (process.env.NODE_ENV === 'test') return null;

  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

  if (runOnStartup) {
    runWithLock().catch(err =>
      logger.error({ err }, 'invariants check inicial falló')
    );
  }

  const handle = setInterval(() => {
    runWithLock().catch(err =>
      logger.error({ err }, 'invariants check periódico falló')
    );
  }, intervalMs);

  // .unref() evita que el timer mantenga vivo el proceso durante shutdown.
  if (typeof handle.unref === 'function') handle.unref();
  logger.info({ intervalHours }, 'invariants job programado');
  return handle;
}

module.exports = { runInvariantsCheck, startInvariantsJob };
