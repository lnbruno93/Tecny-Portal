// capabilities.js — resolución de capabilities efectivas por (user, tenant).
//
// El sistema combina dos fuentes:
//   1. Rol base del user (tenant_user_roles.rol) → set default del rol
//      (roleDefaults.js). Owner/admin = bypass total.
//   2. Overrides en user_capabilities → enabled=true agrega; false retira.
//
// Resolver puro `resolveCaps(rol, overrides)` y resolver con DB
// `loadUserCaps(userId)` (paralelo a loadUserPerms del sistema viejo).
//
// 2026-06-23 F1: este lib es la fundación. F2 lo usa en la pantalla
// Usuarios (UI editar). F3 lo usa el middleware requireCapability.
// F4 lo embebe en el login response para arrancar al user con el set
// correcto sin pegar otra ronda DB.

const db = require('../config/database');
const logger = require('./logger');
const { getRoleDefaultCaps, isBypassRole } = require('./roleDefaults');
const { ALL_SLUGS } = require('./capabilityCatalog');
const { resolveUserTenant } = require('./userTenant');

/**
 * Combina rol + overrides → set efectivo de capability slugs.
 *
 * Para owner/admin devuelve null (bypass — el caller debe interpretarlo
 * como "todas las caps activas"). Esto evita materializar un Set de 45
 * slugs en cada login de owner.
 *
 * Para otros roles:
 *   - Arranca con los defaults del rol (Set inmutable).
 *   - Aplica cada override: enabled=true → add; enabled=false → delete.
 *
 * @param {string} rol — uno de owner|admin|vendedor|encargado|lectura|custom
 * @param {Array<{capability_slug: string, enabled: boolean}>} overrides
 * @returns {Set<string>|null} Set de slugs activos, o null si rol es bypass
 */
function resolveCaps(rol, overrides) {
  if (isBypassRole(rol)) return null;

  const defaults = getRoleDefaultCaps(rol);
  // Clonamos para no mutar el Set del módulo.
  const out = new Set(defaults);

  for (const ov of overrides) {
    if (!ALL_SLUGS.has(ov.capability_slug)) {
      // Slug fuera del catálogo (puede pasar si una migration futura saca
      // una capability pero la fila override quedó huérfana — la FK
      // ON DELETE CASCADE lo limpia, pero defensivo igual).
      continue;
    }
    if (ov.enabled === true) out.add(ov.capability_slug);
    else if (ov.enabled === false) out.delete(ov.capability_slug);
  }

  return out;
}

/**
 * Lee del DB: el rol base del user en su tenant default + todos los
 * overrides activos. Devuelve la combinación resuelta.
 *
 * Self-contained (mismo patrón que loadUserPermsRows): resuelve el tenant
 * internamente vía resolveUserTenant y wrappea las queries en withTenant
 * para pasar la RLS policy.
 *
 * Si el user no tiene fila en tenant_user_roles (caso edge — usuario
 * creado pre-F1 que el backfill no procesó, o user con tenant_users sin
 * tenant_user_roles por race condition): fallback a 'custom' silencioso.
 * El log avisa para investigar pero no rompe.
 *
 * @param {number} userId
 * @returns {Promise<{rol: string, caps: Set<string>|null, tenantId: number}>}
 *   caps = null si rol es bypass (owner/admin).
 */
async function loadUserCaps(userId) {
  const { tenant_id: tenantId } = await resolveUserTenant(userId);

  return db.withTenant(tenantId, async (client) => {
    // Rol base.
    const rolRes = await client.query(
      'SELECT rol FROM tenant_user_roles WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId],
    );

    let rol;
    if (!rolRes.rows[0]) {
      // Edge: user sin fila en tenant_user_roles. Asumimos 'custom' (0 caps).
      // Esto NO debería pasar post-backfill — el seed cubrió todo tenant_users.
      // Si pasa, el user solo verá lo que sea público (sin gates).
      logger.warn(
        { userId, tenantId },
        'loadUserCaps: user sin fila tenant_user_roles — fallback a custom',
      );
      rol = 'custom';
    } else {
      rol = rolRes.rows[0].rol;
    }

    // Overrides. Para owner/admin no hace falta ni leerlos (bypass), pero
    // los traemos igual para que la UI pueda mostrarlos (el endpoint GET
    // /api/capabilities/users los usa). Es 1 query barata.
    const ovRes = await client.query(
      `SELECT capability_slug, enabled
         FROM user_capabilities
        WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );

    const caps = resolveCaps(rol, ovRes.rows);
    return { rol, caps, tenantId, overrides: ovRes.rows };
  });
}

/**
 * Variante optimizada para login: resuelve el set de capabilities ya sabiendo
 * el tenantId (evita la query SELECT tenant_users que hace resolveUserTenant).
 *
 * Pensado para el handler de login que ya resolvió el tenant 1 vez —
 * análogo al `loadUserPermsRows` inline (auth.js línea ~261).
 *
 * @param {number} userId
 * @param {number} tenantId
 * @returns {Promise<{rol: string, caps: Set<string>|null, overrides: Array}>}
 */
async function loadUserCapsForTenant(userId, tenantId) {
  return db.withTenant(tenantId, async (client) => {
    const rolRes = await client.query(
      'SELECT rol FROM tenant_user_roles WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId],
    );

    let rol;
    if (!rolRes.rows[0]) {
      logger.warn(
        { userId, tenantId },
        'loadUserCapsForTenant: user sin fila tenant_user_roles — fallback a custom',
      );
      rol = 'custom';
    } else {
      rol = rolRes.rows[0].rol;
    }

    const ovRes = await client.query(
      `SELECT capability_slug, enabled
         FROM user_capabilities
        WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );

    const caps = resolveCaps(rol, ovRes.rows);
    return { rol, caps, overrides: ovRes.rows };
  });
}

/**
 * Para embeber en el JWT: devuelve un objeto plano { slug: true } con
 * solo las capabilities activas (omite las false). Es shape consistente
 * con el `perms` actual.
 *
 * Para owner/admin devolvemos undefined (no embebemos nada — el middleware
 * bypassea por rol embebido por separado).
 *
 * @param {string} rol
 * @param {Set<string>|null} caps — output de resolveCaps
 * @returns {Object<string, true>|undefined}
 */
function capsForJwt(rol, caps) {
  if (caps === null) return undefined; // bypass — middleware usa el rol
  const out = {};
  for (const slug of caps) out[slug] = true;
  return out;
}

module.exports = {
  resolveCaps,
  loadUserCaps,
  loadUserCapsForTenant,
  capsForJwt,
};
