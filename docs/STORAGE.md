# Archivos (comprobantes y fotos) — estado actual y camino a storage externo

## Hoy: base64 en PostgreSQL

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

## Mañana: storage externo (S3 / Cloudflare R2)

A gran escala (decenas de miles de archivos, o archivos grandes), conviene mover los blobs a object storage. **Requiere infraestructura tuya** (bucket + credenciales) y es un cambio que también toca Financiera.

Plan sugerido (sin reescribir los call sites):
1. Crear bucket (S3 o R2) y credenciales; agregar env vars (`STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_KEY`, `S3_SECRET`, `S3_ENDPOINT` para R2).
2. Crear `backend/src/lib/fileStore.js` con dos drivers:
   - `db` (actual): guarda/lee base64 en la columna.
   - `s3`: sube el archivo y guarda solo la **key/URL** en la columna (`archivo_data` pasa a guardar la key, o se agrega `archivo_url`).
   - El driver se elige por `STORAGE_DRIVER`.
3. Endpoints de subida/lectura usan `fileStore.put()/get()` en vez de tocar la columna directo.
4. Migración opcional para mover los blobs existentes al bucket (script de backfill).
5. Servir los archivos vía URL firmada (no proxyear el binario por el backend).

Mientras `STORAGE_DRIVER` no esté seteado, todo sigue funcionando con el driver `db` actual — el cambio es transparente y reversible.
