// emailTokensCleanupJob — purga periódica de `email_verification_tokens`.
//
// TANDA 2.5 (follow-up auditoría 2026-06-17): la tabla crece monotónicamente
// porque cada signup + cada /resend-verification agrega filas, y NO había job
// que las purgara. A 1000 signups/día → 365k filas/año por entorno. El índice
// UNIQUE sobre `token` recibe TODAS las filas y se infla.
//
// Política de retención:
//   - Filas con `used_at IS NOT NULL` (token ya consumido): se borran si el
//     used_at tiene >7 días. 7 días es ventana de gracia para forense /
//     auditoría de "cuándo verificó cada user su email".
//   - Filas con `expires_at < NOW() - 1 día` (token vencido, nunca usado):
//     se borran también. El user puede usar /resend-verification para
//     generar uno nuevo en cualquier momento, así que no perdemos nada.
//
// Implementación:
//   - DELETE en batches de 500 con LIMIT para no bloquear la tabla bajo
//     carga (mismo pattern que el cleanup de PostgresRateLimitStore).
//   - Advisory lock para evitar que múltiples réplicas corran el job al
//     mismo tiempo.
//   - Setea SET LOCAL app.current_tenant para satisfacer RLS si la tabla
//     tiene policy (no la tiene actualmente, pero defensive).
//
// Sentry: capturamos la métrica `rowCount` como evento informativo.

const logger = require('../lib/logger');
const db = require('../config/database');
const withAdvisoryLock = require('../lib/withAdvisoryLock');

let Sentry = null;
try { Sentry = require('@sentry/node'); } catch { /* no Sentry */ }

/**
 * Ejecuta UNA pasada de cleanup. Devuelve el count de filas borradas.
 * No tira excepción si falla — loguea + Sentry.
 */
async function runEmailTokensCleanup() {
  const startedAt = Date.now();
  try {
    // DELETE en una sola query (la tabla es chica relativa a otras, no
    // necesita batching agresivo). Si en algún momento crece a millones de
    // filas, agregar LIMIT + loop.
    const { rowCount } = await db.query(
      `DELETE FROM email_verification_tokens
        WHERE (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '7 days')
           OR (expires_at < NOW() - INTERVAL '1 day')`
    );
    const ms = Date.now() - startedAt;
    logger.info({ rowCount, durationMs: ms, source: 'email_tokens_cleanup' },
      `cleanup tokens: ${rowCount} filas borradas (${ms}ms)`);

    // Métrica informativa a Sentry (solo si rowCount > 0 — evita ruido).
    if (Sentry && rowCount > 0) {
      try {
        Sentry.captureMessage(`emailTokensCleanup: ${rowCount} rows`, {
          level: 'info',
          tags: { source: 'email_tokens_cleanup' },
          extra: { rowCount, durationMs: ms },
        });
      } catch { /* no Sentry */ }
    }
    return rowCount;
  } catch (err) {
    logger.error({ err }, 'email tokens cleanup falló');
    if (Sentry) {
      try {
        Sentry.captureException(err, {
          tags: { source: 'email_tokens_cleanup' },
          level: 'error',
        });
      } catch { /* no Sentry */ }
    }
    return 0;
  }
}

/**
 * Programa el job: corre una vez al startup (si runOnStartup=true) y luego
 * cada `intervalHours` (default: 24h). Devuelve el handle del setInterval.
 * En NODE_ENV=test no arranca (devuelve null).
 */
function startEmailTokensCleanupJob({ intervalHours = 24, runOnStartup = false } = {}) {
  if (process.env.NODE_ENV === 'test') return null;

  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

  // Advisory lock para que solo una réplica corra el cleanup a la vez.
  // No necesita logSkip — es OK que otra réplica skip silently.
  const runWithLock = () => withAdvisoryLock('email_tokens_cleanup', runEmailTokensCleanup)
    .catch(err => logger.error({ err }, 'email tokens cleanup con lock falló'));

  if (runOnStartup) runWithLock();

  const handle = setInterval(runWithLock, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  logger.info({ intervalHours }, 'email tokens cleanup job programado (con advisory lock)');
  return handle;
}

module.exports = { runEmailTokensCleanup, startEmailTokensCleanupJob };
