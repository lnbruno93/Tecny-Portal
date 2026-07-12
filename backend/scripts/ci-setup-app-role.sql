-- ci-setup-app-role.sql — versión CI del setup-app-role.sql de prod.
--
-- 2026-07-12 (auditoría TOTAL Plataforma P1-2):
--
-- Contexto: en prod, la app corre bajo `ipro_app` NOSUPERUSER (creado con
-- setup-app-role.sql). Los superusers BYPASSEAN RLS incluso con FORCE ROW
-- LEVEL SECURITY — si el CI corre migrations + tests bajo un role superuser
-- (default de Postgres Docker), NO reproducimos el escenario prod y una
-- migration puede pasar CI + romper prod (exactamente el incident F1 del
-- 2026-07-09).
--
-- Este script se corre en CI DESPUÉS de las migrations (que corren con el
-- superuser default `ipro`) para crear el role `ipro_app` con los mismos
-- grants que prod y correr el test suite `migrations-rls-nosuperuser.test.js`
-- bajo ese role. Si una migration usó SUPERUSER-only features (BYPASSRLS,
-- ALTER SYSTEM, etc.) o hace backfill sin `SET LOCAL app.current_tenant`
-- sobre tabla FORCE RLS, el test explota en CI en lugar de en prod.
--
-- Diferencia con setup-app-role.sql de prod:
--   · Password hardcoded (test-only, no sensible)
--   · Sin verbose comments (leer setup-app-role.sql para el rationale)
--   · Idempotente (safe re-run entre CI runs)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ipro_app') THEN
    CREATE ROLE ipro_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      PASSWORD 'ci_test_password_not_for_prod';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ipro_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ipro_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ipro_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ipro_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ipro_app;
GRANT SET ON PARAMETER app.current_tenant TO ipro_app;

-- Verificación de baseline
SELECT
  rolname,
  rolsuper      AS is_superuser,
  rolcanlogin   AS can_login,
  rolcreaterole AS can_create_role,
  rolcreatedb   AS can_create_db
FROM pg_roles
WHERE rolname = 'ipro_app';
-- Debe devolver: ipro_app | f | t | f | f
