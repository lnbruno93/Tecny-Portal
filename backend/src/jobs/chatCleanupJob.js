// chatCleanupJob — purga periódica de `chat_rate_limits`.
//
// TANDA 3 #341 (follow-up auditoría post-bot): la tabla chat_rate_limits
// crece monotónicamente — 1 fila por (user_id, window_start), y window_start
// es 1 valor distinto por día/user. A escala:
//   · 50 usuarios activos/día × 365 = ~18k filas/año por entorno.
//   · 500 usuarios activos/día × 365 = 180k filas/año.
// Sin job de purga, el UNIQUE INDEX (user_id, window_start) crece linealmente
// y el UPSERT `INSERT ... ON CONFLICT (user_id, window_start) DO UPDATE` se
// vuelve más lento con cada año. Tabla operativa de rate-limit no debería
// tener datos > 7 días.
//
// Política de retención:
//   · Filas con `window_start < NOW() - 7 días`: borrar. El rate-limit es
//     diario, así que cualquier fila > 7 días NO se va a referenciar más
//     (es histórico inútil). 7 días = ventana de gracia para forense
//     "cuántos mensajes usó user X hace una semana".
//   · NO purgamos las del día actual ni de los últimos 6 días — esas
//     siguen siendo el contador vivo si el user vuelve a mandar.
//
// Implementación:
//   · DELETE en una sola query (la tabla siempre será chica en términos
//     absolutos, no necesita batching). Si crece a millones por error,
//     agregar LIMIT + loop.
//   · Advisory lock para evitar que las 2 réplicas Railway corran el job
//     al mismo tiempo (mismo pattern que emailTokensCleanupJob).
//   · Schedule diario a las 03:00 ART (window de menos tráfico), pero
//     usamos setInterval simple cada 24h porque cron node no agrega
//     valor para algo tan poco crítico.

const logger = require('../lib/logger');
const db = require('../config/database');
const withAdvisoryLock = require('../lib/withAdvisoryLock');

let Sentry = null;
try { Sentry = require('@sentry/node'); } catch { /* no Sentry */ }

/**
 * Ejecuta UNA pasada de cleanup. Devuelve el count de filas borradas.
 * No tira excepción si falla — loguea + Sentry.
 */
async function runChatCleanup() {
  const startedAt = Date.now();
  try {
    // chat_rate_limits NO tiene RLS (la tabla guarda counters globales por
    // tenant + user, el aislamiento es a nivel index/query). Por eso este
    // DELETE corre sin SET app.current_tenant. Si en el futuro se agrega
    // RLS a la tabla, este job necesita usar db.withTenant() loop por
    // tenant — pero hoy es más eficiente como single DELETE.
    const { rowCount } = await db.query(
      `DELETE FROM chat_rate_limits
        WHERE window_start < NOW() - INTERVAL '7 days'`
    );
    const ms = Date.now() - startedAt;
    logger.info({ rowCount, durationMs: ms, source: 'chat_cleanup' },
      `chat cleanup: ${rowCount} filas borradas de chat_rate_limits (${ms}ms)`);

    // Métrica a Sentry solo si rowCount > 0 — evita ruido en tenants
    // con poco uso.
    if (Sentry && rowCount > 0) {
      try {
        Sentry.captureMessage(`chatCleanup: ${rowCount} rate-limit rows purged`, {
          level: 'info',
          tags: { source: 'chat_cleanup' },
          extra: { rowCount, durationMs: ms },
        });
      } catch { /* no Sentry */ }
    }
    return rowCount;
  } catch (err) {
    logger.error({ err }, 'chat cleanup falló');
    if (Sentry) {
      try {
        Sentry.captureException(err, {
          tags: { source: 'chat_cleanup' },
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
 * En NODE_ENV=test no arranca (devuelve null) — los tests del cleanup en sí
 * llaman `runChatCleanup` directo.
 */
function startChatCleanupJob({ intervalHours = 24, runOnStartup = false } = {}) {
  if (process.env.NODE_ENV === 'test') return null;

  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

  // Advisory lock para que solo una réplica corra el cleanup a la vez.
  // Si la otra réplica también dispara el job en el mismo minuto, el lock
  // hace que solo una progrese — la otra retorna inmediatamente.
  const runWithLock = () => withAdvisoryLock('chat_cleanup', runChatCleanup)
    .catch(err => logger.error({ err }, 'chat cleanup con lock falló'));

  if (runOnStartup) runWithLock();

  const handle = setInterval(runWithLock, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  logger.info({ intervalHours }, 'chat cleanup job programado (con advisory lock)');
  return handle;
}

module.exports = { runChatCleanup, startChatCleanupJob };
