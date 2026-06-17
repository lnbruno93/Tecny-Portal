// Caché Redis cross-instance para `users.{password_changed_at, email_verified_at}`,
// las únicas 2 columnas que requireAuth lee en CADA request autenticado.
//
// TANDA 6 P-04 Fase 3.6 — HIGH escalabilidad del audit 2026-06-17.
//
// Problema:
//   requireAuth hace `SELECT password_changed_at, email_verified_at FROM users
//   WHERE id = $1 AND deleted_at IS NULL` en cada request con Bearer token.
//   Con 9 módulos activos cada navegación de UI dispara ~10 requests; en
//   prod con ~50 users concurrentes, eso es ~500 queries/min solo para auth
//   meta. Postgres aguanta, pero es desperdicio puro: el dato cambia con
//   frecuencia ~días (password change, email verify).
//
// Solución:
//   Cache por user_id en Redis (cross-instance, las 2 réplicas Railway lo
//   comparten). TTL 60s — corto a propósito: si algún UPDATE escapa al
//   sistema de invalidación explícito (ej. admin script SQL directo), el
//   sistema se recupera en <1 min. La invalidación explícita en los
//   call-sites legítimos (cambio de password, soft-delete, verify-email)
//   propaga en <100ms.
//
// Estructura — mirror de cajasCache.js:
//   - `fetchers` Map per user_id, con cap LRU MAX_FETCHERS.
//   - Cada fetcher es un createCachedFetcherRedis con key `cache:user_auth:u{id}`.
//   - `getUserAuth(userId)` devuelve el row o `null` si no existe / soft-deleted.
//   - `invalidateUserAuth(userId)` borra el key de Redis (cross-instance).
//
// Seguridad:
//   El soft-delete bumps `password_changed_at` (ver routes/usuarios.js), así
//   que aunque cacheemos el row de un user soft-deleted, el check de iat <
//   changedAt en requireAuth rechaza el token. Si lo invalidamos de todos
//   modos, mejor — el siguiente lookup ve `null` y rechaza con "Usuario no
//   encontrado".
//
// Cache miss / Redis down:
//   El wrapper hace fetch directo sin cachear. Throughput baja durante
//   outage de Redis, pero correctness preservada.

const { createCachedFetcherRedis } = require('./cacheTtl');
const db = require('../config/database');
const logger = require('./logger');

const TTL_MS = 60_000; // 60s
const MAX_FETCHERS = 1024; // ~1024 users concurrentes con cache vivo

// Query: el filter `deleted_at IS NULL` se hace en el query — si el user
// está soft-deleted no devolvemos ningún row, y getUserAuth → null.
const USER_AUTH_SQL = `
  SELECT password_changed_at, email_verified_at
    FROM users
   WHERE id = $1 AND deleted_at IS NULL`;

const fetchers = new Map();

function getFetcherForUser(userId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`getUserAuth: userId inválido (${userId})`);
  }
  let fn = fetchers.get(userId);
  if (fn) {
    // Bump LRU: re-insertar para que sea el más reciente.
    fetchers.delete(userId);
    fetchers.set(userId, fn);
    return fn;
  }
  fn = createCachedFetcherRedis(
    `cache:user_auth:u${userId}`,
    TTL_MS,
    async () => {
      const { rows } = await db.query(USER_AUTH_SQL, [userId]);
      // Devolvemos null explícito si el user no existe / soft-deleted.
      // JSON serializa null OK; el caller distingue null vs object.
      if (!rows[0]) return null;
      // Normalizamos: timestamps a ISO string para que JSON.parse/stringify
      // round-trip sea idempotente. Si dejamos Date objects, el primer
      // hit devuelve Date pero el segundo (desde Redis) devuelve string —
      // inconsistencia que rompería comparaciones downstream.
      return {
        password_changed_at: rows[0].password_changed_at
          ? rows[0].password_changed_at.toISOString()
          : null,
        email_verified_at: rows[0].email_verified_at
          ? rows[0].email_verified_at.toISOString()
          : null,
      };
    }
  );
  fetchers.set(userId, fn);
  if (fetchers.size > MAX_FETCHERS) {
    // LRU eviction: el más viejo es el primer key insertado.
    const oldestKey = fetchers.keys().next().value;
    fetchers.delete(oldestKey);
  }
  return fn;
}

// Devuelve `{ password_changed_at, email_verified_at }` (timestamps como ISO
// strings) o `null` si el user no existe / soft-deleted. Cacheado 60s.
async function getUserAuth(userId) {
  return getFetcherForUser(userId)();
}

// Invalida el cache de un user específico. Cross-instance vía Redis DEL.
// Async — fire-and-forget en callers (no critical path para el response).
//
// TANDA 1 fix H1-Sol auditoría 2026-06-17: logging interno de fallos.
// Antes los callers usaban `.catch(() => {})` y tragaban silenciosamente
// errores de Redis (timeout, network). Una caída transitoria de Redis
// durante un logout dejaba el token activo por 60s adicionales sin señal.
// Ahora cualquier fallo se loggea con userId — observable en Sentry/pino.
async function invalidateUserAuth(userId) {
  if (userId == null) {
    logger.warn('invalidateUserAuth() sin userId — no-op.');
    return;
  }
  try {
    const fn = fetchers.get(userId);
    if (fn) {
      await fn.invalidate();
      return;
    }
    // Si no hay fetcher local (caso típico cross-instance: el UPDATE corrió
    // en la réplica A, pero la réplica B tiene el cache de ese user), tenemos
    // que borrar el key de Redis igual. createCachedFetcherRedis.invalidate
    // hace redis.del(key); si nunca lo creamos local no hay fn — pero
    // necesitamos disparar el DEL igual para que la otra réplica vea miss.
    //
    // Solución: crear el fetcher acá (lazy) solo para tener la handle de
    // invalidate. Es barato — solo crea la closure, no toca Postgres.
    const tmp = getFetcherForUser(userId);
    await tmp.invalidate();
  } catch (err) {
    // Cache stale hasta TTL (60s). Logueamos para observabilidad — el caller
    // sigue sin bloqueo (fire-and-forget). Si vemos estos warns en prod
    // significa que Redis está degradado y los logout/cambios de perms tardan
    // hasta 60s en propagar cross-instance.
    logger.warn({ err: err.message, userId },
      'invalidateUserAuth falló — cache stale hasta TTL (60s)');
  }
}

// Solo para tests: limpia el Map de fetchers. Necesario porque jest tests
// comparten el módulo entre describe blocks y el Map acumula entradas.
function _resetForTest() {
  fetchers.clear();
}

module.exports = {
  getUserAuth,
  invalidateUserAuth,
  _resetForTest,
};
