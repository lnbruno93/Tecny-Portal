/**
 * Migration: drop tabla `user_permissions` y artefactos asociados
 * (Permisos F4 — cutover capability-based 2026-06-23).
 *
 * Esta migration elimina el sistema viejo. Pre-condiciones:
 *   - F1 (capability_catalog + tenant_user_roles + user_capabilities) ya
 *     corrió (migration 20260623220000) y backfilleó las filas.
 *   - F3 reemplazó todos los `requirePermission(...)` por `requireCapability(...)`.
 *   - F4 backend retiró loadUserPermsRows, requirePermission middleware,
 *     perms en JWT, perms en response de login.
 *   - F4 frontend retiró RequirePermission y referencias a user.perms.
 *
 * Esta migration:
 *   1. Drop policy RLS sobre user_permissions (sino el DROP TABLE puede
 *      fallar dependiendo del role).
 *   2. Drop tabla user_permissions (CASCADE para limpiar índices + FK
 *      restantes).
 *
 * Reversible: la `down` recrea la tabla vacía. Los datos NO se recuperan
 * (los del backfill capability_catalog ya están en user_capabilities +
 * tenant_user_roles). Si alguien necesita revertir F4 en prod, hay que
 * restaurar de backup PG previo al deploy + redeploy del código viejo —
 * no es un rollback automático.
 *
 * 2026-06-23: el sistema viejo flat `(user_id, tool, enabled)` con 14
 * booleans queda enterrado. Lo reemplaza:
 *   - tenant_user_roles.rol — owner|admin|vendedor|encargado|lectura|custom
 *   - user_capabilities — overrides granulares por capability slug
 *   - JWT.caps + tenant_cap_rol — fast-path runtime
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Drop policy RLS (defensive — el DROP TABLE igual la borra).
    DROP POLICY IF EXISTS tenant_isolation ON user_permissions;

    -- 2. Drop tabla. CASCADE limpia índices + cualquier FK pendiente
    -- (no debería haber — el sistema viejo era stand-alone, pero defensive).
    DROP TABLE IF EXISTS user_permissions CASCADE;
  `);
};

exports.down = (pgm) => {
  // Restaura la tabla VACÍA (estructura original de migration 20260521000001
  // + sumas de CHECK constraint de migraciones 20260522000008 + 20260524000002 +
  // 20260525000002 + 20260529000001 + 20260530000001 que ampliaron el enum
  // a 14 tools). Sin esto, el down no es ejecutable en entornos que arrancaron
  // sin el sistema viejo.
  pgm.sql(`
    CREATE TABLE user_permissions (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool       TEXT    NOT NULL
                 CHECK (tool IN (
                   'cotizador', 'financiera', 'cajas', 'envios',
                   'usuarios', 'cuentas', 'usados', 'inventario', 'ventas',
                   'proveedores', 'proyectos', 'contactos', 'cambios', 'tarjetas'
                 )),
      enabled    BOOLEAN NOT NULL DEFAULT false,
      tenant_id  INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, tool)
    );

    CREATE INDEX idx_user_permissions_user_id ON user_permissions(user_id);

    ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE user_permissions FORCE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation ON user_permissions
      FOR ALL TO PUBLIC
      USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
  `);
};
