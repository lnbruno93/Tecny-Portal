/**
 * Migration: hotfix de GRANT a tecny_admin sobre plan_prices + corrección
 * estructural de default privileges (C.1 follow-up #353, 2026-06-22).
 *
 * Bug post-mortem:
 *
 *   En staging/prod, las migrations corren con el role `ipro_app`
 *   (NOSUPERUSER post TANDA 0c). `tecny_admin` (BYPASSRLS, pool admin
 *   separado) accede vía db.adminQuery() y necesita GRANT explícito en
 *   cada tabla.
 *
 *   El setup inicial `backend/sql/create_admin_role.sql` granteó
 *   `ALL TABLES IN SCHEMA public` cuando se corrió → eso cubrió las
 *   tablas existentes. PERO la directiva:
 *
 *     ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
 *       GRANT ... ON TABLES TO tecny_admin;
 *
 *   usa `CURRENT_USER` = quien corrió el script (`postgres` superuser),
 *   no `ipro_app`. Postgres scope-ea las default privileges al ROLE
 *   creador; si las futuras tablas las crea `ipro_app` (las migrations),
 *   las default privileges de `postgres` NO aplican.
 *
 *   Resultado: `plan_prices` — primera tabla creada por ipro_app
 *   DESPUÉS del setup admin — quedó sin GRANT a tecny_admin. El admin
 *   app abrió /planes → `db.adminQuery('SELECT FROM plan_prices')` →
 *   `permission denied for table plan_prices` → 500 → Sentry alerta.
 *
 * Fix (esta migration):
 *
 *   1. GRANT inmediato sobre `plan_prices` (la única tabla nueva
 *      afectada — todas las anteriores tienen GRANT del setup).
 *   2. ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER — pero esta vez
 *      `CURRENT_USER` ES `ipro_app` (porque la migration corre como
 *      ipro_app en staging/prod). Eso garantiza que cualquier tabla
 *      futura creada por ipro_app tenga GRANT a tecny_admin
 *      automáticamente. No vamos a tropezar de nuevo.
 *   3. Mismo patrón para SEQUENCES y FUNCTIONS, por simetría con el
 *      script setup original (aunque plan_prices no usa sequence,
 *      futuras tablas sí podrán).
 *
 * Tolerancia a entornos sin tecny_admin:
 *
 *   En dev local, test y CI, el role `tecny_admin` NO existe — el
 *   setup admin solo se corre en staging/prod. El bloque DO con
 *   `IF EXISTS (...pg_roles...)` skip-ea el GRANT silenciosamente.
 *   Sin esto, `npm run migrate` rompería en dev/CI con
 *   `role "tecny_admin" does not exist`.
 *
 * Reversible:
 *
 *   La `down` revoca los GRANTs si tecny_admin existe. Es destructivo
 *   para el admin app — solo correr down como rollback consciente.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tecny_admin') THEN
        -- 1. Fix inmediato: GRANT sobre plan_prices (creada en
        --    20260622153000 pero sin GRANT por el bug arriba descripto).
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON plan_prices TO tecny_admin';

        -- 2. Default privileges para FUTURAS tablas creadas por el role
        --    actual (ipro_app en staging/prod). Idempotente — re-correr
        --    no rompe nada, Postgres mergea las directivas.
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public ' ||
                'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tecny_admin';
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public ' ||
                'GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO tecny_admin';
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public ' ||
                'GRANT EXECUTE ON FUNCTIONS TO tecny_admin';

        RAISE NOTICE '[grant_admin_default_privileges] tecny_admin GRANTed on plan_prices + default privileges seteadas para CURRENT_USER (%)', CURRENT_USER;
      ELSE
        RAISE NOTICE '[grant_admin_default_privileges] role tecny_admin no existe — skip (dev/test/CI). En staging/prod debería existir.';
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tecny_admin') THEN
        EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE ON plan_prices FROM tecny_admin';
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public ' ||
                'REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM tecny_admin';
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public ' ||
                'REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM tecny_admin';
        EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public ' ||
                'REVOKE EXECUTE ON FUNCTIONS FROM tecny_admin';
      END IF;
    END
    $$;
  `);
};
