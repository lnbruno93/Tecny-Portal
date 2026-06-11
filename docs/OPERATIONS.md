# Operaciones — iPro Portal

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

1. **Rollback instantáneo (sin tocar código):** Railway → servicio `ipro-backend` → **Deployments** → en un deploy verde anterior, menú ⋮ → **Redeploy**. Vuelve a esa versión en minutos.
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
