const express     = require('express');
const compression = require('compression');
const cors        = require('cors');
const helmet      = require('helmet');
// 2026-06-11 S-IPv6: importamos `ipKeyGenerator` además del default rateLimit.
// Sin el helper, los `keyGenerator` custom que combinan `req.ip` con user.id
// dejan un agujero IPv6: un atacante puede rotar el sufijo de host dentro del
// mismo /64 y obtener una IP "distinta" en cada request → bypass del límite.
// `ipKeyGenerator` normaliza colapsando IPv6 al prefijo /64 (block) y deja
// IPv4 intacto. Es el patrón canónico documentado en
// https://express-rate-limit.github.io/ERR_ERL_KEY_GEN_IPV6/.
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const jwt         = require('jsonwebtoken');
const pinoHttp    = require('pino-http');
const logger      = require('./lib/logger');
const db = require('./config/database');
const PostgresRateLimitStore = require('./lib/postgresRateLimitStore');

// Store compartido para los rate-limiters críticos (login + 2FA). En tests
// usamos MemoryStore (default) para no requerir DB en cada rate-limit assertion.
// En producción/staging, ambos limiters comparten contadores entre las 2
// réplicas Railway → defensa real contra brute force (P1 auditoría 2026-06).
const isTestEnv = process.env.NODE_ENV === 'test';
const loginStore  = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: 'login',  logger });
const twoFaStore  = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: '2fa',    logger });
// Perf M3 auditoría 2026-06-06: global limiter también con store compartido.
// Antes era MemoryStore → con 2 réplicas Railway, una IP podía duplicar su
// share efectivo del límite (600/15min en lugar de 300). Mismo patrón que
// loginStore/twoFaStore: en tests usa MemoryStore para no requerir DB.
const globalStore = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: 'global', logger });
// TANDA 2.4 fix BLOCKER auditoría 2026-06-17:
//   - signupStore: antes signupLimiter compartía loginStore con prefix 'login'
//     → un IP que falló 10 logins quedaba bloqueado para signup, y los counters
//     se mezclaban. Prefijo dedicado 'signup'.
//   - resendStore: antes /resend-verification usaba MemoryStore (default sin
//     store) → en multi-replica, un user con JWT robado podía pegar 3× en
//     réplica A y 3× en réplica B = 6 emails/hora (2× lo declarado). Prefijo
//     dedicado 'resend'.
const signupStore = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: 'signup', logger });
const resendStore = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: 'resend', logger });
// TANDA 2.6: store dedicado para /verify-email limiter (30/min/IP).
const verifyStore = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: 'verify', logger });
// 2026-06-18 #313 fix: changePasswordLimiter compartía loginStore.
// express-rate-limit v7+ valida que cada limiter tenga un store dedicado y al
// arrancar emitía ValidationError ERR_ERL_STORE_REUSE en los Railway logs (non-
// fatal, las validations son catched + logged por wrappedValidations). Más allá
// del log noise, compartir el store hace que el counter de change-password
// pise el de login: 5 intentos fallidos de change-password drenaban el cupo
// de 5 logins (mismo namespace en la tabla `rate_limits`). Fix: prefix
// dedicado 'change-password'.
const changePasswordStore = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: 'change-password', logger });
// 2026-06-18 #321 forgot-password:
//   - forgotPasswordStore: rate limit 3/hora/IP para POST /forgot-password.
//     Anti-spam (un atacante podría bombardear emails reset a una víctima si
//     no hay limit). Prefix dedicado para no chocar con otros stores.
//   - resetPasswordStore: rate limit 10/hora/IP para POST /reset-password.
//     Más lenient porque el token es la defensa primaria (256-bit, single-shot,
//     TTL 1h). El limit acá es contra brute-force masivo del token space.
const forgotPasswordStore = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: 'forgot-password', logger });
const resetPasswordStore = isTestEnv ? undefined : new PostgresRateLimitStore({ db, prefix: 'reset-password', logger });

const authRoutes         = require('./routes/auth');
const signupRoutes       = require('./routes/signup');
// TANDA 2.4 fix BLOCKER: inyectar resendStore al lazy-init del rate limiter de
// /resend-verification (defaults a MemoryStore = bypass en multi-replica).
if (signupRoutes.setResendStore) signupRoutes.setResendStore(resendStore);
// TANDA 2.6: inyectar verifyStore al lazy-init del rate limiter de /verify-email.
if (signupRoutes.setVerifyStore) signupRoutes.setVerifyStore(verifyStore);
const twoFaRoutes        = require('./routes/twoFa');
const vendedoresRoutes   = require('./routes/vendedores');
const comprobantesRoutes = require('./routes/comprobantes');
const pagosRoutes        = require('./routes/pagos');
const historialRoutes    = require('./routes/historial');
const configRoutes       = require('./routes/config');
const tenantProfileRoutes = require('./routes/tenant-profile');
const ocrRoutes          = require('./routes/ocr');
const contactosRoutes    = require('./routes/contactos');
const cajasRoutes        = require('./routes/cajas');
const egresosRoutes      = require('./routes/egresos');
const sanidadRoutes      = require('./routes/sanidad');
const cambiosRoutes      = require('./routes/cambios');
const tarjetasRoutes     = require('./routes/tarjetas');
const enviosRoutes       = require('./routes/envios');
const usuariosRoutes     = require('./routes/usuarios');
const capabilitiesRoutes = require('./routes/capabilities');
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
const featureFlagsRoutes = require('./routes/feature-flags');
const onboardingRoutes   = require('./routes/onboarding');
const chatRoutes         = require('./routes/chat');
// 2026-06-21 #353 Fase 1: Super-Admin app (admin.tecnyapp.com). DISTINTO de
// adminRoutes (que es admin DENTRO de un tenant). Super-admin opera cross-
// tenant con BYPASSRLS. Protegido por requireSuperAdmin (no adminOnly).
const superAdminRoutes   = require('./routes/superAdmin');
const publicRoutes       = require('./routes/public');

const requireAuth       = require('./middleware/auth');
// 2026-06-23 Permisos F3/F4: el sistema viejo `requirePermission(tool)` se
// retiró en favor de `requireCapability('pantalla.capability')`. Capability
// slugs en backend/src/lib/capabilityCatalog.js (45 caps en 19 pantallas).
// Cualquier route nueva tiene que usar requireCapability.
//
// F5c agregó `requireAnyCapability([slugs])` para pantallas multi-tab
// (Config: general/alertas/mantenimiento) — el route abre si tenés AL MENOS
// UNA, después el frontend esconde los tabs sin cap.
const requireCapability = require('./middleware/requireCapability');
const { requireAnyCapability } = require('./middleware/requireCapability');

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

// 2026-06-15: skip del global limiter para requests con JWT firmado válido.
// Motivo: el global limiter protege contra abuso anónimo (scrapers, brute force
// pre-login, bots). Una vez que el cliente trae un JWT firmado con nuestro
// secret, sabemos que pasó por el flujo de login (que tiene su propio limiter
// por IP) y los rate-limiters específicos por endpoint (OCR, export, compras,
// backfill, etc.) siguen activos para operaciones costosas. Aplicar el global
// a usuarios autenticados producía lock-outs cuando un admin hacía operaciones
// CRUD legítimas en tandas grandes (ej. borrar 50 categorías de a una) — el
// bucket de 300 se agotaba y bloqueaba hasta el propio /login, dejándolo
// afuera de su portal.
//
// Solo verificamos signature (CPU-bound, ~1ms, sin DB). La verificación
// completa (revocación post-cambio-password, user activo) la hace el middleware
// requireAuth de cada route. Si el token es inválido acá, el request cae al
// global limit (como antes) — esto preserva la defensa contra abuso anónimo
// que mande basura como Bearer header esperando bypass.
function hasValidSignedJwt(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (!token || !process.env.JWT_SECRET) return false;
  try {
    jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    return true;
  } catch {
    return false;
  }
}

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: GLOBAL_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intentá de nuevo en 15 minutos' },
  // Skips:
  //  1) /health|/ready siempre (probes externos de monitoring).
  //  2) NODE_ENV=test — el smoke test + suites combinadas disparan >300
  //     requests, lo que con el PG store (T3) deja el contador pinchado entre
  //     runs (la tabla rate_limit_entries persiste) generando 429s cascada
  //     en suites posteriores. Mismo patrón que login/2FA.
  //  3) Requests con JWT firmado válido — ver comentario arriba.
  skip: (req) =>
    req.path === '/health' ||
    req.path === '/ready' ||
    isTestEnv ||
    hasValidSignedJwt(req),
  ...(globalStore && { store: globalStore }),
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
// 2026-06-11 SE-05: genReqId con crypto.randomUUID() para que el request_id
// sea un UUID v4 compatible con la columna audit_logs.request_id (UUID). Esto
// permite correlacionar audit + logs + Sentry events del mismo request.
app.use(pinoHttp({
  logger,
  genReqId: () => require('crypto').randomUUID(),
  customProps: (req) => ({ userId: req.user?.id, request_id: req.id }),
  autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, id: req.id }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
}));

// ─── API versioning (H-06 auditoría 2026-06-10) ─────────────────────────────
//
// Estrategia: alias transparente `/api/v1/*` → `/api/*` vía URL rewrite, ANTES
// que cualquier `app.use('/api/...')` vea el request. Esto deja que todos los
// routers actuales sigan montados en `/api/...` sin cambios, y permite que
// nuevos clientes (o un cliente externo terciario) usen `/api/v1/...` desde
// hoy. La política `/api` sin versión queda como sinónimo permanente de `v1`
// hasta que exista `v2` con cambios incompatibles — momento en el cual los
// routers de v1 se montarán explícitamente bajo `/api/v1/` y `/api/...` sin
// versión seguirá apuntando a v1 por compat (no asumimos "última" como hacen
// muchas APIs — eso es contrato implícito y se rompe sin querer).
//
// Header `API-Version`: lo seteamos en la response para que el cliente sepa
// qué versión sirvió la respuesta. Útil para logs del cliente y para que
// observabilidad (Sentry) pueda taggear errors por versión.
//
// Trade-off: el rewrite implica que los routes loggean `url=/api/foo` (no
// `/api/v1/foo`) — perdemos visibilidad del path original. Si querés esa
// info, podés leer `req.headers['x-original-url']` que también seteamos.
// Decisión consciente: priorizar zero-duplication sobre observabilidad
// granular del prefijo, que rara vez importa en debugging real.
app.use((req, res, next) => {
  if (req.url.startsWith('/api/v1/') || req.url === '/api/v1') {
    req.headers['x-original-url'] = req.url;
    // /api/v1 → /api    y    /api/v1/foo/bar → /api/foo/bar
    req.url = '/api' + req.url.slice('/api/v1'.length);
  }
  // Header informativo. Lo seteamos para CUALQUIER /api/* (con o sin /v1).
  if (req.url.startsWith('/api/')) {
    res.setHeader('API-Version', 'v1');
  }
  next();
});

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

  // P-04: Redis health-check. NO bloquea el status global si falla — Redis
  // es cache opcional con fallback graceful. Si está enabled pero no responde,
  // status queda 'ok' (DB sigue funcionando, solo perdemos cache cross-instance).
  // Si está disabled (REDIS_URL no configurada), simplemente reportamos `disabled`.
  //
  // 2026-06-12 hotfix: TODO el bloque está bajo try/catch absoluto. Si algo
  // synchronously throws (ioredis constructor con URL malformed, require()
  // tirando ENOTFOUND, etc.), reportamos 'error' y SEGUIMOS — el endpoint
  // /health NUNCA debe crashear. Railway lo monitorea con timeout corto y
  // un 500 acá tumba el deploy entero (causa el healthcheck failure que
  // bloqueó PR #190).
  let redisStatus = 'disabled';
  let redisLatency = null;
  let redisError = null;
  try {
    const redisClient = require('./lib/redisClient');
    if (redisClient.isEnabled()) {
      const redisStart = Date.now();
      const ok = await redisClient.ping();
      redisLatency = Date.now() - redisStart;
      redisStatus = ok ? 'ok' : 'unreachable';
    }
  } catch (err) {
    redisStatus = 'error';
    redisError = err.message;
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
    redis: {
      status:     redisStatus,
      latency_ms: redisLatency,
      // Error message solo fuera de producción para no filtrar detalles
      // (URL de Redis, hostname interno, etc.) en /health público.
      ...(redisError && process.env.NODE_ENV !== 'production' && { error: redisError }),
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

// 2026-06-16 TANDA 2.1: signup público con rate limit estricto (5/hora/IP).
// Defiende contra abuse (creación masiva de cuentas + spam del provider de
// email). Limiter compartido entre réplicas via loginStore (PG-backed).
// El route en signup.js maneja también /verify-email y /resend-verification
// — esos tienen su propia política interna (verify-email confía en el espacio
// de tokens de 256 bits; resend-verification tiene un per-user limiter).
const createSignupLimiter = require('./middleware/signupLimiter');
// TANDA 2.4 fix BLOCKER: usar signupStore (prefix dedicado), NO loginStore.
const signupLimiter = createSignupLimiter(signupStore);
app.use('/api/auth/signup', signupLimiter);

// 2026-06-11 SE-07: rate limit dedicado para /api/auth/change-password.
// Sin esto, un token robado podía martillar el endpoint para brute-forcear el
// currentPassword (solo limitado por el global de 300/15min). 5 intentos/15min
// por user.id es agresivo pero no rompe el flujo legítimo (fat-fingers OK).
const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de cambio de contraseña, esperá 15 minutos.' },
  // S-IPv6: si hay user.id usamos eso (misma semántica que antes); si no, IP
  // normalizada por `ipKeyGenerator` (colapsa IPv6 al /64 — evita bypass por
  // rotación de sufijo).
  keyGenerator: (req) => req.user?.id ? String(req.user.id) : ipKeyGenerator(req),
  skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === 'test',
  // 2026-06-18 #313: store dedicado (era loginStore — compartía namespace
  // con loginLimiter, generaba ValidationError ERR_ERL_STORE_REUSE en boot).
  ...(changePasswordStore && { store: changePasswordStore }),
});
app.use('/api/auth/change-password', requireAuth, changePasswordLimiter);

// 2026-06-18 #321 forgot-password: rate limit estricto. 3 intentos/hora/IP
// es holgado para fat-fingers (legítimo: 1 intento exitoso/año), apretado
// para anti-spam (cada intento manda email — sin limit, atacante podía
// usar el endpoint para email-bombear una víctima inundándola de mails).
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados pedidos de reset. Esperá 1 hora y reintentá.' },
  // Endpoint público — solo IP. ipKeyGenerator colapsa IPv6 al /64.
  keyGenerator: (req) => ipKeyGenerator(req),
  skip: () => process.env.NODE_ENV === 'test',
  ...(forgotPasswordStore && { store: forgotPasswordStore }),
});
app.use('/api/auth/forgot-password', forgotPasswordLimiter);

// 2026-06-18 #321 reset-password: rate limit más lenient (10/hora/IP). La
// defensa primaria es el token (256-bit hex, single-shot, TTL 1h) — el
// limit acá es contra brute-force masivo del token space (10^77 — infactible
// igual, pero defense in depth).
const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de reset. Esperá 1 hora.' },
  keyGenerator: (req) => ipKeyGenerator(req),
  skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === 'test',
  ...(resetPasswordStore && { store: resetPasswordStore }),
});
app.use('/api/auth/reset-password', resetPasswordLimiter);

// Auth (sin restricción de permisos)
// 2026-06-16 TANDA 2.1: signupRoutes va ANTES de authRoutes — ambos montados
// en /api/auth. Express resuelve por el primer match, así que las rutas de
// signupRoutes (/signup, /verify-email, /resend-verification) toman precedencia.
// authRoutes maneja /login, /me, /logout, /change-password — no hay colisión
// de paths entre los dos routers.
app.use('/api/auth',          signupRoutes);
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
  // S-IPv6: ver comentario en changePasswordLimiter. Mismo patrón.
  keyGenerator: (req) => req.user?.id ? String(req.user.id) : ipKeyGenerator(req),
  // Solo contar fallos (status >= 400). Los success (200) no degradan el límite,
  // así que el legítimo no se auto-bloquea por uso normal.
  skipSuccessfulRequests: true,
  skip: () => process.env.NODE_ENV === 'test',
  // P1 auditoría 2026-06: store compartido entre réplicas (ver loginLimiter).
  ...(twoFaStore && { store: twoFaStore }),
});
app.use('/api/auth/2fa',      requireAuth, twoFaLimiter, twoFaRoutes);

// Financiera — requiere capability `financiera.trabajar`.
// 2026-06-23 Permisos F3: cutover de `requirePermission('financiera')` a la
// capability slug equivalente. Mismo gate operacional — ahora granular si
// más adelante queremos separar comprobantes/pagos de transferencias.
app.use('/api/vendedores',    requireAuth, requireCapability('financiera.trabajar'), vendedoresRoutes);
app.use('/api/comprobantes',  requireAuth, requireCapability('financiera.trabajar'), comprobantesRoutes);
app.use('/api/pagos',         requireAuth, requireCapability('financiera.trabajar'), pagosRoutes);
app.use('/api/historial',     requireAuth, requireCapability('historial.ver'),       historialRoutes);
// 2026-06-23 F5c: /api/config sirve 3 secciones (general, alertas,
// mantenimiento) — abrimos el route si el user tiene AL MENOS UNA cap.
// El frontend (Config.jsx) esconde tabs sin cap. Cada handler interno
// que muta config sensible sigue siendo adminOnly o tiene su propio gate.
app.use('/api/config',        requireAuth, requireAnyCapability(['config.general', 'config.alertas', 'config.mantenimiento']),      configRoutes);
// Perfil del tenant (datos públicos del negocio: ficha de Google, nombre, etc).
// Sin requireCapability — cualquier user autenticado del tenant puede LEERLO
// (el Cotizador lo consume y a Cotizador llegan vendedores comunes). La
// edición está gateada por adminOnly DENTRO del router.
app.use('/api/tenant-profile', requireAuth, tenantProfileRoutes);
app.use('/api/ocr',           requireAuth, requireCapability('financiera.trabajar'), ocrRoutes);

// Contactos — agenda compartida (la usan Ventas, Cajas, Proyectos para quick-add).
// Mount con sesión + caps por método (auditoría 2026-06-06 Sec H1):
//   · GET (list/search) — solo requiere sesión: necesario para el quick-add
//     desde Ventas/Cajas/Proyectos. Es lectura no destructiva.
//   · POST/PUT/DELETE — requieren capability `contactos.crear_borrar`
//     (enforced en cada handler de routes/contactos.js).
app.use('/api/contactos',     requireAuth, contactosRoutes);

// Cajas — capability `cajas.ver` (gate operacional principal).
app.use('/api/cajas',         requireAuth, requireCapability('cajas.ver'), cajasRoutes);
// Métodos de pago lite — sin gate de capability. 2026-06-10: bug de Envíos
// donde un operador sin permiso de cajas no podía cobrar. Ver
// src/routes/metodos-pago.js para el rationale completo.
app.use('/api/metodos-pago',  requireAuth, require('./routes/metodos-pago'));
app.use('/api/egresos',       requireAuth, requireCapability('egresos.ver'),     egresosRoutes);
app.use('/api/sanidad',       requireAuth, requireCapability('sanidad.trabajar'), sanidadRoutes);
app.use('/api/cambios',       requireAuth, requireCapability('cambios.trabajar'), cambiosRoutes);
app.use('/api/tarjetas',      requireAuth, requireCapability('tarjetas.trabajar'), tarjetasRoutes);

// Envíos — requires `envios.trabajar`.
app.use('/api/envios',        requireAuth, requireCapability('envios.trabajar'), enviosRoutes);

// Cuentas Corrientes / B2B — capability `b2b.trabajar` (slug nuevo, módulo
// se renombró visualmente a "Venta & Gestión B2B" en 2026-04, el route path
// quedó como /api/cuentas por compat retro).
app.use('/api/cuentas',       requireAuth, requireCapability('b2b.trabajar'), cuentasRoutes);

// Cotizador Usados — capability `usados.ver` (acceso al catálogo).
app.use('/api/usados',        requireAuth, requireCapability('usados.ver'), usadosRoutes);

// Inventario — capability `inventario.ver` (gate operacional principal).
// Sub-capabilities (ver_costos, vaciar_stock, importar/exportar) se aplican
// inline en los handlers correspondientes — pendiente para una tanda futura.
app.use('/api/inventario',    requireAuth, requireCapability('inventario.ver'), inventarioRoutes);

// Ventas — capability `ventas.trabajar` (sub-recursos + core, mismo prefijo).
// `ventas.eliminar` se chequea inline en el handler DELETE /api/ventas/:id
// (granularidad fina). Pendiente la migración de ese check inline.
app.use('/api/ventas',        requireAuth, requireCapability('ventas.trabajar'), ventasExtraRoutes);
app.use('/api/ventas',        requireAuth, requireCapability('ventas.trabajar'), ventasRoutes);

// Proveedores — capability `proveedores.trabajar` (gate del módulo).
app.use('/api/proveedores',   requireAuth, requireCapability('proveedores.trabajar'), proveedoresRoutes);
app.use('/api/proyectos',     requireAuth, requireCapability('proyectos.trabajar'),   proyectosRoutes);
app.use('/api/conciliacion',  requireAuth, requireCapability('cajas.conciliacion'),   conciliacionRoutes);
// Alertas: vista cross-módulo (cajas, stock, CC, proveedores). Capability
// `config.alertas` (la configura el owner desde Config → Alertas).
app.use('/api/alertas',       requireAuth, requireCapability('config.alertas'),  alertasRoutes);

// Dashboard mensual / Resumen del mes: capability `resumen.ver`. Antes
// reusaba `financiera` por compat; ahora tiene capability propia ya que
// la pantalla Resumen del mes (botón del sidebar) la ven roles distintos
// que Transferencias.
app.use('/api/dashboard',     requireAuth, requireCapability('resumen.ver'),  dashboardRoutes);

// Usuarios — solo admin (requireAuth aquí + adminOnly dentro del router)
app.use('/api/usuarios',      requireAuth, usuariosRoutes);

// Capabilities (Permisos F1 — 2026-06-23): el sistema nuevo capability-based
// vive al lado del viejo /api/usuarios. GET /catalog es lectura libre para
// authenticated; GET /users + PUT /users/:id tienen adminOnly DENTRO del
// router. Coexistencia con el sistema viejo hasta el cutover F4.
app.use('/api/capabilities',  requireAuth, capabilitiesRoutes);

// Admin — herramientas de operación (invariantes, etc.). adminOnly enforced
// dentro del router. Acceso solo via JWT con role='admin'.
app.use('/api/admin',         requireAuth, adminRoutes);

// 2026-06-21 #353 Fase 1: Super-Admin — admin.tecnyapp.com app.
// DISTINTO de /api/admin (admin DENTRO de un tenant). Este namespace opera
// cross-tenant con BYPASSRLS. Solo Lucas (users.is_super_admin=true) puede
// usar — el middleware requireSuperAdmin enforcea adentro del router.
app.use('/api/super-admin',   requireAuth, superAdminRoutes);

// 2026-06-22 #353 C.1.2: Endpoints PÚBLICOS (sin auth, sin tenant scope).
// Hoy solo `/api/public/pricing` para la landing. Si en el futuro hace
// falta más, agregar acá — mantener el namespace para que sea OBVIO qué
// está expuesto al mundo.
app.use('/api/public',        publicRoutes);

// Feature flags (M-08 GRAN auditoría 2026-06-10). Sistema minimalista on/off
// global. GET / es accesible a cualquier user logueado (lo lee el frontend
// al mount); GET /admin + POST/PATCH/DELETE son admin-only — el guard está
// dentro del router porque NO TODO el router es admin (a diferencia de
// /api/admin). Ver routes/feature-flags.js para el rationale.
app.use('/api/feature-flags', requireAuth, featureFlagsRoutes);

// 2026-06-18 #323 TANDA 1 H3: onboarding status. Cualquier user logueado
// del tenant puede consultar (no requiere permission — es read-only check
// del estado del tenant).
app.use('/api/onboarding', requireAuth, onboardingRoutes);

// 2026-06-20 #340 Fase 1: Bot conversacional analítico.
// Disponible para todos los users autenticados de cualquier tenant (todos los
// planes). Sin requirePermission — el bot ya es read-only y RLS-scoped, así
// que cualquier user del tenant puede preguntar sobre la data que ya tiene
// permiso de ver (las tools usan withTenant del ctx, no bypass de RLS).
// Rate limits internos al router (5/min/user + 50/día/user + 150/día/tenant).
app.use('/api/chat',       requireAuth, chatRoutes);

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
  //
  // 2026-06-13 — En staging/dev, los admins reciben además el detalle del error
  // en el response (mensaje + stack truncado + code SQL si lo hay). Esto permite
  // debuggear bugs de staging sin pelear con logs de Railway.
  //
  // Detección: NODE_ENV != 'production' Ó el host contiene 'staging'/'localhost'.
  // El check de host cubre el caso Railway: por default Railway setea
  // NODE_ENV=production en TODOS los environments (staging y prod), así que el
  // check basado solo en NODE_ENV no distingue entre ambos. El host sí
  // (tecny-backend-staging.up.railway.app vs tecny-backend-production.up.railway.app).
  //
  // Seguridad: el detalle solo se expone si (a) el caller es admin, (b) el host
  // NO es production. En el host de producción real siempre se devuelve el
  // mensaje genérico, sin importar NODE_ENV. Defensa en profundidad: aunque
  // alguien cambie NODE_ENV en prod, el host gatekeeps.
  const body = { error: status >= 500 ? 'Error interno' : (err.message || 'Error') };
  const host = req.headers?.host || '';
  const isNonProdHost = host.includes('staging')
                     || host.includes('localhost')
                     || host.startsWith('127.');
  const exposeDebug = status >= 500
                   && req.user?.role === 'admin'
                   && (isNonProdHost || process.env.NODE_ENV !== 'production');
  if (exposeDebug) {
    body._debug = {
      message: err.message,
      code: err.code,
      name: err.name,
      stack: typeof err.stack === 'string'
        ? err.stack.split('\n').slice(0, 8).join('\n')
        : undefined,
    };
  }
  res.status(status).json(body);
});

module.exports = app;
