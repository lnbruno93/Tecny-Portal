/* eslint-disable camelcase */
/**
 * Migration: tenant_admin_actions agrega columna `actor_type`.
 *
 * Auditoría 2026-06-30 D-22 — Red B2B mezcla actores tenant_user (operadores
 * normales del tenant que registran pagos cross-tenant, devoluciones,
 * cancelaciones, etc.) con super_admin (acciones del panel admin global) en
 * la misma tabla `tenant_admin_actions`. La columna histórica
 * `super_admin_user_id` queda con un user del tenant en esos casos — el
 * nombre semánticamente engaña: NO es un super admin.
 *
 * Decisión durable (Lucas, 2026-06-30): NO renombrar `super_admin_user_id`
 * porque rompe queries del panel super-admin app (`backend/src/routes/admin.js`
 * + `admin-frontend/`). En su lugar, agregamos columna nueva `actor_type` con
 * CHECK enum que distingue las dos clases de actor:
 *
 *   - 'super_admin' → acción del panel super-admin (plan_change, suspend,
 *     reactivate, etc.). Default para retrocompat — todas las filas existentes
 *     mantienen su semántica.
 *   - 'tenant_user' → acción originada en un endpoint de tenant que escribe
 *     audit (Red B2B partnerships, operations, pagos, devoluciones, configs).
 *
 * Beneficios:
 *   · Filtrado correcto en el panel super-admin (mostrar solo acciones reales
 *     del super-admin sin mezclar con audit operativo Red B2B).
 *   · Reportes de auditoría más precisos (quién hizo qué a nivel rol).
 *   · Defense in depth: si un super-admin user_id se filtra a un endpoint
 *     de tenant por bug, el actor_type='tenant_user' marca claramente la
 *     anomalía vs un super-admin "fingiéndose" tenant.
 *
 * El default 'super_admin' garantiza que las filas existentes no necesitan
 * backfill (todos los inserts pre-2026-06-30 fueron del panel super-admin o
 * de Red B2B — los de Red B2B históricos quedan etiquetados super_admin por
 * default, mismo comportamiento que tenían antes; los inserts NUEVOS de Red
 * B2B pasarán 'tenant_user' explícito).
 *
 * Index parcial sobre (tenant_id, actor_type) WHERE actor_type='tenant_user':
 *   filtros forenses tipo "qué hicieron los tenant_users de Tecny este mes"
 *   en O(log N + página); la mayoría de las filas viejas son super_admin, así
 *   que la fracción del índice es pequeña.
 *
 * Reversible. Down dropea columna + índice.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenant_admin_actions
      ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'super_admin'
        CHECK (actor_type IN ('super_admin', 'tenant_user'));

    COMMENT ON COLUMN tenant_admin_actions.actor_type IS
      'Auditoría 2026-06-30 D-22: clase de actor. super_admin = panel super-admin global (plan_change/suspend/etc.). tenant_user = endpoint del tenant que escribe audit (Red B2B partnerships/ops/pagos/devoluciones/config). super_admin_user_id refleja el user que ejecutó, sin importar la clase; este campo separa la SEMÁNTICA.';

    -- Index parcial para queries forenses sobre acciones de tenant_user (raras
    -- vs super_admin que son mayoría). Filtrado por tenant_id porque queries
    -- típicas son "qué hicieron los users del tenant X" → no necesitamos
    -- escanear filas super_admin.
    CREATE INDEX IF NOT EXISTS idx_tenant_admin_actions_tenant_user
      ON tenant_admin_actions (tenant_id, created_at DESC)
      WHERE actor_type = 'tenant_user';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_tenant_admin_actions_tenant_user;
    ALTER TABLE tenant_admin_actions DROP COLUMN IF EXISTS actor_type;
  `);
};
