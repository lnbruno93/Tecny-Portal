// permissions.js — helpers para leer permisos del usuario.
//
// 2026-06-11 P-02: introducido para evitar la query DB por request del middleware
// `requirePermission`. Estrategia:
//
//   1) Al login (y change-password / setup-2fa), leemos los permisos del usuario
//      desde `user_permissions` UNA sola vez y los embebimos en el JWT como objeto
//      `perms` ({ tool: boolean }).
//   2) `requirePermission(tool)` ahora lee de `req.user.perms[tool]` (O(1) en
//      memoria, sin query DB).
//   3) Cuando el admin cambia permisos via PUT /usuarios/:id, bumpeamos
//      `password_changed_at` del afectado → el middleware `requireAuth` invalida
//      el token al siguiente request y el user re-loguea para recibir nuevos perms.
//
// Esto resuelve la causa probable del incidente Railway 2026-06-10: antes el
// auth flow hacía 3 queries DB por request (rate-limit UPSERT + password_changed_at
// + perms), saturando el pool cuando una query lenta de /api/ventas bloqueaba una
// conexión.
const db = require('../config/database');

/**
 * Lee el objeto de permisos de un usuario desde DB.
 * Devuelve { tool: true } solo para tools enabled.
 * No incluye admin bypass — lo gestiona el caller (requirePermission).
 *
 * @param {number} userId
 * @returns {Promise<Record<string, true>>}
 */
async function loadUserPerms(userId) {
  const { rows } = await db.query(
    'SELECT tool, enabled FROM user_permissions WHERE user_id = $1',
    [userId]
  );
  const perms = {};
  for (const r of rows) {
    if (r.enabled === true) perms[r.tool] = true;
  }
  return perms;
}

module.exports = { loadUserPerms };
