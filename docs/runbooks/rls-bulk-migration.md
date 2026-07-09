# Runbook — Migraciones con bulk UPDATE sobre tablas con FORCE RLS

**Fecha:** 2026-07-09 (postmortem del incidente de deploys de la serie F3).
**Aplica a:** cualquier migration futura que haga `UPDATE` masivo sobre `productos`, `ventas`, `movimientos_cc`, u otras tablas multi-tenant con `FORCE ROW LEVEL SECURITY`.

## Contexto del incidente

Migration `20260708000001_productos_clase_categorias_reales.js` (F1 de la serie F3) hace 3 `UPDATE productos SET clase = ...` para migrar los slugs viejos (`celular`, `accesorio`) a los 9 nuevos, más un `ADD CONSTRAINT CHECK` final restringido.

**Fallaron 10 auto-deploys en producción + 1 intento manual en staging.** Cada uno reintentaba el mismo error.

### Root cause

`productos` tiene `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` desde la migration 20260615000001 (multi-tenant PR 5). `FORCE` significa que **incluso el owner de la tabla** (rol `ipro_app`) es afectado por las policies. La policy `tenant_isolation ON productos USING (tenant_id = current_setting('app.current_tenant')::int)` filtra por tenant activo.

Cuando el backend Node corre `npm run migrate` en Railway, se conecta como `ipro_app` **sin haber seteado `app.current_tenant`** (no hay tenant activo — es un job de startup). Bajo RLS con la policy anterior:
- Los `UPDATE productos SET clase = ...` afectan **0 filas** (todas filtradas)
- El `ADD CONSTRAINT CHECK (clase IN (nuevas_9_slugs))` valida contra **todas las filas físicas** (constraints ignoran RLS), encuentra las filas legacy sin migrar → error `check constraint violated by some row`

El error real quedaba oculto en Railway porque los logs se cortaban por rate limit justo en el bloque del error.

### Cómo lo resolvimos hoy

1. **Diagnóstico** — desde la máquina de Lucas con `railway variables --json` sacamos `DATABASE_URL`. Como el rol `ipro_app` tampoco tenía visibilidad, usamos el rol superuser `postgres` (variable `POSTGRES_PASSWORD` del servicio Postgres) con el TCP proxy externo (`DOMAIN` + `RAILWAY_TCP_PROXY_PORT`).
2. **Aplicación de migraciones manual** — corrimos `DATABASE_URL=<admin_url> npx node-pg-migrate up` como user `postgres` (superuser bypassea RLS por default). Aplicó las 3 migraciones (F1 + F3.a + F3.d-3) contra ambas bases.
3. **Redeploy** — `railway deployment redeploy --from-source --yes` en ambos entornos. El backend Node arrancó en <35s porque `npm run migrate` vio la tabla `pgmigrations` ya al día y no hizo nada.

Prod nunca tuvo downtime — siguió sirviendo el commit anterior (`ef8b87a`, PR #522) durante todo el incidente.

## Fix estructural (2026-07-09 este PR)

Se agregó al inicio y final de la migration F1:

```sql
-- Al inicio:
ALTER TABLE productos NO FORCE ROW LEVEL SECURITY;

-- ... bulk UPDATE queries ...

-- Al final:
ALTER TABLE productos FORCE ROW LEVEL SECURITY;
```

**Por qué esto funciona:**
- `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` puede ser ejecutado por el **owner** de la tabla (no requiere superuser). El rol `ipro_app` es owner.
- Post-`NO FORCE`, las policies siguen `ENABLED` pero solo aplican a **non-owner** users. Como `ipro_app` es owner, los `UPDATE` bulk ven todas las filas.
- Al final restauramos `FORCE`, y el estado post-migration es idéntico al pre-migration para runtime — solo el bloque de migration se ejecuta con bypass.

## Guideline para futuras migraciones

**Regla:** si una migration hace `UPDATE` masivo (o `DELETE` masivo, o `INSERT ... SELECT` masivo, o `ADD CONSTRAINT` que valida data) sobre una tabla con `FORCE ROW LEVEL SECURITY`, envolver el bulk con:

```sql
ALTER TABLE <tabla> NO FORCE ROW LEVEL SECURITY;
-- bulk data operations
ALTER TABLE <tabla> FORCE ROW LEVEL SECURITY;
```

**Tablas afectadas al 2026-07-09** (correr en local: `SELECT relname FROM pg_class WHERE relforcerowsecurity = true`):

- `productos`
- `ventas`, `venta_items`, `venta_pagos`, `canjes`
- `movimientos_cc`, `items_movimiento_cc`, `clientes_cc`
- `proveedores`, `proveedor_movimientos`, `proveedor_movimiento_items`
- `caja_movimientos`
- `tarjeta_movimientos`
- `cambio_entidades`, `cambio_movimientos`
- `categorias`, `depositos`, `metodos_pago`
- `clases_producto` (F3.a)
- (varias más — la lista está en las migrations que hacen `FORCE ROW LEVEL SECURITY`)

## Cuando aparezca el mismo síntoma (recovery playbook)

**Síntoma:**
- Deploys de Railway en rojo, todos con el mismo error
- Health check timeout de 60s
- Logs cortados por rate limit
- Prod sigue sirviendo la versión vieja (o servicio caído si el rolling deploy alcanzó a matar réplicas)

**Recovery paso a paso:**

1. **Verificar hipótesis con `railway deployment list`:**
   ```bash
   railway deployment list --service tecny-backend --environment production --limit 5
   ```
   Si ves ≥3 FAILED consecutivos, casi seguro es este bug (o similar).

2. **Confirmar en logs del deploy fallido:**
   ```bash
   railway logs --service tecny-backend --environment production --lines 800 <DEPLOY_ID> | tail -50
   ```
   Buscá `check constraint`, `violated by some row`, o `Rolling back attempted migration`.

3. **Aplicar migraciones manualmente como superuser:**
   ```bash
   # 1) Sacar las credenciales del proyecto
   POSTGRES_PASSWORD=$(railway variables --service Postgres-AueP --environment production --json | jq -r '.POSTGRES_PASSWORD')
   PORT=$(railway variables --service Postgres-AueP --environment production --json | jq -r '.RAILWAY_TCP_PROXY_PORT')
   DOMAIN=$(railway variables --service Postgres-AueP --environment production --json | jq -r '.RAILWAY_TCP_PROXY_DOMAIN')
   ADMIN_URL="postgresql://postgres:${POSTGRES_PASSWORD}@${DOMAIN}:${PORT}/railway"

   # 2) Verificar estado actual antes de tocar nada
   psql "$ADMIN_URL" -c "SELECT MAX(id), MAX(run_on) FROM pgmigrations;"
   psql "$ADMIN_URL" -c "SELECT COUNT(*) FROM productos;"

   # 3) Correr las migraciones desde el checkout local de main
   cd backend/
   DATABASE_URL="$ADMIN_URL" npx node-pg-migrate -m migrations up

   # 4) Verificar que aplicaron todas
   psql "$ADMIN_URL" -c "SELECT MAX(id), MAX(run_on) FROM pgmigrations;"
   ```

4. **Redeploy con la última versión del source:**
   ```bash
   railway deployment redeploy --service tecny-backend --environment production --from-source --yes
   ```
   Esperá 30-60s. El deploy debería pasar SUCCESS porque `npm run migrate` verá pgmigrations al día y no hará nada — el server arranca en <10s.

5. **Verificar salud:**
   ```bash
   curl -s https://tecny-backend-production.up.railway.app/health | jq '{commit, migrations, uptime, db_status: .db.status}'
   ```
   `commit` debe matchear el HEAD de main. `migrations` debe ser el count actual.

## Prevención — mejoras del pipeline

Para reducir la superficie de este tipo de incidente:

1. **Este PR:** fix de la migration F1 con el `NO FORCE / FORCE` wrap. Cualquier fresh setup ya no requiere intervención manual.
2. **CI test de migraciones contra DB limpia** — asegurar que las migraciones aplican contra un Postgres con `FORCE RLS` en las tablas afectadas. El CI de tests ya hace `pool` con un role NOSUPERUSER, pero no valida el escenario `FORCE + owner` específicamente. Task follow-up: agregar test en `backend/tests/migrations-rls-nosuperuser.test.js`.
3. **healthcheckTimeout más alto para deploys con migrations grandes** — considerar subir a 300s en `backend/railway.json` cuando anticipamos que una migration puede tardar >60s (backfill de 2500+ filas + índices + rewrite). Task follow-up.
4. **Logs de migration a stderr y no stdout** — node-pg-migrate loguea a stdout. Railway rate-limita stdout a 500 logs/sec. Si el server logueara migraciones a stderr, seríamos menos vulnerables al rate limit exacto en el bloque de error.

## Referencias

- Migration F1 fixeada: `backend/migrations/20260708000001_productos_clase_categorias_reales.js`
- Release notes de la serie F3: `docs/design/categorias-kpis-release-notes-2026-07-09.md`
- Runbook staging general: `docs/STAGING.md`
- Postgres docs sobre FORCE RLS: https://www.postgresql.org/docs/current/sql-altertable.html#SQL-ALTERTABLE-DESC-FORCE-ROW-SECURITY
