const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const logger = require('./lib/logger');
const db = require('./config/database');

const authRoutes         = require('./routes/auth');
const vendedoresRoutes   = require('./routes/vendedores');
const comprobantesRoutes = require('./routes/comprobantes');
const pagosRoutes        = require('./routes/pagos');
const historialRoutes    = require('./routes/historial');
const configRoutes       = require('./routes/config');
const ocrRoutes          = require('./routes/ocr');
const contactosRoutes    = require('./routes/contactos');
const cajasRoutes        = require('./routes/cajas');
const enviosRoutes       = require('./routes/envios');
const usuariosRoutes     = require('./routes/usuarios');

const requireAuth       = require('./middleware/auth');
const requirePermission = require('./middleware/requirePermission');

const app = express();

// Trust Railway's load balancer so rate limiting uses the real client IP
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// CORS — lista blanca explícita. Sin CORS_ORIGIN en env, solo permite localhost
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:5500')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!process.env.CORS_ORIGIN) {
  logger.warn('CORS_ORIGIN no configurado — solo se permiten orígenes localhost');
}

app.use(cors({
  origin: (origin, cb) => {
    // Requests sin Origin (Supertest, curl, health checks): permitir
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(Object.assign(new Error(`Origen no permitido: ${origin}`), { status: 403 }));
  },
  credentials: true,
}));

// General rate limit: 300 req / 15 min per IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intentá de nuevo en 15 minutos' },
}));

app.use(express.json({ limit: '10mb' }));

// Logging de requests (silencia /health para no generar ruido)
app.use(pinoHttp({
  logger,
  customProps: (req) => ({ userId: req.user?.id }),
  autoLogging: { ignore: (req) => req.url === '/health' },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
}));

app.get('/health', async (_req, res) => {
  const start = Date.now();
  let dbStatus = 'ok';
  let dbLatency = null;
  let dbError = null;

  try {
    await db.query('SELECT 1');
    dbLatency = Date.now() - start;
  } catch (err) {
    dbStatus = 'error';
    dbError = err.message;
  }

  const mem = process.memoryUsage();
  const status = dbStatus === 'ok' ? 'ok' : 'degraded';

  res.status(status === 'ok' ? 200 : 503).json({
    status,
    ts:      new Date().toISOString(),
    uptime:  Math.floor(process.uptime()),
    version: process.env.npm_package_version || '1.0.0',
    db: {
      status:     dbStatus,
      latency_ms: dbLatency,
      ...(dbError && { error: dbError }),
    },
    memory: {
      rss_mb:        Math.round(mem.rss        / 1024 / 1024),
      heap_used_mb:  Math.round(mem.heapUsed   / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal  / 1024 / 1024),
    },
  });
});

// Strict login rate limit: 10 failed attempts / 15 min per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login, esperá 15 minutos' },
  skipSuccessfulRequests: true,
});
app.use('/api/auth/login', loginLimiter);

// Auth (sin restricción de permisos)
app.use('/api/auth',          authRoutes);

// Financiera — requiere permiso "financiera"
app.use('/api/vendedores',    requireAuth, requirePermission('financiera'), vendedoresRoutes);
app.use('/api/comprobantes',  requireAuth, requirePermission('financiera'), comprobantesRoutes);
app.use('/api/pagos',         requireAuth, requirePermission('financiera'), pagosRoutes);
app.use('/api/historial',     requireAuth, requirePermission('financiera'), historialRoutes);
app.use('/api/config',        requireAuth, requirePermission('financiera'), configRoutes);
app.use('/api/ocr',           requireAuth, requirePermission('financiera'), ocrRoutes);

// Cajas — requiere permiso "cajas"
app.use('/api/contactos',     requireAuth, requirePermission('cajas'), contactosRoutes);
app.use('/api/cajas',         requireAuth, requirePermission('cajas'), cajasRoutes);

// Envíos — requiere permiso "envios"
app.use('/api/envios',        requireAuth, requirePermission('envios'), enviosRoutes);

// Usuarios — solo admin (ya controlado dentro de la ruta con adminOnly)
app.use('/api/usuarios',      usuariosRoutes);

// Sentry captura los errores antes que el handler genérico
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) {
    (req.log || logger).error({ err }, err.message);
  }
  res.status(status).json({ error: err.message || 'Error interno' });
});

module.exports = app;
