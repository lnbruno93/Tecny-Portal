# Archivos (comprobantes y fotos) — estado actual y camino a storage externo

> **Actualización 2026-06-13** — P-03 implementado. Las 3 entities pueden
> migrarse a Cloudflare R2 vía feature flags. Ver `docs/design/p03-r2-storage.md`
> y `docs/OPERATIONS.md` §7 (RUNBOOK) para el detalle operacional. Este
> archivo se mantiene como referencia histórica + descripción del estado
> "default OFF" (donde las flags siguen apagadas).

## Hoy (con flag OFF): base64 en PostgreSQL

Los archivos se guardan como base64 en columnas `TEXT`:
- `comprobantes.archivo_data` (Financiera)
- `venta_comprobantes.archivo_data` (Ventas)
- `productos.foto_data` (Inventario)

**Optimizaciones ya aplicadas** para que esto escale razonablemente:
- Los blobs viven en **tablas/columnas que NO se traen en los listados**:
  - Comprobantes de venta: tabla aparte; el listado solo devuelve `comprobantes_count`; el archivo se baja on-demand (`GET /api/ventas/comprobantes/:id`).
  - Foto de producto: el listado devuelve `tiene_foto` (boolean), NO el `foto_data`; la foto se baja on-demand (`GET /api/inventario/productos/:id/foto`).
- PostgreSQL TOAST guarda los valores grandes fuera de la fila automáticamente.

Esto es suficiente para miles de registros sin degradar las listas.

## Hoy (con flag ON): Cloudflare R2

Implementado en 2026-06-13 (P-03). Cuando el feature flag de la entity está ON
**Y** `STORAGE_DRIVER=r2`, los uploads van a Cloudflare R2 — guardan `*_key`
en la columna y `*_data` queda NULL. Reads tienen fallback automático: si la
fila tiene `*_key` → R2, sino → `*_data` legacy.

Para detalle operacional ver:
- `docs/design/p03-r2-storage.md` — diseño completo (motivación, arquitectura, fases).
- `docs/OPERATIONS.md` §7 — RUNBOOK (activación, failover, backfill, rotación de credenciales).
- `backend/src/lib/fileStore.js` — abstracción de drivers.
- `backend/scripts/r2-backfill.js` — script para mover blobs legacy a R2.
- `backend/scripts/r2-smoke.js` — smoke test de conectividad.

Drivers disponibles (env var `STORAGE_DRIVER`):
- `db` (default): guarda/lee base64 en columna TEXT — estado pre-P-03.
- `r2`: sube/baja a Cloudflare R2 con S3-compatible API.

Out of scope (TANDA futura):
- Signed URLs para que el cliente baje directo de R2 (hoy proxy mode).
- Image resizing automático (thumbnails).
- Lifecycle rules de R2 (auto-delete archivos viejos).
