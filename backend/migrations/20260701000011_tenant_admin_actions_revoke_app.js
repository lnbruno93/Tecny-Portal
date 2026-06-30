/**
 * Migration: REVOKE permisos de `ipro_app` sobre `tenant_admin_actions`.
 *
 * Auditoría 2026-06-30 S-03 (defense-in-depth, no explotable hoy).
 *
 * Contexto:
 *   `tenant_admin_actions` es el audit trail forense de cambios super-admin
 *   (ver 20260621000001_admin_tenants.js). Sin RLS deliberadamente — el
 *   acceso lo gatea el middleware `requireSuperAdmin` en el endpoint, no
 *   una policy. Pero por default, `ipro_app` (el role NOSUPERUSER del pool
 *   de la app del portal) recibió SELECT/INSERT/UPDATE/DELETE por la
 *   directiva `ALTER DEFAULT PRIVILEGES` de
 *   20260622180000_grant_admin_default_privileges.js — que no aplica al
 *   admin pool sino al app pool: el OWNER de la tabla es `ipro_app`.
 *
 *   Defense-in-depth perdido: si un endpoint del portal normal (no super-admin)
 *   tuviera por error un query a `tenant_admin_actions` con `db.query()`
 *   (pool de la app), tendría acceso de lectura/escritura cross-tenant —
 *   no hay RLS que lo limite.
 *
 *   Hoy NO es explotable porque:
 *     · Los 4 routes de Red B2B (operations, pagos, partnerships, config) +
 *       superAdmin.js que escriben a tenant_admin_actions usan TODOS
 *       db.adminQuery() (BYPASSRLS pool = role tecny_admin), no db.query().
 *     · No hay GET endpoints del portal que lean tenant_admin_actions
 *       (solo el panel de super-admin lo lee, también via adminQuery).
 *
 *   Pero si alguien agrega mañana un endpoint que lee/escribe via db.query()
 *   por error, el bug pasaría sin hacer ruido — perdimos la red de seguridad.
 *
 * Fix:
 *   REVOKE SELECT, INSERT, UPDATE, DELETE de ipro_app sobre la tabla.
 *   El pool admin (role tecny_admin con BYPASSRLS) sigue teniendo todo
 *   porque tiene GRANT ALL del setup inicial + default privileges.
 *
 *   Tolerancia a entornos sin ipro_app: en dev local, test y CI el role
 *   `ipro_app` NO existe (igual que tecny_admin — ver
 *   20260622180000_grant_admin_default_privileges.js para el pattern).
 *   Envolvemos en DO block con IF EXISTS para no romper migrate en CI.
 *
 *   También revocamos privilegios DEFAULT sobre tablas FUTURAS para que si
 *   alguien crea una tabla "admin-only" con el mismo patrón (sin RLS), no
 *   herede el grant a ipro_app. NO hacemos esto porque rompería el resto de
 *   tablas creadas en el futuro que SÍ son tenant-scoped y SÍ necesitan
 *   acceso de ipro_app. La cobertura es solo esta tabla específica.
 *
 * Reversible: la down restaura los GRANTs.
 */

/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Auditoría 2026-06-30 S-03: REVOKE permisos directos de ipro_app sobre
    -- tenant_admin_actions. El acceso real sigue siendo solo via adminQuery
    -- (role tecny_admin con BYPASSRLS).
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ipro_app') THEN
        EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON tenant_admin_actions FROM ipro_app';
        RAISE NOTICE '[tenant_admin_actions_revoke_app] REVOKE aplicado a ipro_app';
      ELSE
        RAISE NOTICE '[tenant_admin_actions_revoke_app] role ipro_app no existe — skip (dev/test/CI).';
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    -- Restaurar los GRANTs originales (los que default privileges habían
    -- otorgado). Idempotente — si ya están, GRANT no rompe.
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ipro_app') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_admin_actions TO ipro_app';
      END IF;
    END
    $$;
  `);
};
