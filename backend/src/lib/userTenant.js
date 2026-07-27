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
 * ⚠️  Deuda arquitectónica documentada (P1-6 audit 07-25, P2-2 audit 07-12):
 *
 * El `ORDER BY tenant_id ASC LIMIT 1` es determinista pero SILENCIOSO — cuando
 * un user pertenece a >1 tenant (super-admins invitados vía `publicSuperAdminInvite`,
 * futuro caso de user que ve ambos lados de un partnership Red B2B), el JWT
 * queda anclado al tenant de menor ID sin señal. El chat bot / capabilities /
 * withTenant scoping todos usan ese tenant embebido. No hay manera de "cambiar
 * de tenant activo" hoy.
 *
 * **Fix corto plazo (2026-07-27 Sprint 3 Fix 1)**: log WARN cuando hay >1 row
 * en tenant_users → visibility sobre la ambigüedad silenciosa. Sentry alert
 * futura puede capturar el pattern para saber cuántos users afectados hay
 * hoy en prod.
 *
 * **Fix largo plazo (1 semana, deferred)**: header `X-Active-Tenant-Id` +
 * validación en `requireAuth`. JWT embebe LISTA de tenants; header selecciona
 * el activo. Requiere refactor de `capabilities.js`, `withTenant`, y frontend
 * — discutir con Lucas antes.
 *
 * @param {number} userId
 * @returns {Promise<{tenant_id: number, rol: string}>}
 */
async function resolveUserTenant(userId) {
  // 2026-07-27 (audit 07-25 Track C P1-6): SELECT hasta 2 rows para detectar
  // multi-tenant users. Con LIMIT 2, seguimos siendo O(index scan) para el
  // caso normal (1 row) y captamos el edge case sin query extra. Elegimos
  // el mismo `ORDER BY tenant_id ASC LIMIT 1` original en el return (idéntico
  // comportamiento) pero loggeamos si vino un segundo row.
  const { rows } = await db.query(
    `SELECT tenant_id, rol FROM tenant_users
      WHERE user_id = $1
      ORDER BY tenant_id ASC LIMIT 2`,
    [userId]
  );

  if (rows[0]) {
    if (rows.length > 1) {
      // Ambiguity signal: user tiene ≥ 2 tenant_users. Log WARN para
      // observabilidad. El chat bot / requireAuth / capabilities siguen
      // usando el tenant de menor ID por compat, pero Lucas queda avisado
      // de que este user es candidato al feature multi-tenant per user.
      logger.warn({
        userId,
        chosen_tenant_id: rows[0].tenant_id,
        chosen_rol: rows[0].rol,
        next_tenant_id: rows[1].tenant_id,
        next_rol: rows[1].rol,
        source: 'resolveUserTenant_multi_tenant_ambiguity',
      }, `⚠️  User pertenece a ≥2 tenants — JWT queda anclado al menor ID (${rows[0].tenant_id}). Deuda arquitectónica P1-6 audit 07-25. Ver docstring de resolveUserTenant.`);
    }
    return rows[0];
  }

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
