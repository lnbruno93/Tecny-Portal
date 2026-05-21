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

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`iPro API corriendo en puerto ${PORT}`);
});
