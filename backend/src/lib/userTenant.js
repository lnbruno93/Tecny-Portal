// userTenant.js — helper para resolver el tenant default de un usuario.
//
// Renombrado desde `permissions.js` (junio 2026) tras el cutover capability-
// based: el archivo original contenía además `loadUserPerms`/`loadUserPermsRows`
// del sistema viejo de 14 booleans. Tras F4 quedó solo `resolveUserTenant` y
// el nombre `permissions.js` confundía: el lector cold suponía que este era
// el módulo del nuevo sistema de permisos.
//
// Si querés capabilities del user, usar `loadUserCaps` en `lib/capabilities.js`
// (paralelo a esto, mismo patrón withTenant + fallback log).

const db = require('../config/database');
const logger = require('./logger');

/**
 * Resuelve el tenant default del user (el de menor id si tiene varios).
 * `tenant_users` NO tiene RLS, así que esta query funciona sin contexto.
 *
 * @param {number} userId
 * @returns {Promise<{tenant_id: number, rol: string}>}
 */
async function resolveUserTenant(userId) {
  const { rows } = await db.query(
    `SELECT tenant_id, rol FROM tenant_users
      WHERE user_id = $1
      ORDER BY tenant_id ASC LIMIT 1`,
    [userId]
  );

  if (rows[0]) return rows[0];

  // 2026-06-24 SEG-2 (audit pre-live, perfeccionismo go-live):
  // antes devolvíamos un fallback silencioso `{ tenant_id: 1, rol: 'member' }`
  // con WARN log. El problema: fail-OPEN en una decisión de aislamiento.
  // Si un user llegaba acá (race en signup parcial, backfill incompleto,
  // bug en algún flow que crea users sin bridge), terminaba viendo datos
  // de tenant 1 (Tecny, el tenant del owner del SaaS).
  //
  // Ahora fail-CLOSED: throw 401 con código NO_TENANT. El caller (login,
  // /me) lo convierte en respuesta 401 al cliente, que debe forzar logout.
  // El user queda bloqueado hasta que OPS lo asigne manualmente a un tenant.
  //
  // Se sigue emitiendo el WARN para que aparezca en Sentry/observabilidad
  // (incidente operacional que requiere intervención humana).
  logger.warn(
    { userId },
    'resolveUserTenant: user sin row en tenant_users — fail-closed 401 NO_TENANT'
  );
  const err = new Error('El usuario no está asignado a una organización. Contactá soporte.');
  err.status = 401;
  err.code = 'NO_TENANT';
  throw err;
}

module.exports = { resolveUserTenant };
