-- ─────────────────────────────────────────────────────────────────────────────
-- diagnose-rls-drift.sql
--
-- Script de diagnóstico para el drift RLS documentado en:
--   - backend/migrations/20260724000002_backfill_nullif_rls_tables.js (no-op)
--   - backend/src/lib/rlsCanonical.js (assertRlsCoverage, chequeo 4)
--
-- Uso:
--   Corré en Railway console del backend prod (rol postgres superuser):
--     railway shell --service tecny-backend --environment production
--     psql "$DATABASE_URL"
--     \i diagnose-rls-drift.sql
--
--   O más simple, desde acá mismo:
--     railway run --service tecny-backend --environment production \
--       psql "$DATABASE_URL" -f scripts/security/diagnose-rls-drift.sql
--
-- Qué reporta:
--   Query 1: OWNERSHIP — quién es owner de cada tabla afectada. Confirma
--            que el rol de migrations (ipro_app) NO es owner de las 7
--            tablas conocidas.
--   Query 2: PREDICATE CONTENT — cuáles policies tienen NULLIF (correcto)
--            y cuáles NO (drift). Cuenta debería ser 7 con drift.
--   Query 3: RESUMEN — cuenta cuántos predicates están en drift total.
--
-- Este mismo script se corre DOS veces:
--   - ANTES del ALTER TABLE OWNER (para confirmar el estado bugueado)
--   - DESPUÉS del ALTER TABLE OWNER + migration re-run (para confirmar fix)
-- ─────────────────────────────────────────────────────────────────────────────

\echo '════════════════════════════════════════════════════════════════════════'
\echo ' Query 1 — OWNERSHIP de las 7 tablas afectadas'
\echo '════════════════════════════════════════════════════════════════════════'

SELECT
  c.relname       AS tabla,
  r.rolname       AS owner,
  CASE
    WHEN r.rolname = 'ipro_app' THEN '✅ OK'
    ELSE                             '❌ DRIFT — necesita ALTER OWNER TO ipro_app'
  END             AS estado
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE n.nspname = 'public'
  AND c.relname IN (
    'clases_producto',
    'chat_conversations',
    'chat_messages',
    'chat_rate_limits',
    'egresos_recurrentes_overrides',
    'proyecciones_mensuales',
    'share_links'
  )
ORDER BY c.relname;

\echo ''
\echo '════════════════════════════════════════════════════════════════════════'
\echo ' Query 2 — PREDICATE CONTENT (drift = NO tiene NULLIF)'
\echo '════════════════════════════════════════════════════════════════════════'

SELECT
  p.tablename,
  CASE
    WHEN p.qual LIKE '%NULLIF%' THEN '✅'
    ELSE                             '❌ DRIFT'
  END              AS using_ok,
  CASE
    WHEN p.with_check LIKE '%NULLIF%' OR p.with_check IS NULL THEN '✅'
    ELSE                                                        '❌ DRIFT'
  END              AS with_check_ok,
  LEFT(p.qual, 90) AS using_predicate
FROM pg_policies p
WHERE p.schemaname = 'public'
  AND p.policyname = 'tenant_isolation'
  AND p.tablename IN (
    'clases_producto',
    'chat_conversations',
    'chat_messages',
    'chat_rate_limits',
    'egresos_recurrentes_overrides',
    'proyecciones_mensuales',
    'share_links'
  )
ORDER BY p.tablename;

\echo ''
\echo '════════════════════════════════════════════════════════════════════════'
\echo ' Query 3 — RESUMEN cross-check con canónica (todas las tablas)'
\echo '════════════════════════════════════════════════════════════════════════'

WITH policies AS (
  SELECT
    tablename,
    (qual LIKE '%NULLIF%')                                    AS using_has_nullif,
    (with_check LIKE '%NULLIF%' OR with_check IS NULL)        AS with_check_ok
  FROM pg_policies
  WHERE schemaname = 'public'
    AND policyname = 'tenant_isolation'
)
SELECT
  COUNT(*) FILTER (WHERE NOT using_has_nullif OR NOT with_check_ok) AS tablas_en_drift,
  COUNT(*)                                                          AS total_tablas_con_policy,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE using_has_nullif AND with_check_ok) / NULLIF(COUNT(*), 0),
    1
  )                                                                 AS pct_correctas
FROM policies;

\echo ''
\echo '════════════════════════════════════════════════════════════════════════'
\echo ' Estado esperado:'
\echo '   ANTES del fix:  7 tablas en drift (owner distinto de ipro_app)'
\echo '   DESPUÉS del fix: 0 tablas en drift'
\echo '════════════════════════════════════════════════════════════════════════'
