const express     = require('express');
const compression = require('compression');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const pinoHttp    = require('pino-http');
const logger      = require('./lib/logger');
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
const egresosRoutes      = require('./routes/egresos');
const cambiosRoutes      = require('./routes/cambios');
const tarjetasRoutes     = require('./routes/tarjetas');
const enviosRoutes       = require('./routes/envios');
const usuariosRoutes     = require('./routes/usuarios');
const cuentasRoutes      = require('./routes/cuentas');
const usadosRoutes       = require('./routes/usados');
const inventarioRoutes   = require('./routes/inventario');
const ventasRoutes       = require('./routes/ventas');
const ventasExtraRoutes  = require('./routes/ventas-extra');
const proveedoresRoutes  = require('./routes/proveedores');
const proyectosRoutes    = require('./routes/proyectos');

const requireAuth       = require('./middleware/auth');
const requirePermission = require('./middleware/requirePermission');

const app = express();

// Trust Railway's load balancer so rate limiting uses the real client IP
app.set('trust proxy', 1);

// Compresión gzip/brotli — reduce tamaño de respuestas JSON hasta ~70%
app.use(compression());

// Security headers — CSP explícito para servidor API puro (sin HTML propio)
// defaultSrc 'none' bloquea cualquier intento de cargar recursos desde este origen.
// Los headers X-Frame-Options, HSTS, etc. los gestiona helmet con defaults seguros.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'none'"],
      scriptSrc:   ["'none'"],
      styleSrc:    ["'none'"],
      imgSrc:      ["'none'"],
      connectSrc:  ["'none'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
      baseUri:     ["'none'"],
      formAction:  ["'none'"],
    },
  },
}));

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
    // Timeout explícito y corto: el health-check no debe colgarse esperando al pool/DB.
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('health DB timeout')), 3_000)),
    ]);
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
      // Estado del pool de conexiones — útil para detectar connection leaks o saturación
      pool: {
        total:   db.totalCount,
        idle:    db.idleCount,
        waiting: db.waitingCount,
      },
      // Error interno solo visible fuera de producción — evita filtrar detalles de DB
      ...(dbError && process.env.NODE_ENV !== 'production' && { error: dbError }),
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

// Contactos — agenda compartida (la usan Ventas, Cajas, Proyectos para quick-add).
// Solo requiere sesión; la pantalla "Contactos" se gatea por permiso en el front.
app.use('/api/contactos',     requireAuth, contactosRoutes);

// Cajas — requiere permiso "cajas"
app.use('/api/cajas',         requireAuth, requirePermission('cajas'), cajasRoutes);
app.use('/api/egresos',       requireAuth, requirePermission('cajas'), egresosRoutes);
app.use('/api/cambios',       requireAuth, requirePermission('cambios'), cambiosRoutes);
app.use('/api/tarjetas',      requireAuth, requirePermission('tarjetas'), tarjetasRoutes);

// Envíos — requiere permiso "envios"
app.use('/api/envios',        requireAuth, requirePermission('envios'), enviosRoutes);

// Cuentas Corrientes — requiere permiso "cuentas"
app.use('/api/cuentas',       requireAuth, requirePermission('cuentas'), cuentasRoutes);

// Cotizador Usados — requiere permiso "usados"
app.use('/api/usados',        requireAuth, requirePermission('usados'), usadosRoutes);

// Inventario — requiere permiso "inventario"
app.use('/api/inventario',    requireAuth, requirePermission('inventario'), inventarioRoutes);

// Ventas — requiere permiso "ventas" (sub-recursos + core, mismo prefijo)
app.use('/api/ventas',        requireAuth, requirePermission('ventas'), ventasExtraRoutes);
app.use('/api/ventas',        requireAuth, requirePermission('ventas'), ventasRoutes);

// Proveedores — requiere permiso "proveedores" (cuentas por pagar)
app.use('/api/proveedores',   requireAuth, requirePermission('proveedores'), proveedoresRoutes);
app.use('/api/proyectos',     requireAuth, requirePermission('proyectos'),   proyectosRoutes);

// Usuarios — solo admin (requireAuth aquí + adminOnly dentro del router)
app.use('/api/usuarios',      requireAuth, usuariosRoutes);

// Sentry captura los errores antes que el handler genérico
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use((err, req, res, _next) => {
  // Traducir errores de PostgreSQL conocidos a HTTP 4xx útiles (en vez de 500 opaco):
  //   23503 = foreign_key_violation   → la referencia no existe (depósito/categoría/etc.)
  //   23505 = unique_violation        → conflicto de unicidad (IMEI repetido, etc.)
  //   23502 = not_null_violation      → falta un campo requerido
  //   23514 = check_violation         → violación de CHECK constraint
  // Sólo exponemos el nombre del constraint o columna (sin la tupla), para no filtrar datos.
  if (!err.status && err.code) {
    const pgMap = {
      '23503': () => ({ status: 409, msg: 'Referencia inválida' + (err.constraint ? ` (${err.constraint})` : '') }),
      '23505': () => ({ status: 409, msg: 'Conflicto de unicidad' + (err.constraint ? ` (${err.constraint})` : '') }),
      '23502': () => ({ status: 400, msg: 'Falta un campo requerido' + (err.column ? `: ${err.column}` : '') }),
      '23514': () => ({ status: 400, msg: 'Valor inválido' + (err.constraint ? ` (${err.constraint})` : '') }),
    };
    if (pgMap[err.code]) { const m = pgMap[err.code](); err.status = m.status; err.message = m.msg; }
  }
  const status = err.status || 500;
  if (status >= 500) {
    (req.log || logger).error({ err }, err.message);
  }
  // Errores 5xx: mensaje genérico al cliente — el detalle (err.message de pg, etc.)
  // puede filtrar nombres de tablas/columnas/constraints. Ya queda logueado server-side.
  // Errores <500 (validación/negocio): el mensaje es intencional y seguro de mostrar.
  const clientError = status >= 500 ? 'Error interno' : (err.message || 'Error');
  res.status(status).json({ error: clientError });
});

module.exports = app;
