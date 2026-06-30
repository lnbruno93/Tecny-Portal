<!-- Auditoría 2026-06-30 Q-04: rebrand iPro Tech/Celnyx/iPro Portal → Tecny -->
# Operaciones — Tecny Portal

Runbook operativo: backups, rollback y decisiones de escala. Producción es Railway (backend + Postgres) + Netlify (frontend).

---

## 1. Backups de la base de datos

**Producción:** servicio `Postgres-AueP` en Railway (NO el `Postgres` vacío).

- Activar backups automáticos: Railway → `Postgres-AueP` → pestaña **Backups** → habilitar snapshots programados.
- Backup manual antes de cualquier migración destructiva (DROP/ALTER que borre datos):
  ```bash
  pg_dump "$DATABASE_PUBLIC_URL" -Fc -f ipro_$(date +%Y%m%d_%H%M).dump
  ```
- Restore (a una base nueva, NUNCA pisar prod sin verificar):
  ```bash
  pg_restore --no-owner -d "$TARGET_DATABASE_URL" ipro_YYYYMMDD_HHMM.dump
  ```

> Regla: **antes de una migración que borre o transforme datos, sacar un backup manual** y verificar que el archivo se generó.

---

## 2. Rollback de un deploy

Railway auto-deploya en cada push a `main`. Si un deploy queda mal:

1. **Rollback instantáneo (sin tocar código):** Railway → servicio `tecny-backend` → **Deployments** → en un deploy verde anterior, menú ⋮ → **Redeploy**. Vuelve a esa versión en minutos.
2. **Rollback por código (preferido si el problema es el código):**
   ```bash
   git revert <sha-del-merge> -m 1   # revierte el merge problemático
   git push origin main              # dispara un deploy limpio
   ```
3. El frontend (Netlify) se revierte igual: Deploys → un deploy anterior → **Publish deploy**.

---

## 3. Rollback de una migración

Las migraciones corren al arrancar el contenedor (`npm run migrate` en el startCommand).

- **Revertir la última migración:**
  ```bash
  DATABASE_URL="<public-url>" npm run migrate:down   # ejecuta el exports.down de la última
  ```
- **Criterio:** solo revertir si la migración es problemática Y su `down` es seguro. Para migraciones aditivas (índices, columnas nullable) el `down` es seguro. Para migraciones que borran datos, **restaurar desde backup** en vez de confiar en `down`.
- Tras revertir, hacer rollback del código que dependía de esa migración (sección 2) para que no vuelva a aplicarse en el próximo deploy.

> ⚠️ El `down` NO recupera datos borrados por el `up`. Para eso está el backup (sección 1).

---

## 4. Escala — multi-réplica activa (revisado 2026-06-10)

**iPro está preparado para multi-réplica** y el código asume ese caso:
- **Rate-limiter compartido**: usa `PostgresRateLimitStore` (`src/lib/postgresRateLimitStore.js`) → cualquier cantidad de réplicas comparten el mismo límite vía PG.
- **Advisory locks** (`src/lib/withAdvisoryLock.js`): los crons nocturnos (purga audit, invariantes, rate-limit cleanup) toman lock para no duplicarse cross-réplica.
- **Migraciones**: corren al arranque con advisory lock de `node-pg-migrate`. Las réplicas que no obtienen el lock saltean migrate y arrancan normalmente (no flapping).
- **Caches in-memory** (`cajasCache.js`, `inventarioCache.js`, `cacheTtl.js`): TTLs cortos (15-60s); cada réplica mantiene su copia local — máximo de stale window = TTL. **Pendiente migrar a Redis** cuando se requiera consistencia sub-TTL (ver `docs/audit/2026-06-10-gran-auditoria.md` P-04).

**Caveat conocido**: con multi-réplica, dos usuarios en réplicas distintas pueden ver datos cacheados con un delay máximo del TTL. Aceptable para el tráfico actual; revisar antes de escalar a 10+ réplicas o multi-tenant.

---

## 5. Compactación de soft-deletes

Las tablas con `deleted_at` no se purgan automáticamente — los borrados quedan como "fantasmas" para preservar auditoría e historial. Con el tiempo esto pesa en índices, backups y consultas con `WHERE deleted_at IS NULL`.

**Script:** `backend/scripts/compactar-soft-deletes.js`

```bash
# Reporte (no destructivo): cuántas filas se podrían compactar.
DATABASE_URL="<production-url>" node backend/scripts/compactar-soft-deletes.js

# Ejecutar con confirmación interactiva ("BORRAR" para proceder):
DATABASE_URL="<production-url>" node backend/scripts/compactar-soft-deletes.js --execute

# Cambiar ventana de retención (default 12 meses):
DATABASE_URL="<production-url>" node backend/scripts/compactar-soft-deletes.js --months=24

# Una sola tabla:
DATABASE_URL="<production-url>" node backend/scripts/compactar-soft-deletes.js --table=caja_movimientos
```

**Whitelist (tablas que compacta):** `caja_movimientos`, `movimientos_deudas`, `movimientos_inversiones`. Otras tablas hijo (items_movimiento_cc, envio_items, canjes, proveedor_movimiento_items) usan CASCADE en lugar de soft-delete y por lo tanto no acumulan fantasmas — el script las skipea automáticamente si las encuentra en la whitelist sin la columna. Para agregar tablas, editar el script deliberadamente.

**Tablas excluidas a propósito:** `productos`, `ventas`, `movimientos_cc`, `envios`, `proveedor_movimientos`, `tarjeta_movimientos`, `cambio_movimientos`, `audit_logs`, `historial`, `comprobantes`, `pagos`. Razón: trazabilidad regulatoria, saldos históricos, o auditoría.

**Cadencia sugerida:** correr el reporte (sin `--execute`) trimestralmente. Compactar solo si los conteos justifican la operación (>10k filas en alguna tabla). Hacer **backup completo antes** de ejecutar.

**Después del DELETE:** considerar `VACUUM ANALYZE <tabla>;` en psql para recuperar espacio físico y refrescar estadísticas.


## 6. Redis (cache cross-instance) — agregado 2026-06-12 P-04

Backend usa Redis para cachear queries caras de lectura compartidas entre las
2 réplicas Railway. Doc de diseño: [docs/design/p04-redis-caching.md].

### Inventario de keys

Convención: prefijo `cache:` + scope. Todas las keys tienen TTL explícito.

| Key Redis | TTL | Origen | Invalidación cross-instance |
|---|---|---|---|
| `cache:flag:audit_async_enabled` | 60s | `lib/audit.js` | PATCH `/api/feature-flags/audit_async_enabled` |
| `cache:cajas:list` | 15s | `lib/cajasCache.js` | 5 callsites en `routes/cajas.js` (POST/PATCH/DELETE caja + movimiento) |
| `cache:inv:metricas` | 20s | `lib/inventarioCache.js` | 9 callsites en `routes/ventas.js` + `routes/cuentas.js` (cambios de stock) |
| `cache:dashboard:resumen:{actual}|{comparado}` | 60s | `routes/dashboard.js` | Sin invalidación (TTL natural; datos mensuales raramente cambian) |
| `cache:ventas:dashboard:{desde}|{hasta}` | 30s | `routes/ventas.js` | Sin invalidación (TTL natural; dashboard de reporting) |

### Verificar que Redis está sano

```bash
# Endpoint público — sin auth:
curl https://tecny-backend-production.up.railway.app/health | jq .redis
# Esperado: { "status": "ok", "latency_ms": <N> }
```

Posibles `status`:
- `ok` — todo bien.
- `disabled` — `REDIS_URL` no configurada en el environment. El backend funciona sin Redis (fallback a fetch directo en cada request), pero pierde cross-instance caching.
- `unreachable` — `REDIS_URL` configurada pero el ping falla (Redis caído, red rota, password inválido). Mismo fallback. Sentry recibe alerta cada 60s.
- `error` — algo más raro (URL malformada, etc.). Mensaje detallado en `redis.error` cuando `NODE_ENV !== 'production'`.

### Inspeccionar cache desde redis-cli

Railway: el servicio Redis tiene un botón "Data" que abre una consola web (`redis-cli` over WebSocket). Alternativamente, conectarse desde local:

```bash
# 1) Obtener REDIS_URL desde Railway (servicio Redis → tab Variables).
# 2) NUNCA pegues REDIS_URL en chat, screenshot, ni shell history.
redis-cli -u "$REDIS_URL" PING
# → PONG

# Listar todas las keys (en prod usa SCAN, no KEYS — KEYS bloquea Redis):
redis-cli -u "$REDIS_URL" --scan --pattern "cache:*"

# Ver el valor cacheado:
redis-cli -u "$REDIS_URL" GET cache:cajas:list

# Ver TTL restante en segundos (-1 = sin TTL, -2 = key no existe):
redis-cli -u "$REDIS_URL" TTL cache:cajas:list
```

### Forzar invalidación de un cache puntual

```bash
# Borrar una key específica → próxima lectura va a Postgres:
redis-cli -u "$REDIS_URL" DEL cache:cajas:list

# Borrar TODOS los caches del prefijo (peligroso — afecta todos los endpoints):
redis-cli -u "$REDIS_URL" --scan --pattern "cache:*" | xargs redis-cli -u "$REDIS_URL" DEL
```

### Procedimiento de failover si Redis cae

**Síntoma**: `/health` muestra `redis.status: "unreachable"` o `"error"`. Sentry recibe alertas. Performance baja levemente (cada request hace queries Postgres directo).

**Acción inmediata**: ninguna. El backend tiene fallback automático — sigue funcionando, solo pierde cache. NO requiere intervención.

**Acción de recuperación**:
1. Verificar el servicio Redis en Railway (puede haber crasheado por OOM, restart, etc.).
2. Si está down: Railway tiene auto-restart configurado, esperar 1-2 min.
3. Si sigue down después de 5 min: restart manual desde Railway dashboard del servicio Redis.
4. Confirmar que vuelve con `curl /health | jq .redis`.
5. El cache se va re-poblando solo a medida que los endpoints reciban requests (TTL natural — no requiere "warm up").

**Rollback de emergencia**: si Redis genera un problema mayor (corrupción, costo, etc.), eliminar `REDIS_URL` del environment del backend en Railway → `/health.redis.status: "disabled"` → todo sigue funcionando in-memory por réplica (mismo comportamiento que pre-P-04). NO requiere code change.

### Rotación de credenciales Redis

Si se sospecha que la `REDIS_URL` quedó expuesta (screenshot, log filtrado, etc.):

1. En Railway, servicio Redis → tab Variables → `REDIS_PASSWORD` → menú `⋯` → **Regenerate** (o borrar/recrear el servicio si no aparece la opción).
2. Railway actualiza automáticamente `REDIS_URL` en todos los servicios linkeados.
3. El backend redeployea con la nueva URL — durante el redeploy (~1-2 min) el cache queda `unreachable`, recordando que el fallback graceful sigue sirviendo requests sin downtime.
4. Después del redeploy: `curl /health | jq .redis` debería decir `ok` de nuevo.

### Alerting recomendado

Hoy (junio 2026):
- Sentry recibe alerta vía rate-limit (1 por minuto máximo) si Redis tira errores.
- UptimeRobot puede pegar a `/health` cada 5 min; el endpoint devuelve 200 incluso con Redis caído (solo se degrada el status interno).

Futuro:
- Si hit ratio cae <50% durante 5+ min → posible cache thrashing o key TTLs mal configurados. Agregar métrica en `/health/cache-stats` (no existe hoy).
- Si latency p99 de operaciones Redis sube >100ms → red lenta o Redis sobrecargado. Hoy no hay tracking — agregar cuando dolor justifique.

---

## 7. Cloudflare R2 (object storage) — agregado 2026-06-13 P-03

### Por qué R2

A partir de junio 2026 los blobs subidos por usuarios (comprobantes Financiera, fotos de productos, comprobantes de venta B2B) se migran de columnas `*_data` (base64 en PostgreSQL TOAST) a Cloudflare R2.

Razones: backups más rápidos, CPU PostgreSQL menor, egress por CDN en lugar de Railway, base más limpia para la migración tenant_id futura. Ver `docs/design/p03-r2-storage.md` para el contexto completo.

### Inventario de uploads

| Endpoint | Tabla | Columnas legacy | Columnas R2 | Feature flag |
|---|---|---|---|---|
| `POST /api/comprobantes` | `comprobantes` | `archivo_data, archivo_nombre, archivo_tipo` | `archivo_key, archivo_size` | `storage_r2_comprobantes` |
| `POST /api/inventario/productos` | `productos` | `foto_data, foto_nombre, foto_tipo` | `foto_key, foto_size` | `storage_r2_productos` |
| `POST /api/ventas/:id/comprobantes` | `venta_comprobantes` | `archivo_data, archivo_nombre, archivo_tipo` | `archivo_key, archivo_size` | `storage_r2_ventas_comprobantes` |

Cuando el flag está ON **Y** `STORAGE_DRIVER=r2`, los uploads nuevos van a R2 (columna `*_key` se llena, `*_data` queda NULL). Cuando está OFF o el driver es `db`, los uploads siguen yendo a la columna `*_data` legacy. Reads tienen fallback automático: si `*_key` existe → R2, sino → `*_data` legacy.

### Buckets y credenciales

- `ipro-staging` (env Railway staging)
- `ipro-prod` (env Railway prod)
- Endpoint: `https://<accountid>.r2.cloudflarestorage.com`
- API Token Cloudflare con scope **sólo a esos 2 buckets** (Object Read & Write).

Layout de keys: `ipro/<env>/<entity>/<subpath o YYYY/MM/DD>/<uuid>.<ext>`. Ejemplo:
```
ipro/prod/comprobantes/2026/06/13/abc-uuid-1234.pdf
ipro/prod/productos/producto-42/foto-uuid-5678.jpg
ipro/prod/venta-comprobantes/venta-100/uuid-9abc.png
```

### Comandos R2 con AWS CLI (S3-compatible)

```bash
# Configurar perfil AWS para R2 (una sola vez)
aws configure --profile ipro-r2
# AWS Access Key ID: <R2_ACCESS_KEY_ID>
# AWS Secret Access Key: <R2_SECRET_ACCESS_KEY>
# Default region: auto
# Default output: json

# Listar primeros objetos de un bucket
aws s3 ls s3://ipro-prod/ \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com \
  --profile ipro-r2

# Descargar un objeto
aws s3 cp s3://ipro-prod/ipro/prod/comprobantes/2026/06/12/<uuid>.pdf ./local.pdf \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com \
  --profile ipro-r2

# Subir un objeto (debug manual)
aws s3 cp ./local.pdf s3://ipro-prod/test/manual.pdf \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com \
  --profile ipro-r2

# Borrar un objeto (CUIDADO)
aws s3 rm s3://ipro-prod/test/manual.pdf \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com \
  --profile ipro-r2

# Tamaño total del bucket
aws s3 ls s3://ipro-prod/ --recursive --human-readable --summarize \
  --endpoint-url https://<accountid>.r2.cloudflarestorage.com \
  --profile ipro-r2
```

### Activación gradual de R2 por entity

Default: las 3 flags están en `enabled=false`. Para activar una entity:

```bash
# 1. Setear STORAGE_DRIVER=r2 en Railway (si todavía no está)
# 2. PATCH al flag de la entity correspondiente (rol admin requerido)
curl -X PATCH https://<env-url>/api/feature-flags/storage_r2_comprobantes \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
# Repetir para storage_r2_productos y storage_r2_ventas_comprobantes
# DESPUÉS de validar cada una individualmente con uploads reales.
```

Orden recomendado: una entity → smoke test (subir + descargar archivo desde el portal) → 24h observación Sentry → siguiente entity.

### Backfill histórico (mover blobs legacy a R2)

El script `backend/scripts/r2-backfill.js` migra las filas que existían **antes** de prender el flag. Idempotente, batch processing, dry-run.

```bash
cd backend

# 1. Ver cuántas filas hay pendientes (no toca nada)
node scripts/r2-backfill.js --table comprobantes --dry-run
node scripts/r2-backfill.js --table productos --dry-run
node scripts/r2-backfill.js --table venta_comprobantes --dry-run

# 2. Migrar en chunks de 50 (default). Re-correrlo es seguro — filas ya
#    migradas (con *_key seteada) se excluyen del WHERE.
node scripts/r2-backfill.js --table comprobantes --batch 50

# 3. Validar integridad post-backfill — reporta pending / r2_only / both
#    (`both` = fila tiene tanto base64 legacy como key R2)
node scripts/r2-backfill.js --validate

# 4. Después de 1 semana de observación sin issues, liberar el espacio TOAST
#    (DESTRUCTIVO — sólo después de validar que R2 funciona end-to-end).
node scripts/r2-backfill.js --table comprobantes --cleanup-legacy
```

El script no toca filas con `deleted_at IS NOT NULL` (soft-deleted) — esas se barren con el cron de purga futura.

### Failover (R2 caído)

**Uploads**:
- Driver R2 + flag ON + R2 caído → el POST falla con 500. No se hace fallback automático para no enmascarar el problema.
- **Mitigación rápida**: PATCH flag a `enabled=false` → uploads nuevos vuelven al path legacy (archivo_data en PostgreSQL). Esto es <100ms (cache invalidation cross-instance vía Redis).
- **Mitigación nuclear**: setear `STORAGE_DRIVER=db` en Railway → driver R2 se desactiva entero, todos los uploads vuelven a path legacy. Requiere redeploy (~30s).

**Reads**:
- Filas legacy (con `*_data`) siguen funcionando — no consultan R2.
- Filas migradas (con `*_key`) que pidan GET cuando R2 está caído → response 503.

**Rollback nuclear total**: borrar `STORAGE_DRIVER` de Railway (vuelve al default `db`) + flag OFF en las 3 entities. Pierde acceso a filas migradas en R2 hasta que R2 vuelva.

### Rotación de credenciales R2

Lección de TANDA 6 P-04 (Redis password leak). Para rotar:

1. Cloudflare dashboard → **R2 Object Storage** → **Manage R2 API Tokens** → **Roll** el token actual (genera credenciales nuevas, marca las viejas para expirar en 24h).
2. Copiar las nuevas credentials inmediatamente (Cloudflare las muestra una sola vez).
3. Railway → Variables (staging y prod) → actualizar `R2_ACCESS_KEY_ID` y `R2_SECRET_ACCESS_KEY`.
4. Railway redeploy automático al guardar variables. App levanta con credenciales nuevas.
5. Smoke test: `node backend/scripts/r2-smoke.js` con las nuevas vars exportadas.
6. Después de las 24h de grace, las credentials viejas se revocan automáticamente.

### Monitoreo de costos

- Free tier R2: 10 GB storage + 1M Class A ops/mes + 10M Class B ops/mes. Egress siempre $0.
- Más allá: $0.015/GB/mes storage, $4.50 por millón Class A, $0.36 por millón Class B.
- Cloudflare dashboard → R2 → Overview → métricas de uso por bucket.

### Alerting recomendado

Hoy (junio 2026):
- Sentry captura errores de R2 (mismo mecanismo que Redis — rate-limited 1/min).
- Cloudflare dashboard tiene alertas por usage > N (configurar manualmente cuando ya tengamos baseline de uso).

Futuro:
- Si error rate de uploads sube >1% durante 5 min → posible R2 outage. Investigar y considerar PATCH flag OFF como mitigación rápida.
- Si tamaño de bucket crece >10%/semana → revisar si hay upload abuse o leak (testing en prod, etc).

