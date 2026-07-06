// chatCleanupJob — purga periódica de `chat_rate_limits` + `chat_messages`.
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
// Audit 2026-07-06 P1 (privacy + retention gap): el job originalmente solo
// purgaba `chat_rate_limits`. Los `chat_messages` (transcripciones completas
// de conversaciones user ↔ bot) crecían indefinidamente — potencial data
// leak si un tenant es hackeado, y contra GDPR "storage limitation
// principle". Agregamos purge de mensajes + conversaciones > 90 días.
//
// Política de retención:
//   · `chat_rate_limits`: filas con `window_start < NOW() - 7 días` (contador
//     diario, > 7 días es histórico inútil).
//   · `chat_messages`: filas con `created_at < NOW() - 90 días`. Ventana
//     amplia para permitir referencia a conversaciones recientes desde el
//     historial de la UI. Balance entre utility y privacy.
//   · `chat_conversations`: se borran en cascada cuando quedan sin mensajes
//     (ON DELETE CASCADE de chat_messages) — no, al revés: chat_messages
//     CASCADE ON chat_conversations. Entonces borramos conversations vacías
//     explícitamente en un segundo DELETE.
//
// Implementación:
//   · DELETE en una sola query por tabla (batching no necesario a la escala
//     actual). Si crece, agregar LIMIT + loop.
//   · Advisory lock para evitar que las 2 réplicas Railway corran el job
//     al mismo tiempo.
//   · Schedule diario cada 24h vía setInterval.

const logger = require('../lib/logger');
const db = require('../config/database');
const withAdvisoryLock = require('../lib/withAdvisoryLock');

let Sentry = null;
try { Sentry = require('@sentry/node'); } catch { /* no Sentry */ }

// Retention thresholds. Consts para que los tests puedan verificar sin
// hardcodear en la assertion.
const RATE_LIMIT_RETENTION_DAYS = 7;
const MESSAGES_RETENTION_DAYS = 90;

/**
 * Ejecuta UNA pasada de cleanup. Devuelve un objeto con los counts por
 * tabla. No tira excepción si falla — loguea + Sentry.
 */
async function runChatCleanup() {
  const startedAt = Date.now();
  try {
    // chat_rate_limits NO tiene RLS (la tabla guarda counters globales por
    // tenant + user, el aislamiento es a nivel index/query). Por eso este
    // DELETE corre sin SET app.current_tenant. Si en el futuro se agrega
    // RLS a la tabla, este job necesita usar db.withTenant() loop por
    // tenant — pero hoy es más eficiente como single DELETE.
    const rateLimits = await db.query(
      `DELETE FROM chat_rate_limits
        WHERE window_start < NOW() - INTERVAL '${RATE_LIMIT_RETENTION_DAYS} days'`
    );

    // Audit 2026-07-06 P1: chat_messages retention. Borramos mensajes >90d
    // primero — al borrar todos los mensajes de una conversación, la
    // conversación queda vacía y la limpiamos en el siguiente DELETE.
    // Las FK son ON DELETE CASCADE en el sentido contrario (borrar la
    // conversation borra sus mensajes), así que este orden es necesario.
    const messages = await db.query(
      `DELETE FROM chat_messages
        WHERE created_at < NOW() - INTERVAL '${MESSAGES_RETENTION_DAYS} days'`
    );

    // Purgar conversaciones que quedaron vacías después del DELETE de mensajes.
    // Usamos NOT EXISTS + guard de antiguedad para no borrar convs recién
    // creadas que todavía no tienen mensajes (el user acaba de abrir una).
    const conversations = await db.query(
      `DELETE FROM chat_conversations c
        WHERE c.created_at < NOW() - INTERVAL '${MESSAGES_RETENTION_DAYS} days'
          AND NOT EXISTS (
            SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id
          )`
    );

    const ms = Date.now() - startedAt;
    const summary = {
      rate_limits:   rateLimits.rowCount,
      messages:      messages.rowCount,
      conversations: conversations.rowCount,
    };
    logger.info({ ...summary, durationMs: ms, source: 'chat_cleanup' },
      `chat cleanup: ${summary.rate_limits} rate-limits, ${summary.messages} messages, ${summary.conversations} conversations (${ms}ms)`);

    // Métrica a Sentry solo si algo se borró — evita ruido en tenants con poco uso.
    const total = summary.rate_limits + summary.messages + summary.conversations;
    if (Sentry && total > 0) {
      try {
        Sentry.captureMessage(`chatCleanup: purged ${total} rows`, {
          level: 'info',
          tags: { source: 'chat_cleanup' },
          extra: { ...summary, durationMs: ms },
        });
      } catch { /* no Sentry */ }
    }
    return summary;
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
    return { rate_limits: 0, messages: 0, conversations: 0 };
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

module.exports = {
  runChatCleanup,
  startChatCleanupJob,
  RATE_LIMIT_RETENTION_DAYS,
  MESSAGES_RETENTION_DAYS,
};
