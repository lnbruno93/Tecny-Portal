// En producción (Railway), las vars vienen del entorno y dotenv no hace nada (no hay .env).
// En desarrollo local, override:true garantiza que el .env local tome precedencia
// sobre vars del sistema que puedan estar vacías.
require('dotenv').config({ override: process.env.NODE_ENV !== 'production' });

// ─── Validación de variables de entorno críticas ──────────────────────────────
// Fallar rápido antes de cargar nada — mejor un error claro que un servidor roto
const REQUIRED_ENV = { JWT_SECRET: 32, DATABASE_URL: 1 };
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

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'production' }, 'iPro API iniciada');

  // Job interno: cada 24h purga audit_logs > AUDIT_RETENCION_DIAS días (default 365).
  // Sin esto la tabla crecía infinita y rompía /historial. Single-instance only
  // — cuando escalemos a múltiples workers hay que migrar a pg_cron o Railway Scheduler.
  const diasRetencion = Number(process.env.AUDIT_RETENCION_DIAS) || 365;
  startPurgaJob({ diasRetencion, intervalHours: 24 });
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
