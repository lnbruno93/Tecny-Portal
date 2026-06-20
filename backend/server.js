// En producción (Railway), las vars vienen del entorno y dotenv no hace nada (no hay .env).
// En desarrollo local, override:true garantiza que el .env local tome precedencia
// sobre vars del sistema que puedan estar vacías.
require('dotenv').config({ override: process.env.NODE_ENV !== 'production' });

// ─── Validación de variables de entorno críticas ──────────────────────────────
// Fallar rápido antes de cargar nada — mejor un error claro que un servidor roto
const REQUIRED_ENV = {
  JWT_SECRET:           32,
  DATABASE_URL:         1,
  // 2FA: secret de 32 bytes en hex (64 chars) para cifrar los TOTP secrets at-rest.
  // Generar con: openssl rand -hex 32. Si cambia, los secrets cifrados quedan
  // ilegibles — rotación requiere migración. NO commitear al repo.
  TWOFA_ENCRYPTION_KEY: 64,
};
const envErrors = [];
for (const [key, minLen] of Object.entries(REQUIRED_ENV)) {
  const val = process.env[key];
  if (!val || val.length < minLen) {
    envErrors.push(
      minLen > 1
        ? `${key} debe tener al menos ${minLen} caracteres (actual: ${val?.length ?? 0})`
        : `${key} es requerido`
    );
  }
}
if (envErrors.length) {
  console.error('❌  Variables de entorno faltantes o inválidas:\n  •', envErrors.join('\n  • '));
  process.exit(1);
}

// Sentry debe inicializarse ANTES de cargar Express y las rutas.
// Se carga siempre para poder usar Sentry.flush() en shutdown/crashes
// incluso cuando SENTRY_DSN no está configurado (Sentry es no-op sin DSN).
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0, // solo errores, sin performance tracing (menor overhead)
  });
}

const app    = require('./src/app');
const logger = require('./src/lib/logger');
const db     = require('./src/config/database');
const { startPurgaJob } = require('./src/lib/audit');
const { startInvariantsJob } = require('./src/jobs/invariantsJob');
const { startAuditPartitionsJob } = require('./src/jobs/auditPartitionsJob');
const { startAuditQueueWorker } = require('./src/jobs/auditQueueWorker');
const { startEmailTokensCleanupJob } = require('./src/jobs/emailTokensCleanupJob');
const { startChatCleanupJob } = require('./src/jobs/chatCleanupJob');
const withAdvisoryLock = require('./src/lib/withAdvisoryLock');
const PostgresRateLimitStore = require('./src/lib/postgresRateLimitStore');

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'production' }, 'iPro API iniciada');

  // Job interno: cada 24h purga audit_logs > AUDIT_RETENCION_DIAS días (default 365).
  // Sin esto la tabla crecía infinita y rompía /historial. Single-instance only
  // — cuando escalemos a múltiples workers hay que migrar a pg_cron o Railway Scheduler.
  const diasRetencion = Number(process.env.AUDIT_RETENCION_DIAS) || 365;
  startPurgaJob({ diasRetencion, intervalHours: 24 });

  // Job interno: cada 24h valida invariantes de integridad financiera.
  // Si encuentra drift (saldos negativos, FKs lógicas rotas, conciliación
  // inconsistente), reporta a Sentry. Detecta corrupción silenciosa temprano.
  // runOnStartup deshabilitado en prod — el primer check corre 24h después
  // del deploy, lo cual es preferible (evita ruido en cada redeploy).
  startInvariantsJob({ intervalHours: 24 });

  // P-19 GRAN auditoría 2026-06-10: mantenimiento de particiones de audit_logs.
  //   · Cada 24h: pre-crea partition del próximo mes (idempotente).
  //   · Día 1 del mes (UTC) ~04 AM: dropea partitions > AUDIT_RETENCION_MESES.
  // Ambas tareas con advisory lock — solo una réplica las corre.
  const retencionMeses = Number(process.env.AUDIT_RETENCION_MESES) || 12;
  startAuditPartitionsJob({ retentionMonths: retencionMeses, intervalHours: 24 });

  // P-07: worker async para audit_queue. No-op cuando el flag
  // `audit_async_enabled` esta OFF (que es el default — no hay encolado, queue
  // queda vacia, el tick es un round-trip barato a la DB). Cuando un admin
  // active el flag via PATCH /api/feature-flags, los audits empiezan a encolar
  // y este worker los persiste a audit_logs cada 2s. Multi-instance safe via
  // advisory lock + SKIP LOCKED. Drain on SIGTERM con timeout 8s.
  startAuditQueueWorker({ batchSize: 100, intervalMs: 2000 });

  // TANDA 2.5 follow-up auditoría 2026-06-17: purga periódica de
  // `email_verification_tokens` (tokens consumidos >7 días + tokens expirados
  // >1 día). Sin este job la tabla crecía monotónicamente — cada signup +
  // cada resend agrega una fila. Multi-instance safe via advisory lock.
  startEmailTokensCleanupJob({ intervalHours: 24 });

  // TANDA 3 #341 (follow-up auditoría post-bot): purga periódica de
  // `chat_rate_limits` con window_start > 7 días. Sin este job la tabla
  // crecía linealmente con el uso del bot — a escala 500 users/día son
  // 180k filas/año por entorno. El UPSERT del rate-limit se vuelve más
  // lento sin purga. Multi-instance safe via advisory lock.
  startChatCleanupJob({ intervalHours: 24 });

  // P1 auditoría 2026-06: cleanup periódico de rate_limit_entries expiradas.
  // El store nunca borra automáticamente — las filas con expires_at < NOW()
  // quedan acumulándose. Sin cleanup, la tabla crece. Con cleanup horario
  // y windows típicos de 15min, la tabla se mantiene en O(usuarios activos).
  //
  // Envuelto en withAdvisoryLock — solo una réplica ejecuta el DELETE.
  const cleanupStore = new PostgresRateLimitStore({ db, logger });
  const runCleanup = () => withAdvisoryLock('rate_limit_cleanup', () => cleanupStore.cleanup())
    .catch(err => logger.error({ err }, 'rate_limit cleanup falló'));
  setInterval(runCleanup, 60 * 60 * 1000).unref(); // cada 1h
  logger.info('rate_limit cleanup job programado (con advisory lock, intervalHours: 1)');
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info({ signal }, 'Señal recibida — cerrando servidor...');

  // 1. Dejar de aceptar conexiones nuevas
  server.close(async () => {
    try {
      // 2. Flushear eventos pendientes de Sentry antes de cerrar
      //    (Railway da ~10s — usar 2s para no bloquear el cierre)
      if (process.env.SENTRY_DSN) {
        await Sentry.flush(2000);
      }
      // 3. Drenar el pool de PostgreSQL
      await db.end();
      logger.info('Shutdown limpio — Sentry flusheado, pool cerrado');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error durante shutdown');
      process.exit(1);
    }
  });

  // Fuerza la salida si tarda más de 10s (Railway da ~10s de gracia)
  setTimeout(() => {
    logger.warn('Timeout de shutdown alcanzado — salida forzada');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Errores no capturados ────────────────────────────────────────────────────
// Si una promesa o excepción escapa fuera de los route handlers, Node puede
// quedar en estado corrupto. Reportamos a Sentry, logueamos y salimos para
// que Railway reinicie el proceso automáticamente.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection — saliendo');
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason);
    Sentry.flush(2000).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException — saliendo');
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(err);
    Sentry.flush(2000).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});
