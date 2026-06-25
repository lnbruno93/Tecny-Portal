// Status del tenant — paid_until + isActive. Lo lee el middleware
// requireActiveTenant en cada request no-GET para bloquear writes en
// tenants vencidos (TANDA 4 billing pre-live 2026-06-25).
//
// Caché TTL 5min cross-instance (Redis):
//   - Lectura por request es trivial → cacheamos para no pegar a DB en cada
//     POST/PUT/DELETE/PATCH.
//   - Invalidate explícito al PATCH paid-until del admin → la otra réplica
//     ve el cambio en <100ms (DEL key vía Redis pub/sub semantics).
//   - TTL 5min como backup en caso de invalidate fallido en alguna réplica.
//
// Semántica de paid_until:
//   - NULL                       → grandfathered / sin enforcement (activo)
//   - paid_until >= CURRENT_DATE → activo (pagado al día)
//   - paid_until <  CURRENT_DATE → expirado (read-only en middleware)
//
// La query usa pool admin (BYPASSRLS) — necesitamos leer tenants directo
// por id sin pasar por el contexto RLS del request (el request puede ser
// del tenant N pero acá filtramos por id explícito).

const { createTenantScopedCache } = require('./cacheTtl');
const { TENANT_STATUS } = require('./cacheConfig');
const db = require('../config/database');

const cache = createTenantScopedCache({
  ...TENANT_STATUS,
  fetcher: async (tenantId) => {
    const id = Number(tenantId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`getTenantStatus: tenantId inválido (${tenantId})`);
    }
    // Pool admin: tenants.suspended_at + paid_until son metadata del operador,
    // no del cliente. Bypaseamos RLS para leer por id explícito.
    const row = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT id, plan, paid_until, suspended_at FROM tenants WHERE id = $1`,
        [id]
      );
      return rows[0];
    });
    if (!row) return null;
    // paid_until vs CURRENT_DATE — date-only comparison.
    // Si paid_until IS NULL → activo (grandfathered).
    // Si paid_until >= hoy → activo (pagado al día).
    const isActive = row.paid_until == null
      ? true
      : new Date(row.paid_until) >= new Date(new Date().toISOString().slice(0, 10));
    return {
      id: row.id,
      plan: row.plan,
      paid_until: row.paid_until,
      suspended_at: row.suspended_at,
      is_active: isActive && row.suspended_at == null,
    };
  },
});

/**
 * Devuelve el status del tenant cacheado por 5min.
 * @param {number} tenantId
 * @returns {Promise<{id, plan, paid_until, suspended_at, is_active}|null>}
 */
async function getTenantStatus(tenantId) {
  return cache.get(tenantId);
}

/**
 * Invalida el cache de un tenant. Llamado por endpoints admin que
 * modifican paid_until / suspended_at. Cross-instance via Redis DEL.
 */
async function invalidateTenantStatus(tenantId) {
  return cache.invalidate(tenantId);
}

// Solo para tests: limpia el Map local de fetchers. Necesario porque Jest
// comparte módulos entre describes; sin esto, queries entre tests con el
// mismo tenantId pueden devolver datos cacheados de tests previos.
function _resetForTest() {
  if (cache._resetForTest) cache._resetForTest();
}

module.exports = { getTenantStatus, invalidateTenantStatus, _resetForTest };
