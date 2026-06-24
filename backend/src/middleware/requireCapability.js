// requireCapability.js — middleware de autorización capability-based.
// Sustituyó al viejo `requirePermission` (14 booleans flat) en el cutover
// de junio 2026. Opera sobre slugs granulares del catálogo (45 capabilities,
// 19 pantallas — ver lib/capabilityCatalog.js).
//
// Estrategia:
//   1. Bypass admin global (users.role='admin' — super-admin de plataforma).
//   2. Bypass por rol del tenant en JWT (owner/admin del tenant).
//   3. Fast path: caps embebidas en el JWT (objeto { slug: true }).
//   4. Fallback DB: query loadUserCaps (tokens sin `caps` claim).
//
// El rol del tenant se embebe en JWT como `tenant_cap_rol`, separado de
// `tenant_rol` (que es el rol viejo de tenant_users — mantenido para
// adminOnly hasta cleanup completo). Eso permite el bypass owner/admin
// sin hacer DB query.

const { loadUserCaps } = require('../lib/capabilities');
const { isBypassRole } = require('../lib/roleDefaults');

/**
 * Middleware factory — exige que el user tenga la capability `slug`.
 *
 * Responde 403 con código GENERIC si no la tiene. El mensaje es genérico
 * para no leakear detalles de permisos a un atacante.
 *
 * Uso:
 *   router.delete('/:id', requireAuth, requireCapability('ventas.eliminar'), handler);
 *
 * @param {string} slug — capability slug (formato 'pantalla.capability')
 */
function requireCapability(slug) {
  return async function checkCapability(req, res, next) {
    // 1) Bypass admin global (users.role='admin'). Es el super-admin de la
    // plataforma — distinto del owner/admin del tenant (sistema nuevo).
    if (req.user?.role === 'admin') return next();

    // 2) Bypass por rol del tenant (owner/admin del tenant). Si el JWT
    // embebió el rol, lo usamos sin pegar a DB.
    if (req.user?.tenant_cap_rol && isBypassRole(req.user.tenant_cap_rol)) {
      return next();
    }

    // 3) Fast path: caps embebidas en el JWT.
    if (req.user?.caps && typeof req.user.caps === 'object') {
      if (req.user.caps[slug] === true) return next();
      return res.status(403).json({
        error: 'No tenés permiso para esta acción',
      });
    }

    // 4) Fallback DB para tokens sin `caps` ni `tenant_cap_rol` (legacy
    // emitidos antes del cutover, o casos edge). Resolución completa:
    // rol + overrides.
    try {
      const { rol, caps } = await loadUserCaps(req.user.id);

      // Bypass tras lookup (user pudo no tener caps en JWT pero ser owner).
      if (isBypassRole(rol)) return next();

      // caps puede ser null si isBypassRole — pero ya retornamos arriba,
      // así que acá es Set.
      if (caps.has(slug)) return next();

      return res.status(403).json({
        error: 'No tenés permiso para esta acción',
      });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Helper runtime — mismo patrón que hasPermission del sistema viejo.
 * Útil para checks "cruzados" dentro de un handler que no es el dueño
 * directo del slug (caso típico: un endpoint del módulo A que muta data
 * que el sistema visualmente atribuye al módulo B).
 *
 * @param {object} user — req.user (puede traer caps embebidas)
 * @param {string} slug — capability a chequear
 * @returns {Promise<boolean>}
 */
async function hasCapability(user, slug) {
  if (user?.role === 'admin') return true;
  if (user?.tenant_cap_rol && isBypassRole(user.tenant_cap_rol)) return true;
  if (!user?.id) return false;

  if (user.caps && typeof user.caps === 'object') {
    return user.caps[slug] === true;
  }

  const { rol, caps } = await loadUserCaps(user.id);
  if (isBypassRole(rol)) return true;
  return caps.has(slug);
}

/**
 * 2026-06-23 F5c: variante OR de requireCapability. Pasa si el user tiene
 * AL MENOS UNA de las capabilities del array. Útil para pantallas con tabs
 * cada uno gateado por su propia cap (config: general/alertas/mantenimiento)
 * — el route de la pantalla debería abrirse si el user puede ver CUALQUIERA
 * de los tabs. Después la página interna esconde los tabs que el user no
 * tiene.
 *
 * @param {string[]} slugs — array de capability slugs
 */
function requireAnyCapability(slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) {
    throw new Error('requireAnyCapability: slugs debe ser array no vacío');
  }
  return async function checkAny(req, res, next) {
    // Mismos bypasses que requireCapability single.
    if (req.user?.role === 'admin') return next();
    if (req.user?.tenant_cap_rol && isBypassRole(req.user.tenant_cap_rol)) {
      return next();
    }

    // Fast path: caps en JWT.
    if (req.user?.caps && typeof req.user.caps === 'object') {
      if (slugs.some(s => req.user.caps[s] === true)) return next();
      return res.status(403).json({
        error: 'No tenés permiso para esta acción',
      });
    }

    // Fallback DB.
    try {
      const { rol, caps } = await loadUserCaps(req.user.id);
      if (isBypassRole(rol)) return next();
      if (slugs.some(s => caps.has(s))) return next();
      return res.status(403).json({
        error: 'No tenés permiso para esta acción',
      });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = requireCapability;
module.exports.requireAnyCapability = requireAnyCapability;
module.exports.hasCapability = hasCapability;
