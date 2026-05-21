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

const app = require('./src/app');
const logger = require('./src/lib/logger');

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'production' }, 'iPro API iniciada');
});
