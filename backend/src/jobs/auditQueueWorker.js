// auditQueueWorker — procesa `audit_queue` y persiste a `audit_logs`.
//
// Diseño: ver docs/design/p07-async-audit.md sección 7.3.
//
// Comportamiento:
//   · setInterval(intervalMs=2000) — cada 2s dispara un `tick`.
//   · withAdvisoryLock('audit_queue_worker') — multi-instance safe: solo 1
//     réplica corre cada tick. Patrón ya usado por audit_purga, invariants,
//     audit_partitions.
//   · processBatch({ batchSize=100 }) — bajo el lock hace:
//       1. DELETE ... WHERE id IN (SELECT id FROM audit_queue ORDER BY enqueued_at
//          LIMIT batchSize FOR UPDATE SKIP LOCKED) RETURNING *.
//          → preserva FIFO + SKIP LOCKED garantiza que 2 réplicas (aunque
//            improbable con el advisory lock) no procesen los mismos rows.
//       2. Bulk INSERT INTO audit_logs ... SELECT * FROM UNNEST(...) — 1 round-trip
//          para N rows (patrón P-06 TANDA 3, escalable).
//       3. Preserva enqueued_at como created_at (req #3 doc: orden temporal).
//
// processBatch se exporta para tests — pueden forzar un drain manual sin
// esperar el interval ni cargar el server entero.
//
// Graceful shutdown:
//   · SIGTERM / SIGINT → drain() corre processBatch en loop hasta que la queue
//     este vacia o se cumplan DRAIN_TIMEOUT_MS = 8000ms (Railway da ~10s antes
//     del SIGKILL; deja 2s de margen para el shutdown del HTTP server + pool).
//   · Log "audit_queue: drain complete" o "audit_queue: drain timeout, N rows
//     remaining" segun el outcome. Las filas no procesadas quedan en la queue
//     persistente — el proximo arranque las retoma.
//
// NODE_ENV=test: NO arranca el setInterval ni registra shutdown hooks (evita
// open handles + tests pueden controlar el flush manualmente via processBatch).

const db = require('../config/database');
const logger = require('../lib/logger');
const withAdvisoryLock = require('../lib/withAdvisoryLock');

const DRAIN_TIMEOUT_MS = 8000; // pre-SIGKILL drain budget

// Auditoría 2026-06-30 Q-05 (P-07 alerta Sentry):
// Si la queue crece por encima de QUEUE_DEPTH_ALERT_THRESHOLD significa que el
// worker no está dando abasto (write rate > drain rate). Mandamos un
// captureMessage con tags a Sentry para que despierte alguien. El check va
// envuelto en throttle (QUEUE_DEPTH_ALERT_THROTTLE_MS) para no martillar Sentry
// cada 2 s si la queue queda colgada — un evento cada 10 min es suficiente para
// detectar y abrir incidente.
const QUEUE_DEPTH_ALERT_THRESHOLD = 10000;
const QUEUE_DEPTH_ALERT_THROTTLE_MS = 10 * 60 * 1000;
let _lastQueueDepthAlertAt = 0;

// processBatch — devuelve { processed: number, drained: boolean }.
//   processed = filas movidas a audit_logs en este tick.
//   drained   = true si la queue quedo vacia post-batch (size < batchSize).
//
// NO usa withAdvisoryLock internamente — es una funcion pura sobre la DB. El
// `tick()` la envuelve con el lock; los tests la llaman directo (sin lock,
// sin reentrada). Esto permite testear concurrency con 2 processBatch en
// paralelo y verificar que SKIP LOCKED hace su trabajo.
async function processBatch({ batchSize = 100 } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // DELETE atomico: las filas salen de audit_queue. Si el INSERT a audit_logs
    // falla, ROLLBACK las regresa a la queue. Si COMMIT exitoso, fueron movidas.
    // SKIP LOCKED evita esperar filas que otra session/replica este procesando.
    const { rows } = await client.query(
      `DELETE FROM audit_queue
         WHERE id IN (
           SELECT id FROM audit_queue
            ORDER BY enqueued_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         RETURNING tabla, accion, registro_id, datos_antes, datos_despues,
                   user_id, ip, user_agent, request_id, enqueued_at, tenant_id`,
      [batchSize]
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return { processed: 0, drained: true };
    }

    // Bulk INSERT con UNNEST: 1 round-trip para N rows. Mismo patron P-06.
    // jsonb / inet / uuid se pasan via $::jsonb[], $::inet[], $::uuid[].
    const tablaArr   = rows.map(r => r.tabla);
    const accionArr  = rows.map(r => r.accion);
    const registroId = rows.map(r => r.registro_id);
    // datos_antes / datos_despues ya vienen como objetos JS desde Postgres (pg
    // los parsea automaticamente para JSONB). Para el UNNEST INSERT los
    // re-serializamos a string + casteamos a jsonb[].
    const antesArr   = rows.map(r => r.datos_antes  == null ? null : JSON.stringify(r.datos_antes));
    const despuesArr = rows.map(r => r.datos_despues == null ? null : JSON.stringify(r.datos_despues));
    const userIdArr  = rows.map(r => r.user_id);
    const ipArr      = rows.map(r => r.ip);
    const uaArr      = rows.map(r => r.user_agent);
    const reqIdArr   = rows.map(r => r.request_id);
    const enqAtArr   = rows.map(r => r.enqueued_at);
    const tenantArr  = rows.map(r => r.tenant_id);

    await client.query(
      `INSERT INTO audit_logs
         (tabla, accion, registro_id, datos_antes, datos_despues,
          user_id, ip, user_agent, request_id, created_at, tenant_id)
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::int[],
         $4::jsonb[], $5::jsonb[],
         $6::int[], $7::inet[], $8::text[], $9::uuid[],
         $10::timestamptz[], $11::int[]
       )`,
      [tablaArr, accionArr, registroId,
       antesArr, despuesArr,
       userIdArr, ipArr, uaArr, reqIdArr,
       enqAtArr, tenantArr]
    );

    await client.query('COMMIT');
    // drained=true si procesamos menos que el batch — probablemente queue vacia.
    return { processed: rows.length, drained: rows.length < batchSize };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Auditoría 2026-06-30 Q-05 (P-07 alerta Sentry):
// Chequea queue_depth y manda Sentry.captureMessage si supera el threshold.
// Throttled: máximo 1 alerta cada QUEUE_DEPTH_ALERT_THROTTLE_MS para evitar
// floodear Sentry si la queue queda gorda durante minutos. El log local
// (warn) sí sale siempre — útil para correlacionar en Railway logs.
async function maybeAlertQueueDepth() {
  try {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM audit_queue');
    const depth = rows[0]?.n ?? 0;
    if (depth <= QUEUE_DEPTH_ALERT_THRESHOLD) return;

    logger.warn({ depth, threshold: QUEUE_DEPTH_ALERT_THRESHOLD },
      'audit_queue: depth above threshold');

    const now = Date.now();
    if (now - _lastQueueDepthAlertAt < QUEUE_DEPTH_ALERT_THROTTLE_MS) return;
    _lastQueueDepthAlertAt = now;

    try {
      const Sentry = require('@sentry/node');
      if (process.env.SENTRY_DSN) {
        Sentry.captureMessage('audit_queue depth above threshold', {
          level: 'warning',
          tags: { component: 'audit_queue_worker', alert: 'queue_depth' },
          extra: { queue_depth: depth, threshold: QUEUE_DEPTH_ALERT_THRESHOLD },
        });
      }
    } catch { /* Sentry no disponible — no propagar */ }
  } catch (err) {
    // Si la query falla, no rompemos el worker — sólo log.
    logger.error({ err }, 'audit_queue: depth alert check failed');
  }
}

function startAuditQueueWorker({ batchSize = 100, intervalMs = 2000 } = {}) {
  // En tests NO arrancamos el setInterval ni registramos SIGTERM hooks.
  // Razones:
  //   · open handles: Jest --detectOpenHandles falla con timers vivos cross-test.
  //   · control: los tests llaman processBatch() directo para forzar drain
  //     sincronicamente y assertear sin race conditions.
  if (process.env.NODE_ENV === 'test') return null;

  const tick = async () => {
    try {
      await withAdvisoryLock('audit_queue_worker', async () => {
        const { processed } = await processBatch({ batchSize });
        if (processed > 0) {
          logger.debug({ processed }, 'audit_queue: batch procesado');
        }
        // Auditoría 2026-06-30 Q-05 (P-07 alerta Sentry):
        // Después de drenar lo que pudimos, chequear si la queue sigue gorda.
        // Si depth > threshold => Sentry.captureMessage (throttled). Solo el
        // tenedor del advisory lock ejecuta esto => no hay risk de N réplicas
        // disparando alertas duplicadas.
        await maybeAlertQueueDepth();
        // TODO P-07 DLQ (deferred): si una fila falla N veces (attempts > 5)
        // marcarla y moverla a audit_queue_dead para inspección manual. Por
        // ahora la fila queda en la queue y el siguiente tick la retoma —
        // operacionalmente ok porque audit data es uniforme (no hay payloads
        // que rompan). Re-evaluar cuando se vea la 1ra row con last_error en
        // rows_with_errors del endpoint /api/admin/audit-queue-stats.
      }, { logSkip: false });
    } catch (err) {
      logger.error({ err }, 'audit_queue worker tick failed');
      try {
        const Sentry = require('@sentry/node');
        if (process.env.SENTRY_DSN) Sentry.captureException(err);
      } catch { /* Sentry no disponible — no propagar */ }
    }
  };

  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();

  // Graceful drain on shutdown. El proceso recibe SIGTERM de Railway con ~10s
  // de margen antes del SIGKILL. Reservamos 8s para procesar lo encolado;
  // sino el siguiente arranque retoma (la queue es persistente).
  let shuttingDown = false;
  const drain = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(handle);
    logger.info('audit_queue: draining queue before shutdown');
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    let totalDrained = 0;
    while (Date.now() < deadline) {
      try {
        const { processed, drained } = await processBatch({ batchSize });
        totalDrained += processed;
        if (drained) break;
      } catch (err) {
        logger.error({ err }, 'audit_queue: drain batch failed');
        break;
      }
    }
    try {
      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM audit_queue');
      const remaining = rows[0]?.n ?? 0;
      if (remaining === 0) {
        logger.info({ totalDrained }, 'audit_queue: drain complete');
      } else {
        logger.warn({ totalDrained, remaining }, 'audit_queue: drain timeout, rows remaining');
      }
    } catch (err) {
      logger.error({ err }, 'audit_queue: drain count check failed');
    }
  };
  process.once('SIGTERM', drain);
  process.once('SIGINT', drain);

  logger.info({ batchSize, intervalMs }, 'audit_queue worker programado (con advisory lock)');
  return handle;
}

module.exports = {
  processBatch,
  startAuditQueueWorker,
  maybeAlertQueueDepth,
  DRAIN_TIMEOUT_MS,
  QUEUE_DEPTH_ALERT_THRESHOLD,
  QUEUE_DEPTH_ALERT_THROTTLE_MS,
};
