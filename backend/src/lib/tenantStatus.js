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
    //
    // BUG FIX (issue #466): la comparación paid_until vs hoy se hace EN PG con
    // CURRENT_DATE, no en JS. Antes computábamos `new Date(row.paid_until) >=
    // new Date(new Date().toISOString().slice(0,10))` y eso mezclaba parsing
    // local-TZ (paid_until) con UTC midnight (today), generando off-by-one
    // cerca del UTC boundary: a las ~22:00 AR (=01:00 UTC) un tenant con
    // paid_until=CURRENT_DATE (válido!) se evaluaba como expired y el
    // middleware requireActiveTenant devolvía 402 a writes legítimos. Al hacer
    // la comparación dentro de PG no hay ambigüedad de TZ — el driver y
    // CURRENT_DATE comparten zona horaria del servidor PG.
    const row = await db.adminQuery(async (client) => {
      const { rows } = await client.query(
        `SELECT id, nombre, plan, paid_until, suspended_at, pais,
                (paid_until IS NULL OR paid_until >= CURRENT_DATE) AS is_active_by_date
           FROM tenants WHERE id = $1`,
        [id]
      );
      return rows[0];
    });
    if (!row) return null;
    return {
      id: row.id,
      // 2026-07-04 (#506) — Nombre del negocio que el owner setteó. Se expone
      // en /me → user.tenant.nombre para que el frontend brandee comprobantes
      // PDF, garantías y cualquier UI con el nombre del negocio (no "Tecny",
      // que es el SaaS). Cache 5min es aceptable — cambia raro (admin edita
      // ~1x cada varios meses).
      nombre: row.nombre,
      plan: row.plan,
      paid_until: row.paid_until,
      suspended_at: row.suspended_at,
      is_active: row.is_active_by_date && row.suspended_at == null,
      // 2026-06-29 Multi-país F2: incluimos `pais` para que el middleware
      // requireAuth pueda exponer `req.tenantPais` sin pegar a DB en cada
      // request. El campo es CHAR(2) inmutable post-signup, encaja perfecto
      // en este cache de 5min. Defensive fallback a 'AR' si el campo viene
      // null/undefined — la migration F1 setea DEFAULT 'AR' NOT NULL, así
      // que en runtime nunca debería ser null, pero defensive vale.
      pais: row.pais || 'AR',
    };
  },
});

/**
 * Devuelve el status del tenant cacheado por 5min.
 * @param {number} tenantId
 * @returns {Promise<{id, plan, paid_until, suspended_at, is_active, pais}|null>}
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
