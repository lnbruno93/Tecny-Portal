// permissions.js — helper para resolver el tenant default de un usuario.
//
// Historia: este archivo contenía además `loadUserPerms` y `loadUserPermsRows`
// para el sistema viejo de 14 booleans (`user_permissions`). En F4 (cutover
// capability-based, 2026-06-23) se retiraron. Lo único que sobrevive es
// `resolveUserTenant` — sigue siendo el helper canónico para resolver el
// tenant default del user y lo usan auth, capabilities, etc.
//
// Si querés capabilities del user, usar `loadUserCaps` en
// `backend/src/lib/capabilities.js` (paralelo a esto, mismo patrón
// withTenant + fallback log).

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

  // 2026-06-18 #319 hygiene: el fallback NO debería dispararse en producción.
  // Todos los users post-multitenant-PR1 tienen row en tenant_users (backfill
  // + signup endpoint los crea siempre, en la misma tx que crea el user).
  // Si llegamos acá, es un edge case sospechoso:
  //   - Race condition raro en alguna tx (no debería ocurrir).
  //   - User legacy pre-PR1 que escapó al backfill (tampoco debería existir).
  //   - Bug nuevo en algún flow que crea users sin bridge.
  //
  // Log como WARN: el sistema NO se rompe (el fallback funciona), pero hay
  // que investigar. WARN dispara alerta en Sentry/observabilidad sin afectar
  // al user. El equipo OPS revisa y decide: mover al tenant correcto, o
  // deshabilitar el user si es zombi.
  //
  // SEGURIDAD: el fallback asigna al user a tenant 1 (Tecny, el tenant
  // histórico — ex "iPro Original"). En este escenario, el user vería data
  // del owner del SaaS — potencial data leak. Por eso la alerta tiene que
  // llegar rápido.
  logger.warn(
    { userId, fallback_tenant_id: 1 },
    'resolveUserTenant: user sin row en tenant_users — fallback a tenant 1 (potencial data leak)'
  );
  return { tenant_id: 1, rol: 'member' };
}

module.exports = { resolveUserTenant };
