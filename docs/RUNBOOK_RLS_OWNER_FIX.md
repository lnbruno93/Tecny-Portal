# Runbook: RLS Owner Fix (drift 7 tablas)

> **Doc parent** (multi-env drift): [`MULTI_ENV_DRIFT.md`](MULTI_ENV_DRIFT.md) —
> categoría "Schema / permisos DB (RLS)" + toxic assumption #2 ("prod y staging
> comparten la DB"). Este runbook es el procedimiento operativo específico para
> resolver el drift de las 7 tablas. Runbook hermano:
> [`RUNBOOK_MIGRATION_RLS_FORCE.md`](RUNBOOK_MIGRATION_RLS_FORCE.md) (fix pattern
> canónico para migrations con `UPDATE` sobre tabla FORCE RLS).

## Contexto

La migration `20260724000002_backfill_nullif_rls_tables.js` intentaba
`DROP POLICY IF EXISTS tenant_isolation` + `CREATE POLICY` con `NULLIF`
sobre 7 tablas afectadas por el bug pattern de Sentry #16, pero falló en
producción con:

```
error: must be owner of relation clases_producto
```

**Root cause**: el rol de migrations en prod es `ipro_app` (NOSUPERUSER).
Las 7 tablas afectadas fueron creadas por otro rol (probablemente
`postgres` superuser). `ipro_app` no puede hacer `DROP POLICY` sobre
tablas que no owns.

**Impacto real**: bajo. Las 7 policies tienen predicate SIN `NULLIF`, lo
cual repite el bug pattern de Sentry #16 (cast `''::int` throwea con
`pg_strtoint32_safe`). Sólo se dispara si algún endpoint escribe a estas
tablas SIN `SET LOCAL app.current_tenant` primero. Hoy TODAS las
escrituras a estas tablas pasan por `withTenant()`, así que el bug queda
latente pero no explota.

**Observabilidad**: el boot del server emite warning + Sentry alert
`rls_content_drift` throttled a 1/h. El warning muestra cuántos
predicates están en drift + `days_since_drift`. Si querés ver cuánto hace
que existe:

```
tail Railway logs post-boot backend
```

## Tablas afectadas (7)

- `clases_producto`
- `chat_conversations`
- `chat_messages`
- `chat_rate_limits`
- `egresos_recurrentes_overrides`
- `proyecciones_mensuales`
- `share_links`

## Procedimiento

Requiere **acceso superuser** (rol `postgres`) al DB de Railway prod. El
rol `ipro_app` (el que usa el backend) NO tiene permiso para el ALTER
TABLE OWNER.

Ejecutar en **prod primero**, después en **staging** (mismo procedimiento).

### ⚠️ Postgres tiene instancias SEPARADAS por environment

2026-07-27 lesson learned: cuando cerramos el drift la primera vez (#903),
asumimos que prod + staging compartían la misma DB porque el hostname
interno era el mismo (`postgres-auep.railway.internal`). **Es incorrecto**:
cada environment tiene su propia instancia del service `Postgres-AueP` con
su propio storage. El hostname `.railway.internal` resuelve distinto según
el env desde el que se accede.

Consecuencia: el runbook debe aplicarse **en cada environment por separado**
(prod, staging, y cualquier preview/branch env con DB propia).

### Connect strings por environment

- **Prod**: usar `railway variables --service Postgres-AueP --environment production --json` para obtener `DATABASE_PUBLIC_URL` (user=postgres superuser).
- **Staging**: `Postgres-AueP` tiene TCP proxy en `zephyr.proxy.rlwy.net:52791`. Connect string:
  ```
  postgresql://postgres:${PGPASSWORD}@zephyr.proxy.rlwy.net:52791/railway
  ```
  El `PGPASSWORD` se obtiene con `railway variables --service Postgres-AueP --environment Staging --json | jq -r .PGPASSWORD`.

### Step 1 — Diagnostic query PRE-fix

Corré el diagnostic script para confirmar el estado actual:

```bash
# Desde el clon local del repo, con Railway CLI autenticada:
railway run --service tecny-backend --environment production \
  psql "$DATABASE_URL" -f scripts/security/diagnose-rls-drift.sql
```

O bien conectá interactivo:

```bash
railway shell --service tecny-backend --environment production
psql "$DATABASE_URL"
\i scripts/security/diagnose-rls-drift.sql
```

**Esperado**: Query 1 muestra las 7 tablas con `owner != ipro_app`.
Query 2 muestra 7 tablas con `❌ DRIFT`. Query 3 muestra `tablas_en_drift = 7`
(o más si aparecieron nuevas).

Si el output es distinto (menos tablas, o el conteo no coincide), **NO
sigas** — avisá al equipo, puede haber drift adicional no previsto.

### Step 2 — ALTER TABLE OWNER (superuser)

Conectá con **rol `postgres`** (no `ipro_app`). En Railway, la variable
de entorno `DATABASE_URL` para `ipro_app` es distinta de la que expone
el rol `postgres` — pediste el connect string superuser en el dashboard
de Railway → Postgres service → Connect tab.

```sql
BEGIN;

ALTER TABLE clases_producto              OWNER TO ipro_app;
ALTER TABLE chat_conversations           OWNER TO ipro_app;
ALTER TABLE chat_messages                OWNER TO ipro_app;
ALTER TABLE chat_rate_limits             OWNER TO ipro_app;
ALTER TABLE egresos_recurrentes_overrides OWNER TO ipro_app;
ALTER TABLE proyecciones_mensuales       OWNER TO ipro_app;
ALTER TABLE share_links                  OWNER TO ipro_app;

-- Verify antes de commitear:
SELECT c.relname, r.rolname AS owner
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE n.nspname = 'public'
  AND c.relname IN (
    'clases_producto','chat_conversations','chat_messages','chat_rate_limits',
    'egresos_recurrentes_overrides','proyecciones_mensuales','share_links'
  )
ORDER BY c.relname;
-- Todas las 7 deben mostrar owner = ipro_app.

COMMIT;
```

Si el `SELECT` de verificación no muestra `ipro_app` para las 7 →
`ROLLBACK;` y avisá al equipo.

### Step 3 — Diagnostic query POST-ALTER

Re-corré el script de Step 1:

```bash
railway run --service tecny-backend --environment production \
  psql "$DATABASE_URL" -f scripts/security/diagnose-rls-drift.sql
```

**Esperado**: Query 1 ahora muestra las 7 tablas con `owner = ipro_app`
`✅ OK`. **Query 2 sigue mostrando drift** (el ALTER OWNER solo permite
el DROP POLICY futuro; no reescribe el predicate). Eso es esperado — el
predicate se arregla en Step 4.

### Step 4 — Repetir en staging

Mismo procedimiento en el ambiente `staging`:

```bash
railway run --service tecny-backend --environment staging \
  psql "$DATABASE_URL" -f scripts/security/diagnose-rls-drift.sql

# Después el ALTER TABLE OWNER en staging (SQL de Step 2) via superuser.
```

Si staging tiene el mismo drift → aplicar mismo fix. Si no (ej. staging
fue recreada más reciente y no tiene el drift) → skip Step 2 en staging.

### Step 5 — Merge el PR con la migration v2

Una vez que Step 2 confirmó `owner = ipro_app` en prod + staging, avisame
o mergeá el PR:

**PR: fix-rls-drift-owner-backfill**

El deploy Railway va a correr `migrate-timed` con la nueva migration
`20260728000001_backfill_nullif_rls_tables_v2.js`. Esta:

1. Corre un pre-check que confirma que todas las 7 tablas son owned por
   `current_user` (fail-fast si no).
2. DROP POLICY IF EXISTS + CREATE POLICY con `NULLIF` en las 7 tablas.

Si el pre-check falla → la migration aborta con mensaje claro apuntando
a este runbook. Volvés a Step 2 (probablemente algo no se completó).

### Step 6 — Verificación final

Re-corré el diagnostic script:

```bash
railway run --service tecny-backend --environment production \
  psql "$DATABASE_URL" -f scripts/security/diagnose-rls-drift.sql
```

**Esperado ahora**: Query 1 → 7 tablas con `owner = ipro_app` ✅.
Query 2 → 7 tablas con `using_ok = ✅` + `with_check_ok = ✅`. Query 3 →
`tablas_en_drift = 0`.

También chequeá en los boot logs del backend (Railway logs) que el
warning `[rlsCanonical] CONTENT drift detectado` YA NO aparece.

## Rollback plan

Si algo sale mal:

- **Post Step 2, pre Step 5**: `ROLLBACK;` — el ALTER OWNER se cancela.
- **Post Step 5 (migration corrió)**: hacer `railway rollback` a la
  deployment previa. La migration `down` restaura el predicate SIN NULLIF.
  Después de rollback, el ALTER OWNER queda hecho pero el predicate está
  bugueado igual que antes — mismo estado que hoy pre-fix.

## Post-fix cleanup

Después de que el fix esté aplicado en prod + staging + verificado:

1. Actualizar `docs/state_2026-07-20.md` para marcar follow-up #1 como
   cerrado.
2. Considerar borrar la migration no-op `20260724000002` (opcional — su
   header comment ya documenta lo que pasó, dejarla es igual de válido).
3. La Sentry alert `rls_content_drift` puede desactivarse en el
   dashboard (queda el logger.warn como observabilidad interna).
