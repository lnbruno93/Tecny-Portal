// Caché Redis cross-instance para `users.{password_changed_at, email_verified_at}`,
// las únicas 2 columnas que requireAuth lee en CADA request autenticado.
//
// TANDA 6 P-04 Fase 3.6 — HIGH escalabilidad del audit 2026-06-17.
// TANDA 4 refactor — migrado a createTenantScopedCache (auditoría 2026-06-17 H3-Hyg).
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
//   comparten). TTL 60s. La invalidación explícita en los call-sites
//   legítimos (cambio de password, soft-delete, verify-email) propaga en
//   <100ms vía redis.del() + tombstone (anti-stale-write race).
//
// Estructura:
//   El patrón Map<userId, fetcher> + LRU + factory de fetchers vive ahora
//   en `createTenantScopedCache` (lib/cacheTtl.js). Acá solo declaramos la
//   query y el adapter de normalización de timestamps.
//
// Seguridad:
//   El soft-delete bumps `password_changed_at` (ver routes/usuarios.js), así
//   que aunque cacheemos el row de un user soft-deleted, el check de iat <
//   changedAt en requireAuth rechaza el token. Igualmente invalidamos en
//   soft-delete por defense-in-depth (el siguiente lookup ve null).
//
// Cache miss / Redis down:
//   El wrapper hace fetch directo sin cachear. Throughput baja durante
//   outage de Redis, pero correctness preservada.

const { createTenantScopedCache } = require('./cacheTtl');
const { USER_AUTH } = require('./cacheConfig');
const db = require('../config/database');
const logger = require('./logger');

// Query: el filter `deleted_at IS NULL` se hace en el query — si el user
// está soft-deleted no devolvemos ningún row, y getUserAuth → null.
//
// 2026-06-21 #353 Fase 1: agregamos is_super_admin para que el middleware
// requireSuperAdmin pueda validar sin pegar a DB en cada request. El JWT
// también lleva el claim, pero validamos contra DB porque el bit puede
// haberse revocado después de emitir el token (script setSuperAdmin --revoke).
//
// Auditoría 2026-06-30 S-25: agregamos twofa_enabled (LEFT JOIN a user_2fa)
// para el middleware requireSuperAdmin — exigimos que el super-admin tenga
// 2FA activa antes de operar la app admin. Sin esto, un super-admin con
// password leakeada controla todos los tenants. Si user_2fa NO tiene row o
// enabled_at IS NULL → twofa_enabled = false. El cache se invalida cuando
// el user activa/desactiva 2FA (ver routes/twoFa.js endpoints).
const USER_AUTH_SQL = `
  SELECT
    u.password_changed_at,
    u.email_verified_at,
    u.is_super_admin,
    (f.enabled_at IS NOT NULL) AS twofa_enabled
  FROM users u
  LEFT JOIN user_2fa f ON f.user_id = u.id
  WHERE u.id = $1 AND u.deleted_at IS NULL`;

const cache = createTenantScopedCache({
  ...USER_AUTH,
  fetcher: async (userId) => {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`getUserAuth: userId inválido (${userId})`);
    }
    const { rows } = await db.query(USER_AUTH_SQL, [id]);
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
      // boolean — JSON round-trip safe sin transformación.
      is_super_admin: !!rows[0].is_super_admin,
      // Auditoría 2026-06-30 S-25: 2FA enabled status para requireSuperAdmin.
      twofa_enabled: !!rows[0].twofa_enabled,
    };
  },
});

// Devuelve `{ password_changed_at, email_verified_at }` (timestamps como ISO
// strings) o `null` si el user no existe / soft-deleted. Cacheado 60s.
async function getUserAuth(userId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`getUserAuth: userId inválido (${userId})`);
  }
  return cache.get(userId);
}

// Invalida el cache de un user específico. Cross-instance vía Redis DEL.
// Async — fire-and-forget en callers (no critical path para el response).
// El wrapper interno loggea cualquier fallo de Redis.
async function invalidateUserAuth(userId) {
  if (userId == null) {
    logger.warn('invalidateUserAuth() sin userId — no-op.');
    return;
  }
  return cache.invalidate(userId);
}

// Solo para tests: limpia el Map de fetchers. Necesario porque jest tests
// comparten el módulo entre describe blocks y el Map acumula entradas.
function _resetForTest() {
  cache._resetForTest();
}

module.exports = {
  getUserAuth,
  invalidateUserAuth,
  _resetForTest,
};
