// requireCapability.js — middleware análogo a requirePermission, pero opera
// sobre capability slugs (granulares) en lugar de tools (14 booleans).
//
// 2026-06-23 F1: este middleware existe pero ninguna route lo usa todavía
// (shadow mode). F3 hace el refactor de routes. F4 dropea requirePermission.
//
// Estrategia idéntica al middleware viejo:
//   1. Owner/admin del tenant pasan siempre (bypass por rol).
//   2. Fast path: JWT trae `caps` embebidas (objeto { slug: true }).
//   3. Fallback: query DB con loadUserCaps (tokens legacy sin caps).
//
// El rol del tenant se embebe en JWT como `tenant_cap_rol` (separado de
// `tenant_rol` que es el rol legacy de tenant_users). Eso permite el
// bypass owner/admin sin hacer DB query.

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
 * Combina bien con requirePermission durante el shadow mode (F1-F3):
 *   router.delete('/:id',
 *     requireAuth,
 *     requirePermission('ventas'),       // gate viejo
 *     requireCapability('ventas.eliminar'),  // gate nuevo
 *     handler);
 *
 * @param {string} slug — capability slug (formato 'pantalla.capability')
 */
function requireCapability(slug) {
  return async function checkCapability(req, res, next) {
    // 1) Bypass por rol legacy (admin global). Mantenemos compat con el
    // sistema viejo durante shadow mode — un user con users.role='admin'
    // tiene libre tránsito hasta F4.
    if (req.user?.role === 'admin') return next();

    // 2) Bypass por rol del tenant (owner/admin del tenant — sistema
    // nuevo). Si el JWT embebió el rol nuevo, lo usamos.
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

    // 4) Fallback DB para tokens legacy sin `caps` ni `tenant_cap_rol`.
    // Resolución completa: rol + overrides. Costo equivalente a la
    // query antigua de user_permissions — aceptable durante shadow mode.
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

module.exports = requireCapability;
module.exports.hasCapability = hasCapability;
