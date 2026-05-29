const db = require('../config/database');

/**
 * Middleware factory — verifica que el usuario tenga el permiso `tool` habilitado.
 *
 * Los admins siempre pasan (bypass implícito).
 * Si el usuario no tiene el permiso o la fila no existe, responde 403.
 *
 * Uso:
 *   router.use(requireAuth, requirePermission('financiera'));
 */
function requirePermission(tool) {
  return async function checkPermission(req, res, next) {
    // Los admins tienen acceso a todo
    if (req.user?.role === 'admin') return next();

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
 */
async function hasPermission(user, tool) {
  if (user?.role === 'admin') return true;
  if (!user?.id) return false;
  const { rows } = await db.query(
    'SELECT enabled FROM user_permissions WHERE user_id = $1 AND tool = $2',
    [user.id, tool]
  );
  return !!rows[0] && rows[0].enabled === true;
}

module.exports = requirePermission;
module.exports.hasPermission = hasPermission;
