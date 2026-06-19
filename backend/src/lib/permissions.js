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
//
// 2026-06-18 RLS NULLIF hotfix:
//   `user_permissions` tiene RLS activo. La policy filtra por tenant_id contra
//   `current_setting('app.current_tenant', true)::int`. Si la conexión está
//   limpia (sin SET LOCAL previo), `current_setting` devuelve `''` y `''::int`
//   tira `pg_strtoint32_safe`. Bug reproducido en login (que corre pre-auth).
//
//   La migration 20260618000001 ya wrappea el predicate con NULLIF para que
//   '' → NULL y la fila simplemente no pase el filtro (sin exception). Pero
//   con esa fix, queries sin SET LOCAL devuelven 0 rows — fail-closed correcto,
//   pero login necesita ver los rows del tenant del user.
//
//   Solución: los helpers de acá resuelven el tenant del user internamente y
//   wrappean la query de user_permissions en `db.withTenant(tenant_id, ...)`,
//   que setea `app.current_tenant` vía SET LOCAL. Self-contained: el caller
//   no tiene que saber nada de tenants para llamar a estos helpers.
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
  // histórico — ex "iPro Original"). En
  // este escenario, el user vería data del owner del SaaS — potencial data
  // leak. Por eso la alerta tiene que llegar rápido.
  logger.warn(
    { userId, fallback_tenant_id: 1 },
    'resolveUserTenant: user sin row en tenant_users — fallback a tenant 1 (potencial data leak)'
  );
  return { tenant_id: 1, rol: 'member' };
}

/**
 * Lee TODOS los rows de user_permissions del user (enabled + disabled).
 * Útil para el response body del login (que muestra cada tool con su estado).
 *
 * Se ejecuta en el scope del tenant del user (SET LOCAL via withTenant) para
 * que la RLS policy pase. Sin esto, devuelve 0 rows (fail-closed).
 *
 * @param {number} userId
 * @returns {Promise<Array<{tool: string, enabled: boolean}>>}
 */
async function loadUserPermsRows(userId) {
  const { tenant_id } = await resolveUserTenant(userId);
  return db.withTenant(tenant_id, async (client) => {
    const { rows } = await client.query(
      'SELECT tool, enabled FROM user_permissions WHERE user_id = $1',
      [userId]
    );
    return rows;
  });
}

/**
 * Lee el objeto de permisos enabled del user. Para embeber en JWT.
 * Devuelve { tool: true } solo para tools enabled.
 * No incluye admin bypass — lo gestiona el caller (requirePermission).
 *
 * @param {number} userId
 * @returns {Promise<Record<string, true>>}
 */
async function loadUserPerms(userId) {
  const rows = await loadUserPermsRows(userId);
  const perms = {};
  for (const r of rows) {
    if (r.enabled === true) perms[r.tool] = true;
  }
  return perms;
}

module.exports = { loadUserPerms, loadUserPermsRows, resolveUserTenant };
