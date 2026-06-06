const express     = require('express');
const compression = require('compression');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const pinoHttp    = require('pino-http');
const logger      = require('./lib/logger');
const db = require('./config/database');
const PostgresRateLimitStore = require('./lib/postgresRateLimitStore');

// Store compartido para los rate-limiters críticos (login + 2FA). En tests
// usamos MemoryStore (default) para no requerir DB en cada rate-limit assertion.
// En producción/staging, ambos limiters comparten contadores entre las 2
// réplicas Railway → defensa real contra brute force (P1 auditoría 2026-06).
const isTestEnv = process.env.NODE_ENV === 'test';
const loginStore = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: 'login', logger });
const twoFaStore = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: '2fa',   logger });

const authRoutes         = require('./routes/auth');
const twoFaRoutes        = require('./routes/twoFa');
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
const dashboardRoutes    = require('./routes/dashboard');
const conciliacionRoutes = require('./routes/conciliacion');
const alertasRoutes      = require('./routes/alertas');
const adminRoutes        = require('./routes/admin');

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

// General rate limit: 300 req / 15 min per IP (default).
// Configurable via GLOBAL_RATE_LIMIT_MAX env var — útil para:
//   - Load testing en staging (set 5000+ para no chocar con el limit)
//   - Demos/campañas que generan pico legítimo (set 1000+ temporal)
//   - Restaurar al default después (unset o set 300)
// Default explícito = 300 si la env no existe o es inválida.
//
// Skip /health y /ready: son probes externos (UptimeRobot c/5min, Railway internal)
// y bloquearlos genera falsos negativos de monitoring. Tampoco son endpoints que
// expongan datos sensibles ni que tengan costo computacional alto.
const GLOBAL_RATE_LIMIT_MAX = Number(process.env.GLOBAL_RATE_LIMIT_MAX) || 300;
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: GLOBAL_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intentá de nuevo en 15 minutos' },
  skip: (req) => req.path === '/health' || req.path === '/ready',
}));
logger.info({ globalRateLimit: GLOBAL_RATE_LIMIT_MAX }, 'rate-limit global configurado');

app.use(express.json({ limit: '10mb' }));

// Endpoint para violaciones de CSP del frontend (browsers postean reports acá).
// Lo logueamos para enterarnos de intentos de carga externa / scripts inyectados
// y agarrar problemas que el CSP frenó. No requiere auth (las browsers no envían
// credenciales en este POST). Rate-limit propio para no inundar logs ante un
// atacante que dispare cientos de violaciones.
const cspReportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,                       // 100 reports/min/IP es generoso
  standardHeaders: false, legacyHeaders: false,
  message: { error: 'rate-limit' },
});
// CSP envía `application/csp-report` o `application/reports+json` (Reporting API)
app.post('/api/csp-report', cspReportLimiter, express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '64kb' }), (req, res) => {
  const report = req.body && (req.body['csp-report'] || (Array.isArray(req.body) ? req.body[0]?.body : req.body));
  // Loguear como warning para que aparezca en alertas pero no en error
  logger.warn({ csp: report, ua: req.headers['user-agent'] }, 'csp violation');
  res.status(204).end();
});

// Errores del cliente — el frontend reporta acá errores no manejados
// (ErrorBoundary, window.onerror, unhandledrejection). Sin auth para no
// perder errores cuando el JWT está expirado. Rate-limited. Lo loguemos +
// reportamos a Sentry si está configurado.
const clientErrorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,                          // 60 errors/min/IP es razonable
  standardHeaders: false, legacyHeaders: false,
  message: { error: 'rate-limit' },
});
app.post('/api/client-errors', clientErrorLimiter, express.json({ limit: '16kb' }), (req, res) => {
  const { message, stack, url, userAgent, source, timestamp,
          build_commit: buildCommit, build_version: buildVersion } = req.body || {};
  // Logueamos como warning (no error) para no llenar el dashboard si la app
  // tiene un loop temporal. Sentry sí lo trata como error si está configurado.
  logger.warn({
    msg_client: message, stack, url, source, timestamp,
    ua: userAgent, ip: req.ip,
    build_commit: buildCommit, build_version: buildVersion,
  }, 'client error');
  try {
    const Sentry = require('@sentry/node');
    if (process.env.SENTRY_DSN) {
      Sentry.captureMessage(message || 'client error', {
        level: 'error',
        // Tags = filtros en el dashboard Sentry. source + build_commit permiten
        // pivotar por "errores de este release" o "errores del frontend en X version".
        tags: {
          source:        source || 'frontend',
          build_commit:  buildCommit  || 'unknown',
          build_version: buildVersion || 'unknown',
        },
        extra: { stack, url, userAgent, timestamp },
        // `release` matchea con la release que @sentry/vite-plugin crea al
        // subir source maps (release.name = build short SHA). Sin esto, Sentry
        // no resuelve el stacktrace minificado contra los maps subidos.
        // Solo enviamos release si el cliente reportó build_commit conocido.
        ...(buildCommit && buildCommit !== 'unknown' && { release: buildCommit }),
      });
    }
  } catch { /* Sentry no disponible */ }
  res.status(204).end();
});

// Logging de requests (silencia /health para no generar ruido)
app.use(pinoHttp({
  logger,
  customProps: (req) => ({ userId: req.user?.id }),
  autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
}));

// Cache del commit SHA y el migration count — no cambian durante el runtime
// del proceso, no tiene sentido recalcularlos en cada /health (UptimeRobot
// pings cada 5 min × N años). Se invalidan solo en restart.
let CACHED_COMMIT_SHA = null;
let CACHED_MIGRATION_COUNT = null;
function getCommitSha() {
  if (CACHED_COMMIT_SHA !== null) return CACHED_COMMIT_SHA;
  // Railway expone RAILWAY_GIT_COMMIT_SHA automáticamente.
  // Fallback a GIT_COMMIT_SHA por si lo seteamos manualmente, o 'unknown'.
  CACHED_COMMIT_SHA =
    process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ||
    process.env.GIT_COMMIT_SHA?.slice(0, 7) ||
    'unknown';
  return CACHED_COMMIT_SHA;
}
async function getMigrationCount() {
  if (CACHED_MIGRATION_COUNT !== null) return CACHED_MIGRATION_COUNT;
  try {
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM pgmigrations');
    CACHED_MIGRATION_COUNT = rows[0]?.n ?? null;
  } catch {
    CACHED_MIGRATION_COUNT = null; // no rompe el endpoint si la tabla no existe
  }
  return CACHED_MIGRATION_COUNT;
}

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
  const migrationCount = await getMigrationCount();

  res.status(status === 'ok' ? 200 : 503).json({
    status,
    ts:      new Date().toISOString(),
    uptime:  Math.floor(process.uptime()),
    version: process.env.npm_package_version || '1.0.0',
    // commit SHA del deploy actual — útil para correlacionar errores Sentry
    // con commits específicos. Si UptimeRobot devuelve esto en alerta, podés
    // saber al toque qué cambió. Railway lo expone automáticamente.
    commit:  getCommitSha(),
    // Cantidad de migraciones aplicadas en la DB. Si después de un deploy este
    // número no incrementó como esperabas, hay una migración trabada.
    migrations: migrationCount,
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

// /ready — readiness probe separado del /health.
// Diferencia conceptual:
//   /health = "el proceso está vivo" (memory, DB conectable). Si responde 503,
//             Railway reinicia. Pings frecuentes de UptimeRobot.
//   /ready  = "el proceso está listo para tomar tráfico" (DB conectable + DB
//             schema al día). Útil para gates de deploy / blue-green.
// Hoy ambos hacen check similar; el split permite políticas distintas más adelante
// (ej. /ready falla si hay migraciones pendientes en STAGED_MIGRATIONS).
app.get('/ready', async (_req, res) => {
  try {
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ready DB timeout')), 3_000)),
    ]);
    res.status(200).json({ ready: true, commit: getCommitSha() });
  } catch (err) {
    res.status(503).json({ ready: false, reason: err.message });
  }
});

// Strict login rate limit: 10 failed attempts / 15 min per IP.
// En tests no aplica (la suite de lockout dispara &gt;10 intentos a propósito
// para validar la política per-user, que es complementaria al IP limit).
// P1 auditoría 2026-06: usa PostgresRateLimitStore en producción para que
// las 2 réplicas compartan el counter. Antes era MemoryStore (process-local)
// → con 2 réplicas el límite efectivo se relajaba al doble (20/15min en
// lugar de 10/15min), debilitando la defensa contra brute force.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de login, esperá 15 minutos' },
  skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === 'test',
  ...(loginStore && { store: loginStore }),
});
app.use('/api/auth/login', loginLimiter);

// Auth (sin restricción de permisos)
app.use('/api/auth',          authRoutes);

// 2FA — endpoints de setup/enable/disable. Requieren JWT válido (requireAuth)
// porque son del flow "user gestiona su propia 2FA". La verificación durante
// LOGIN ocurre dentro de authRoutes (no acá).
//
// Rate limit dedicado per-user (H2 auditoría 2026-06): si un JWT es robado
// (XSS hipotético, dispositivo compartido sin lock), el atacante NO puede
// martillar /disable o /regenerate-recovery para anular el 2FA del user
// legítimo. La key es user.id (no IP) — un atacante con IP distinta pero
// mismo JWT también queda limitado.
//
// Política: 10 intentos / 15 min por user.id. Suficiente para fat-fingers
// del legítimo, demasiado bajo para brute force significativo (10^6 espacio
// TOTP → 10^5 windows de 15min → años).
const twoFaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de 2FA, esperá 15 minutos.' },
  keyGenerator: (req) => req.user?.id ? String(req.user.id) : req.ip,
  // Solo contar fallos (status >= 400). Los success (200) no degradan el límite,
  // así que el legítimo no se auto-bloquea por uso normal.
  skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === 'test',
  // P1 auditoría 2026-06: store compartido entre réplicas (ver loginLimiter).
  ...(twoFaStore && { store: twoFaStore }),
});
app.use('/api/auth/2fa',      requireAuth, twoFaLimiter, twoFaRoutes);

// Financiera — requiere permiso "financiera"
app.use('/api/vendedores',    requireAuth, requirePermission('financiera'), vendedoresRoutes);
app.use('/api/comprobantes',  requireAuth, requirePermission('financiera'), comprobantesRoutes);
app.use('/api/pagos',         requireAuth, requirePermission('financiera'), pagosRoutes);
app.use('/api/historial',     requireAuth, requirePermission('financiera'), historialRoutes);
app.use('/api/config',        requireAuth, requirePermission('financiera'), configRoutes);
app.use('/api/ocr',           requireAuth, requirePermission('financiera'), ocrRoutes);

// Contactos — agenda compartida (la usan Ventas, Cajas, Proyectos para quick-add).
// Mount con sesión + permisos por método (auditoría 2026-06-06 Sec H1):
//   · GET (list/search) — solo requiere sesión: necesario para el quick-add
//     desde Ventas/Cajas/Proyectos. Es lectura no destructiva.
//   · POST/PUT/DELETE — requieren permiso 'contactos' (enforced en cada
//     handler de routes/contactos.js). El toggle del frontend ahora SÍ
//     bloquea efectivamente la edición del directorio.
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
app.use('/api/conciliacion',  requireAuth, requirePermission('cajas'),       conciliacionRoutes);
// Alertas: vista cross-módulo (cajas, stock, CC, proveedores). Reusa 'financiera'.
app.use('/api/alertas',       requireAuth, requirePermission('financiera'),  alertasRoutes);

// Dashboard mensual: vista de gerencia, agrega datos de varios módulos
// (ventas, cajas, deudas, egresos). Reusa el permiso 'financiera' que ya
// engloba reportes consolidados. Si se quiere granularidad, separar a
// permiso 'dashboard' propio.
app.use('/api/dashboard',     requireAuth, requirePermission('financiera'),  dashboardRoutes);

// Usuarios — solo admin (requireAuth aquí + adminOnly dentro del router)
app.use('/api/usuarios',      requireAuth, usuariosRoutes);

// Admin — herramientas de operación (invariantes, etc.). adminOnly enforced
// dentro del router. Acceso solo via JWT con role='admin'.
app.use('/api/admin',         requireAuth, adminRoutes);

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
