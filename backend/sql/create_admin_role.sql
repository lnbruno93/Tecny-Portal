-- create_admin_role.sql — Crear role tecny_admin con BYPASSRLS para super-admin app.
--
-- NO es una migration JS porque las migrations corren con el role app
-- (NOSUPERUSER, post TANDA 0c) que NO puede ejecutar CREATE ROLE BYPASSRLS.
-- Este script lo corre el operador MANUALMENTE con un superuser de Postgres
-- (típicamente el rol "postgres" que Railway provee al crear el DB).
--
-- Idempotente: usa pg_roles para detectar si el role existe. Si existe,
-- aplica los GRANTs igual (en caso que se hayan agregado tablas nuevas
-- desde la creación inicial — re-correr este script garantiza permisos
-- en todo el schema actual).
--
-- ──────────────────────────────────────────────────────────────────────
-- USO (ver docs/admin-deploy-runbook.md para contexto completo):
--
-- 1. Generar password aleatorio:
--      openssl rand -base64 32 | tr -d '+/=' | head -c 40
--
-- 2. Setear como variable de psql:
--      \set admin_password 'COPIAR_AQUI_LA_PASSWORD'
--
-- 3. Ejecutar este script:
--      \i backend/sql/create_admin_role.sql
--
-- 4. Construir ADMIN_DATABASE_URL con esa misma password y setear en
--    Railway env vars del backend (NUNCA commitear la URL).
-- ──────────────────────────────────────────────────────────────────────

-- 1. Crear el role si no existe. Si existe, solo updateamos el password
--    (idempotente para deploys que re-corren el script).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tecny_admin') THEN
    EXECUTE format(
      'CREATE ROLE tecny_admin WITH LOGIN BYPASSRLS PASSWORD %L',
      :'admin_password'
    );
    RAISE NOTICE 'Role tecny_admin creado.';
  ELSE
    EXECUTE format(
      'ALTER ROLE tecny_admin WITH LOGIN BYPASSRLS PASSWORD %L',
      :'admin_password'
    );
    RAISE NOTICE 'Role tecny_admin ya existía — password actualizado.';
  END IF;
END
$$;

-- 2. Permisos de schema. tecny_admin puede USE el schema public.
GRANT USAGE ON SCHEMA public TO tecny_admin;

-- 3. CRUD en TODAS las tablas existentes del schema public.
--    No usamos GRANT ALL — listamos las operaciones explícitamente para
--    que un futuro audit vea qué puede hacer el role sin tener que
--    consultar la doc de pg.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tecny_admin;

-- 4. CRUD en TABLAS FUTURAS (default privileges). Sin esto, una migration
--    que crea una tabla nueva tendría que volver a correr este script.
--
--    BUG histórico (2026-06-22, C.1 #353): este script lo corre el operador
--    como superuser (postgres). `CURRENT_USER` = postgres. Postgres scope-ea
--    las default privileges al ROLE creador → solo cubren tablas creadas por
--    postgres. Pero las migrations en staging/prod corren con `ipro_app`
--    (NOSUPERUSER post TANDA 0c). Resultado: tablas creadas por migrations
--    quedan sin GRANT a tecny_admin → "permission denied" en admin app.
--
--    FIX: especificar el role explícitamente con `FOR ROLE ipro_app` así
--    las default privileges aplican a tablas creadas por ipro_app (las
--    migrations) independiente de quién corra este script. La migration
--    20260622180000_grant_admin_default_privileges.js además aplica esto
--    desde dentro de la migration misma (cubre installs ya existentes).
ALTER DEFAULT PRIVILEGES FOR ROLE ipro_app IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tecny_admin;

-- 5. SEQUENCES (BIGSERIAL las usa, los INSERTs requieren USAGE + UPDATE
--    para nextval/setval). Mismo patrón: existentes + futuras.
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO tecny_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE ipro_app IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO tecny_admin;

-- 6. FUNCIONES (algunas migraciones definen helpers; el role admin puede
--    necesitar invocarlos para reports/agregados).
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tecny_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE ipro_app IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO tecny_admin;

-- 7. Verificación post-aplicación: este SELECT debe devolver:
--    rolname='tecny_admin', rolbypassrls=true, rolcanlogin=true,
--    rolsuper=false (NO es superuser, solo bypassea RLS).
SELECT
  rolname,
  rolsuper        AS is_superuser,
  rolbypassrls    AS bypasses_rls,
  rolcanlogin     AS can_login,
  rolconnlimit    AS connection_limit
FROM pg_roles
WHERE rolname = 'tecny_admin';

-- ──────────────────────────────────────────────────────────────────────
-- ROLLBACK (si necesitás revertir):
--
--   REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM tecny_admin;
--   REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM tecny_admin;
--   REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM tecny_admin;
--   REVOKE USAGE ON SCHEMA public FROM tecny_admin;
--   ALTER DEFAULT PRIVILEGES FOR ROLE ipro_app IN SCHEMA public
--     REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM tecny_admin;
--   ALTER DEFAULT PRIVILEGES FOR ROLE ipro_app IN SCHEMA public
--     REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM tecny_admin;
--   ALTER DEFAULT PRIVILEGES FOR ROLE ipro_app IN SCHEMA public
--     REVOKE EXECUTE ON FUNCTIONS FROM tecny_admin;
--   DROP ROLE tecny_admin;
--
-- Después de DROP ROLE, sacar ADMIN_DATABASE_URL de Railway env vars.
-- Las llamadas a db.adminQuery() volverán al pool principal con un
-- warning ("ADMIN_DATABASE_URL no configurado"). El admin app va a ver
-- solo data del tenant del super-admin (RLS aplica).
-- ──────────────────────────────────────────────────────────────────────
