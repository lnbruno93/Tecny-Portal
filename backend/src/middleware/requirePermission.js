const db = require('../config/database');

/**
 * Middleware factory — verifica que el usuario tenga el permiso `tool` habilitado.
 *
 * Los admins siempre pasan (bypass implícito).
 * Si el usuario no tiene el permiso o la fila no existe, responde 403.
 *
 * Uso:
 *   router.use(requireAuth, requirePermission('financiera'));
 *
 * 2026-06-11 P-02: si el JWT trae `perms` (tokens emitidos post P-02), leemos
 * de ahí en O(1) sin query DB. Tokens legacy sin `perms` (emitidos antes del
 * deploy) caen al fallback con query DB — comportamiento idéntico al anterior.
 * Después de 8h todos los tokens activos tendrán perms en el JWT. Resuelve la
 * probable causa del incidente Railway 2026-06-10 donde auth + perms hacían
 * 3 queries DB por request y saturaban el pool al primer endpoint lento.
 */
function requirePermission(tool) {
  return async function checkPermission(req, res, next) {
    // Los admins tienen acceso a todo
    if (req.user?.role === 'admin') return next();

    // Fast path: perms embebidas en el JWT. Cero queries DB.
    if (req.user?.perms && typeof req.user.perms === 'object') {
      if (req.user.perms[tool] === true) return next();
      return res.status(403).json({ error: 'No tenés permiso para acceder a esta sección' });
    }

    // Fallback para tokens legacy sin `perms` en el payload.
    try {
      const { rows } = await db.query(
        'SELECT enabled FROM user_permissions WHERE user_id = $1 AND tool = $2',
        [req.user.id, tool]
      );

      if (!rows[0] || rows[0].enabled !== true) {
        return res.status(403).json({ error: 'No tenés permiso para acceder a esta sección' });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Helper runtime — chequea si un usuario tiene un permiso sin actuar como
 * middleware. Útil para "permisos cruzados" dentro de un handler: el endpoint
 * principal es del módulo A, pero su lógica también toca el módulo B y
 * queremos exigir ambos permisos (auditoría #H-05).
 *
 * Devuelve true si: admin, o `user_permissions(user_id, tool).enabled = true`.
 *
 * 2026-06-11 P-02: mismo fast-path que el middleware si el user trae perms
 * en el JWT.
 */
async function hasPermission(user, tool) {
  if (user?.role === 'admin') return true;
  if (!user?.id) return false;
  // Fast path: JWT con perms embebidas.
  if (user.perms && typeof user.perms === 'object') {
    return user.perms[tool] === true;
  }
  // Fallback DB para tokens legacy.
  const { rows } = await db.query(
    'SELECT enabled FROM user_permissions WHERE user_id = $1 AND tool = $2',
    [user.id, tool]
  );
  return !!rows[0] && rows[0].enabled === true;
}

module.exports = requirePermission;
module.exports.hasPermission = hasPermission;
