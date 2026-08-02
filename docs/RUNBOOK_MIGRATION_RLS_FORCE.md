# Runbook: Migration falla en prod por FORCE ROW LEVEL SECURITY

> **Doc parent** (multi-env drift): [`MULTI_ENV_DRIFT.md`](MULTI_ENV_DRIFT.md) —
> categoría "Schema / permisos DB (RLS)" + toxic assumption #3 ("CI corre
> migrations con el mismo role que prod") y #5 ("emails Build failed! de
> Railway == build falló"). Runbook hermano:
> [`RUNBOOK_RLS_OWNER_FIX.md`](RUNBOOK_RLS_OWNER_FIX.md) (drift de las 7 tablas
> con owner incorrecto).

## Contexto

**Incident 2026-08-01 (~10h downtime todos los tenants)**: PR #965 mergeado
~05:15 UTC. Backend Railway prod entra en loop de crash: cada intento de
deploy termina en `Starting Container → Stopping Container` en <1s. Frontend
Netlify sí deploya, entonces todos los tenants ven "Datos inválidos" al
editar/crear productos e importar XLSX (bundle nuevo manda campos que
backend viejo — versión pre-#965 que sigue corriendo — no conoce).

**Root cause**: la migration `20260801100000_backfill_ganancia_usd_sin_vuelto`
usaba el patrón:

```sql
DO $$
BEGIN
  SET LOCAL row_security = off;
  UPDATE ventas SET ... ;
END $$;
```

En prod, `ipro_app` es owner de `ventas` — el comment de la migration
asumía que "owner puede bypasear via `row_security = off`". **Incorrecto
cuando la tabla tiene `FORCE ROW LEVEL SECURITY` activo** (53 de 57 tablas
RLS del proyecto lo tienen — es el patrón dominante desde el hardening
2026-07-25).

Con FORCE RLS + owner sin `BYPASSRLS`, el UPDATE tira:

```
ERROR: query would be affected by row-level security policy for table "ventas"
HINT: To disable the policy for the table's owner, use
      ALTER TABLE NO FORCE ROW LEVEL SECURITY.
```

`npm run migrate` retorna exit non-zero → `npm start` (que corre `migrate
&& node ...`) nunca llega a arrancar el node → container muere en <1s →
Railway lo intenta 2 veces más (el patrón "3 retries") y se rinde
manteniendo el container VIEJO corriendo. Los emails "Build failed!"
mienten un poco: **el build fue OK, lo que falla es el deploy step**.

## Por qué CI verde

El job `NOSUPERUSER RLS Tests` (Sprint 6 del audit 07-12) corre
migrations con el role `ipro` que es SUPERUSER del Postgres Docker default
→ bypasea RLS incluso con FORCE. El role `ipro_app` (NOSUPERUSER) solo se
usa DESPUÉS del `npm run migrate`, para los smoke tests. Gap: el step de
migrate NUNCA se probó como NOSUPERUSER hasta el hardening del 2026-08-01.

Fix del CI: nuevo step "Migrations from-scratch as ipro_app NOSUPERUSER
(owner-of-schema)" en `.github/workflows/ci.yml` — crea DB fresca donde
`ipro_app` es owner del schema, y corre `npm run migrate` como
`ipro_app`. Cualquier migration que use un feature superuser-only revienta
en CI antes del merge.

## Diagnostic checklist (si vuelve a pasar)

Cuando ves que un deploy Railway está en loop de crash <1s post-migrate,
seguí ESTOS pasos ANTES de reventar por logs:

### 1. Confirmar que el crash es en migrate, no en el node runtime

```bash
railway logs --deployment <FAILED_ID> --project vibrant-freedom \
  --service tecny-backend --environment production | tail -20
```

Si ves `Starting Container → Stopping Container` con SQL text del migration
en el medio, y NO ves los logs normales de boot (`iPro API iniciada`,
`[rlsCanonical] cobertura de RLS verificada`, `redis: connected`) →
crash en migrate.

### 2. Conectarse a la DB de prod y reproducir el error

Los logs de Railway NO capturan el error real de Postgres (el container
muere antes que el stderr llegue al log store). El error se reproduce
directo contra la DB:

```bash
# Traer credentials (Postgres service tiene la public URL)
railway variables --project 3f2cc8c1-bed4-43d0-ba71-742c761606ef \
  --environment 2cf06d79-51f6-41a9-b9d8-dbe9366832d7 \
  --service Postgres-AueP --kv | grep DATABASE_PUBLIC_URL

# Credenciales del app pool (ipro_app NOSUPERUSER — replica el escenario del deploy)
railway variables --project 3f2cc8c1-bed4-43d0-ba71-742c761606ef \
  --environment 2cf06d79-51f6-41a9-b9d8-dbe9366832d7 \
  --service tecny-backend --kv | grep DATABASE_URL=

# Con la connection string de ipro_app + host público (zephyr.proxy.rlwy.net),
# reproducir la operación de la migration en BEGIN + ROLLBACK:
psql "postgresql://ipro_app:PASSWORD@zephyr.proxy.rlwy.net:PORT/railway" <<SQL
BEGIN;
-- Copiar aquí el SQL exacto de la migration fallada
SET LOCAL row_security = off;
UPDATE ventas SET id = id WHERE id = (SELECT id FROM ventas LIMIT 1);
ROLLBACK;
SQL
```

El error real de Postgres aparece en el output — con el hint específico
para arreglarlo.

### 3. Verificar el estado de la migration en pgmigrations

```sql
SELECT name FROM pgmigrations WHERE name LIKE 'YYYYMMDD%' ORDER BY name;
```

Si la migration NO está listada → el ROLLBACK fue completo, la DB está
en el estado pre-migration. Podés arreglar la migration y re-deployar
sin cleanup manual.

Si la migration SÍ está listada pero deploys siguen fallando → alguna
otra parte del startup se rompió (menos común).

### 4. Verificar ownership + FORCE RLS state

```sql
-- ¿ipro_app es owner?
SELECT schemaname, tablename, tableowner
  FROM pg_tables
 WHERE tablename IN ('ventas', 'productos', 'CUALQUIER_OTRA_AFECTADA')
   AND schemaname = 'public';

-- ¿FORCE RLS activo?
SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force
  FROM pg_class
 WHERE relname IN ('ventas','productos','...') AND relkind = 'r';

-- ¿ipro_app tiene BYPASSRLS?
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'ipro_app';
-- Esperado: ipro_app | f | f
```

Si `rls=t` + `force=t` + `bypassrls=f` → estás en el escenario de este
runbook. Solución: patrón `ALTER TABLE NO FORCE + UPDATE + FORCE`.

## Fix pattern canónico

**NO uses**:
```sql
SET LOCAL row_security = off;
UPDATE <tabla_con_force_rls> SET ...;
```

**SÍ usá** (dentro de la transacción implícita de la migration):
```sql
ALTER TABLE <tabla> NO FORCE ROW LEVEL SECURITY;
UPDATE <tabla> SET ...;
ALTER TABLE <tabla> FORCE ROW LEVEL SECURITY;
```

Justificación:
- `node-pg-migrate` envuelve `up()` en una tx por default.
- Si el UPDATE falla, ROLLBACK deja la tabla con `FORCE RLS` de vuelta.
- El invariante "todas las tablas RLS tienen FORCE" queda preservado.
- El owner (`ipro_app`) SÍ puede ejecutar ambos ALTER (verificado
  empíricamente contra prod DB).

Alternativas evaluadas y rechazadas:
- **Loop por tenant con `SET LOCAL app.current_tenant`**: correcto
  semánticamente pero MUY lento (miles de tenants).
- **Grantear `BYPASSRLS` a `ipro_app`**: rompe el invariante de seguridad
  multi-tenant a nivel role. Innecesario si el patrón anterior alcanza.
- **Migration manual via `postgres` superuser**: viable pero requiere
  intervención humana en cada deploy con backfill. No escala.

## Rollback / undo si la migration ya se aplicó parcial

Si por alguna razón la migration se aplicó parcial (columna marker
creada pero UPDATE incompleto), el `down()` la limpia:

```bash
npm run migrate down
```

Esto restaura el estado pre-migration.

## Referencias

- Doc parent (multi-env drift): [`MULTI_ENV_DRIFT.md`](MULTI_ENV_DRIFT.md) —
  categoría "Schema / permisos DB (RLS)" + toxic assumptions #3 y #5.
- Runbook complementario: [`RUNBOOK_RLS_OWNER_FIX.md`](RUNBOOK_RLS_OWNER_FIX.md)
  (7 tablas con owner mismatch — problema distinto pero mismo dominio).
- Runbook preventivo: [`runbooks/rls-bulk-migration.md`](runbooks/rls-bulk-migration.md)
  (guía para escribir migrations con bulk UPDATE sobre tablas FORCE RLS).
- Sentry issue relacionado: (ninguno — el error muere en el buffer del
  container antes de que Sentry lo capture).
- Post-mortem: task #274 (P0 completado 2026-08-01), task #275 (re-merge
  con fix).
- Fix del CI: nuevo step "Migrations from-scratch as ipro_app NOSUPERUSER
  (owner-of-schema)" en `.github/workflows/ci.yml` (job `nosuperuser-rls`).
