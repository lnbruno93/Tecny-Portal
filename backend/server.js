require('dotenv').config();

// Sentry debe inicializarse ANTES de cargar Express y las rutas
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0, // solo captura errores, sin performance
  });
}

const app    = require('./src/app');
const logger = require('./src/lib/logger');
const db     = require('./src/config/database');

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'production' }, 'iPro API iniciada');
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info({ signal }, 'Señal recibida — cerrando servidor...');

  // 1. Dejar de aceptar conexiones nuevas
  server.close(async () => {
    try {
      // 2. Drenar el pool de PostgreSQL
      await db.end();
      logger.info('Pool de DB cerrado — saliendo limpiamente');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error cerrando el pool de DB');
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
