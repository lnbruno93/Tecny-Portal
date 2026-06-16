-- setup-app-role.sql — crea el role NOSUPERUSER `ipro_app` con grants para
-- que la app corra sin bypassear RLS.
--
-- Contexto (TANDA 0c hardening multi-tenant 2026-06-16):
--   El role default de Railway/Render PostgreSQL típicamente es `postgres`
--   (SUPERUSER). Los superusers BYPASSEAN RLS incluso con FORCE ROW LEVEL
--   SECURITY — eso significa que toda la red de seguridad multi-tenant
--   instalada en PR 2 + TANDA 0c es decorativa hasta que la app corra
--   con un role NOSUPERUSER.
--
-- Cómo correr este script en prod (Railway):
--   1. Railway dashboard → proyecto iPro → Postgres add-on → "Connect" →
--      "Query" (la consola SQL embebida).
--   2. Pegar este script. Reemplazar `'PASSWORD_SEGURO_AQUI'` por una
--      password fuerte (32+ chars random). Generala con:
--        openssl rand -base64 24
--   3. Run.
--   4. Verificar que el role se creó:
--        SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname='ipro_app';
--      Debe devolver `ipro_app | f | t`.
--   5. Cambiar la env var `DATABASE_URL` en el servicio backend de Railway
--      a la nueva connection string usando `ipro_app`. Railway redeploya
--      automáticamente al guardar la env var.
--   6. Tail los logs del nuevo pod por 1-2 minutos. Si todo OK → DONE.
--      Si hay errores "permission denied for table X" → algún GRANT
--      faltante, agregar y re-correr ese GRANT puntual.
--
-- Rollback: cambiar DATABASE_URL de vuelta al role superuser. Railway
-- redeploya. El role ipro_app queda en la DB sin uso (no borrar
-- inmediatamente; podés necesitarlo si decidís re-cerrar).
--
-- Idempotente: las cláusulas IF NOT EXISTS / OR REPLACE permiten re-correr
-- sin error. Solo el CREATE ROLE primer arranque falla si ya existe, pero
-- el script usa DO block para detectarlo.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ipro_app') THEN
    -- IMPORTANTE: reemplazar la password antes de correr.
    CREATE ROLE ipro_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      PASSWORD 'PASSWORD_SEGURO_AQUI';
  END IF;
END
$$;

-- Permisos sobre el schema público (necesarios para que ipro_app pueda
-- "ver" las tablas — el GRANT en tablas no implica USAGE del schema).
GRANT USAGE ON SCHEMA public TO ipro_app;

-- DML sobre TODAS las tablas existentes. RLS sigue filtrando por tenant_id;
-- estos grants solo dicen "tenés permiso de operar sobre las tablas" — el
-- WHERE de la policy decide qué filas.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ipro_app;

-- Lo mismo para las secuencias (auto-increment de PKs).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ipro_app;

-- Tablas/secuencias futuras (cuando corras migraciones nuevas siendo
-- superuser, las nuevas tablas heredan estos grants automáticamente).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ipro_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ipro_app;

-- Permitir setear la GUC `app.current_tenant`. La GUC es session-local;
-- ipro_app necesita poder ejecutar `SET LOCAL app.current_tenant = N` sin
-- error. PostgreSQL permite SET LOCAL para GUCs custom (prefijo con punto)
-- a cualquier role por default — este GRANT es defensivo.
GRANT SET ON PARAMETER app.current_tenant TO ipro_app;

-- Verificación
SELECT
  rolname,
  rolsuper      AS is_superuser,
  rolcanlogin   AS can_login,
  rolcreaterole AS can_create_role,
  rolcreatedb   AS can_create_db
FROM pg_roles
WHERE rolname = 'ipro_app';
-- Debe devolver: ipro_app | f | t | f | f
