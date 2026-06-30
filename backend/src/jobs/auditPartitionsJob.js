// Job nocturno de mantenimiento de las particiones de audit_logs (P-19).
//
// Responsabilidades:
//   1) ensure-next-month — diariamente pre-crea la partición del mes que viene
//      llamando a `ensure_audit_partition(NOW() + INTERVAL '1 month')`. Si ya
//      existe es no-op (CREATE TABLE IF NOT EXISTS). Esto garantiza que cuando
//      el primer INSERT del próximo mes llegue, la partición ya está lista —
//      evita el escenario "primer INSERT del mes falla porque la partición
//      todavía no se creó" (no hay default partition por diseño).
//
//   2) drop-old — el día 1 de cada mes a las ~4 AM, dropea las partitions más
//      viejas que `retention_months` (default 12) llamando a
//      `drop_old_audit_partitions(retention_months)`. Es la implementación
//      "fast retention" del particionado: dropear partition entera (millis)
//      en lugar de DELETE row-by-row (minutos a horas).
//
// Multi-instancia safety:
//   Ambas tareas envueltas en `withAdvisoryLock` con keys distintas. Con N
//   réplicas, solo UNA corre cada job en su tick. Sigue el patrón establecido
//   por `audit_purga`, `invariants_check`, `rate_limit_cleanup`.
//
// Frecuencia:
//   - ensure-next-month: cada 24h (overkill, pero barato — el cron viejo de
//     purga ya corre con esta cadencia y la cohabitación es natural).
//   - drop-old: cada 24h, pero internamente filtra por día del mes — solo
//     dropea efectivamente el día 1 (evita lock contention diario en una
//     operación que conceptualmente es mensual).
//
// Por qué cron interno y no pg_cron / Railway Scheduler:
//   Sigue el patrón ya usado (startPurgaJob, startInvariantsJob). No agrega
//   dependencias nuevas. Cuando migremos a un job runner externo, los 3
//   migran juntos.

const db = require('../config/database');
const logger = require('../lib/logger');
const withAdvisoryLock = require('../lib/withAdvisoryLock');

// Auditoría 2026-06-30 E-01: reportar a Sentry si el cron falla. Antes solo
// había logger.error → si el cron fallaba silencioso por permisos DB, search
// path roto, o ensure_audit_partition no existiendo, nadie se enteraba hasta
// que un INSERT del próximo mes fallaba con "no partition found for row".
// Sentry capture cierra el loop de observabilidad. No-op si no hay DSN
// (e.g. tests, dev local).
function reportToSentry(err, step) {
  try {
    if (!process.env.SENTRY_DSN) return;
    const Sentry = require('@sentry/node');
    Sentry.captureException(err, { tags: { job: 'audit_partitions', step } });
  } catch (sentryErr) {
    logger.warn({ err: sentryErr.message }, 'Sentry capture falló en audit_partitions');
  }
}

// Pre-crea la partición del próximo mes si no existe.
async function ensureNextMonthPartition() {
  const t0 = Date.now();
  try {
    await db.query(`SELECT ensure_audit_partition((NOW() + INTERVAL '1 month')::date)`);
    logger.info({ elapsed_ms: Date.now() - t0 }, 'audit_logs ensure_next_month_partition OK');
  } catch (err) {
    logger.error({ err }, 'audit_logs ensure_next_month_partition falló');
    reportToSentry(err, 'ensure_next_month');
    throw err;
  }
}

// Dropea particiones más viejas que `retentionMonths`. Devuelve cuántas dropeó.
async function dropOldPartitions(retentionMonths = 12) {
  const t0 = Date.now();
  try {
    const { rows } = await db.query(
      `SELECT drop_old_audit_partitions($1) AS dropped`,
      [retentionMonths]
    );
    const dropped = rows[0]?.dropped ?? 0;
    logger.info(
      { retentionMonths, dropped, elapsed_ms: Date.now() - t0 },
      'audit_logs drop_old_partitions OK'
    );
    return dropped;
  } catch (err) {
    logger.error({ err }, 'audit_logs drop_old_partitions falló');
    reportToSentry(err, 'drop_old');
    throw err;
  }
}

// Job programador. Devuelve un handle composado de los dos intervals para tests/shutdown.
function startAuditPartitionsJob({
  retentionMonths = 12,
  intervalHours   = 24,
  runOnStartup    = false,
} = {}) {
  if (process.env.NODE_ENV === 'test') return null;

  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

  // Job 1: ensure-next-month — corre siempre que tickee el interval.
  const runEnsure = () =>
    withAdvisoryLock('audit_partitions_ensure', ensureNextMonthPartition)
      .catch(err => logger.error({ err }, 'audit_partitions_ensure con lock falló'));

  // Job 2: drop-old — internamente filtra por día del mes. Solo el día 1
  // dispara el DROP real; el resto de los días es un no-op silencioso (no
  // hace ni la query). Esto mantiene el patrón "1 cron, ejecución condicional"
  // sin necesidad de un scheduler con expresión cron compleja.
  const runDrop = () => {
    const dayOfMonth = new Date().getUTCDate();
    if (dayOfMonth !== 1) return Promise.resolve();
    return withAdvisoryLock('audit_partitions_drop', () => dropOldPartitions(retentionMonths))
      .catch(err => logger.error({ err }, 'audit_partitions_drop con lock falló'));
  };

  if (runOnStartup) {
    runEnsure();
    runDrop();
  }

  const ensureHandle = setInterval(runEnsure, intervalMs);
  const dropHandle   = setInterval(runDrop,   intervalMs);
  if (typeof ensureHandle.unref === 'function') ensureHandle.unref();
  if (typeof dropHandle.unref   === 'function') dropHandle.unref();

  logger.info({ retentionMonths, intervalHours }, 'audit_partitions job programado (con advisory lock)');

  return { ensureHandle, dropHandle };
}

module.exports = {
  ensureNextMonthPartition,
  dropOldPartitions,
  startAuditPartitionsJob,
};
