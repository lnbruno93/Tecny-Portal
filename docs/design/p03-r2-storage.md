# P-03 — Storage externo (Cloudflare R2)

**Estado**: 📝 PROPUESTA (esperando respuesta a preguntas abiertas)
**Auditoría origen**: 2026-06-10, finding P-03 (BLOCKER de performance/escalabilidad)
**Effort estimado**: 16-24h, partido en 6 fases
**Fecha**: 2026-06-12

---

## 1. Contexto

### 1.1 Estado actual del storage

Los archivos subidos por usuarios viven como **base64 en columnas TEXT** de PostgreSQL,
no en filesystem. PostgreSQL TOAST guarda los blobs fuera de la fila automáticamente.

| Tabla | Columna blob | Columna nombre | Columna mime | Endpoints upload | Endpoint download |
|---|---|---|---|---|---|
| `comprobantes` | `archivo_data` | `archivo_nombre` | `archivo_tipo` | `POST /api/comprobantes`, `POST /api/comprobantes/manuales` | `GET /api/comprobantes/:id/archivo`, `GET /api/comprobantes/export-zip` |
| `productos` | `foto_data` | `foto_nombre` | `foto_tipo` | `POST /api/inventario/productos`, `PUT /api/inventario/productos/:id` | `GET /api/inventario/productos/:id/foto` |
| `venta_comprobantes` | `archivo_data` | `archivo_nombre` | `archivo_tipo` | `POST /api/ventas/:id/comprobantes` | `GET /api/ventas/comprobantes/:cid` |

**Optimizaciones ya aplicadas** (no se rompen con la migración):
- Los listados NO devuelven el blob (solo `tiene_foto` boolean / `comprobantes_count` int).
- Los blobs se bajan on-demand por endpoint dedicado.
- Cap de 1000 comprobantes en el export-zip (defensa anti-OOM).
- Body limit global `express.json({ limit: '10mb' })`.

### 1.2 Por qué migrar

**Mi premisa original era falsa**: no hay bug latente de "filesystem local en multi-replica".
PostgreSQL es compartido, así que las 2 réplicas Railway ya ven los mismos blobs.

**Las razones reales para migrar son escalabilidad SaaS, no consistency**:

1. **DB infla con cada upload**. Una foto JPG de 1MB ocupa ~1.33MB en base64. Backups
   logical (`pg_dump`) crecen igual de rápido. A escala de "cientos de empresas con
   miles de fotos cada una", esto degrada backup window, restore time, replication lag.

2. **CPU desperdiciado en cada GET**. PostgreSQL decodifica TOAST + el backend hace
   `JSON.stringify({ data: base64 })` por cada download. R2 sirve el binario directo.

3. **Egress por Railway** en lugar de CDN. Hoy los downloads consumen el ancho de
   banda del proceso Node (cuenta como uso Railway). R2 incluye egress gratis
   ([R2 pricing](https://developers.cloudflare.com/r2/pricing/) — $0.015/GB-month de
   almacenamiento, **egress $0**).

4. **PostgreSQL no es object storage**. TOAST funciona pero está optimizado para
   columnas grandes de texto, no para servir binarios a escala. Tablas como
   `productos` se vuelven lentas de `SELECT *` cuando tienen blobs (aunque hagamos
   `SELECT col1, col2` el plan a veces escanea filas grandes igual).

5. **Migración multi-tenant futura más limpia**. Cuando hagamos tenant_id (TANDA 6
   SE-02), tener blobs de MB en cada fila convierte el backfill `UPDATE tenant_id`
   en pesadilla. Si R2 ya está hecho, el backfill toca solo metadata.

### 1.3 Por qué Cloudflare R2 y no AWS S3

- **Costos**: R2 es ~$0.015/GB-mes vs S3 a ~$0.023/GB-mes. Egress **gratis** en R2
  vs $0.09/GB en S3 (esto es lo crítico — si servimos 100GB/mes de fotos, S3 cuesta
  $9 de egress, R2 cuesta $0).
- **API compatible con S3**: usamos `@aws-sdk/client-s3` apuntando al endpoint R2.
  Si el día de mañana cambiamos a S3 (o a Backblaze B2, o a MinIO self-hosted), es
  cambiar 1 env var.
- **Cloudflare ya está en la mente del stack**: workers, DNS, CDN. Una cuenta más.

### 1.4 Cómo se reutiliza la arquitectura existente

- Las columnas `*_nombre` y `*_tipo` ya guardan metadata (filename + MIME) → se
  mantienen tal cual.
- El cliente ya manda `{ archivo_data: <base64>, archivo_nombre, archivo_tipo }` en
  el body — **no cambia el contrato del frontend** durante la migración.
- El audit log ya excluye el blob del `despues` con destructuring (`const { archivo_data: _blob, ...rest } = rows[0]`).
- El soft-delete (`deleted_at`) se aplica también a los blobs (no se borran de R2
  hasta que se haga purga, ver §5.5).

---

## 2. Diseño

### 2.1 Abstracción `fileStore.js`

Nueva librería `backend/src/lib/fileStore.js` con 2 drivers seleccionables por env
var `STORAGE_DRIVER`:

```
                       ┌─────────────────────────────────┐
   routes/             │  fileStore.put(buffer, mime)    │
   comprobantes.js ────▶  fileStore.get(row)             │
   inventario.js       │  fileStore.delete(row)          │
   ventas-extra.js     │  fileStore.stream(row)          │
                       └────────────┬────────────────────┘
                                    │
                       ┌────────────┴────────────┐
                       │                         │
                  ┌────▼─────┐             ┌─────▼─────┐
                  │ driver:  │             │ driver:   │
                  │   db     │             │   r2      │
                  │          │             │           │
                  │ writes   │             │ writes to │
                  │ base64   │             │ R2 bucket,│
                  │ to col   │             │ writes key│
                  │          │             │ to col    │
                  └──────────┘             └───────────┘
```

### 2.2 Schema changes

Agregar 2 columnas opcionales a cada una de las 3 tablas:

```sql
-- comprobantes
ALTER TABLE comprobantes
  ADD COLUMN archivo_key  TEXT NULL,    -- R2 object key (NULL si está en archivo_data legacy)
  ADD COLUMN archivo_size INT  NULL;    -- bytes (para tracking de uso de bucket)

-- productos
ALTER TABLE productos
  ADD COLUMN foto_key  TEXT NULL,
  ADD COLUMN foto_size INT  NULL;

-- venta_comprobantes
ALTER TABLE venta_comprobantes
  ADD COLUMN archivo_key  TEXT NULL,
  ADD COLUMN archivo_size INT  NULL;
```

**Invariante**: para cada fila, **exactamente una** de `archivo_data` / `archivo_key`
es NOT NULL (o ambas NULL si el row no tiene archivo). Los reads chequean primero
`archivo_key` (R2), después fallback a `archivo_data` (legacy).

`archivo_data` queda en el schema **hasta que el backfill (Fase 6) termine y se valide**.
Después, se hace `UPDATE archivo_data = NULL WHERE archivo_key IS NOT NULL` para liberar
TOAST. La columna en sí se mantiene como guard rail por si necesitamos rollback masivo.

### 2.3 Object key strategy

Layout de keys en R2:

```
ipro/
├── prod/
│   ├── comprobantes/
│   │   └── 2026/06/12/<uuid>.<ext>
│   ├── productos/
│   │   └── <producto-id>/foto-<uuid>.<ext>
│   └── venta-comprobantes/
│       └── <venta-id>/<uuid>.<ext>
└── staging/
    └── (mismo layout, bucket separado)
```

Notas:
- **UUID en el filename**, no el filename original — evita colisiones cuando dos
  usuarios suben "DSC_0001.jpg" el mismo día.
- **Path con fecha/id en el medio**, no en el filename — facilita listing
  ("¿cuántos uploads en junio?") con `aws s3 ls`.
- **Bucket separado por env** (`ipro-staging` y `ipro-prod`) — un bug en staging no
  debería poder borrar archivos prod.

### 2.4 Driver `db` (no-op)

Mantiene comportamiento actual. Su propósito es Fase 1: refactorizar los call sites
para usar `fileStore.put/get` sin cambiar la lógica, así Fase 2 (driver R2) es solo
cambio de env var.

```js
const dbDriver = {
  async put(buffer, mime, opts) {
    // Devuelve la forma que va a INSERT
    return {
      data: buffer.toString('base64'),
      nombre: opts.filename,
      tipo: mime,
      key:  null,        // <-- ambas columnas, key=null
      size: null,
    };
  },
  async get(row) {
    // row tiene { archivo_data, archivo_key, archivo_nombre, archivo_tipo }
    if (row.archivo_data) {
      return { data: row.archivo_data, nombre: row.archivo_nombre, tipo: row.archivo_tipo };
    }
    return null;
  },
  async delete(row) { /* no-op, soft-delete via deleted_at en la fila */ },
};
```

### 2.5 Driver `r2`

Usa `@aws-sdk/client-s3` apuntando al endpoint R2:

```js
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: 'auto',                           // R2 ignora region pero AWS SDK lo exige
  endpoint: process.env.R2_ENDPOINT,        // https://<accountid>.r2.cloudflarestorage.com
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const r2Driver = {
  async put(buffer, mime, opts) {
    const ext = extensionFromMime(mime) || 'bin';
    const key = `ipro/${env}/${opts.entity}/${opts.subpath}/${randomUUID()}.${ext}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mime,
      Metadata: { 'original-name': opts.filename },
    }));
    return {
      data: null,        // <-- ambas columnas, data=null
      nombre: opts.filename,
      tipo: mime,
      key,
      size: buffer.length,
    };
  },
  async get(row) {
    // Fallback a legacy si la fila no migró todavía
    if (row.archivo_data) {
      return { data: row.archivo_data, nombre: row.archivo_nombre, tipo: row.archivo_tipo };
    }
    if (!row.archivo_key) return null;
    const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: row.archivo_key }));
    const buffer = await streamToBuffer(obj.Body);
    return { data: buffer.toString('base64'), nombre: row.archivo_nombre, tipo: row.archivo_tipo };
  },
  async delete(row) {
    if (!row.archivo_key) return;
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: row.archivo_key }));
  },
  async stream(row) {
    // Para export-zip: devuelve Readable sin cargar a memoria
    if (row.archivo_data) return Readable.from([Buffer.from(row.archivo_data, 'base64')]);
    const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: row.archivo_key }));
    return obj.Body;  // ya es un Readable
  },
};
```

### 2.6 Feature flags por entity

Usamos el sistema de feature flags ya implementado (M-08, TANDA 6). 3 flags
independientes:

| Flag | Cuando ON | Cuando OFF |
|---|---|---|
| `storage_r2_comprobantes` | Uploads nuevos van a R2 | Uploads nuevos van a archivo_data |
| `storage_r2_productos` | Idem foto_data | Idem |
| `storage_r2_ventas_comprobantes` | Idem | Idem |

**Reads siempre intentan R2 primero, fallback a legacy**, independiente del flag.
Esto permite que el flag se prenda/apague sin perder acceso a uploads anteriores.

Activación gradual planeada:
1. Flag OFF → desplegamos infra R2 + driver, verde-deploy sin uso real.
2. Flag ON en staging → smoke test con uploads reales.
3. Flag ON en `comprobantes` prod → 1 día de observación.
4. Flag ON en `productos` prod → 1 día.
5. Flag ON en `venta_comprobantes` prod.
6. Backfill histórico (Fase 6).

### 2.7 Tratamiento del export-zip

El endpoint `GET /api/comprobantes/export-zip` es el caso especial porque carga
N comprobantes en memoria. Con R2 + streaming, podemos eliminar el cap de 1000:

```js
for (const c of rows) {
  const stream = await fileStore.stream(c);  // Readable, no Buffer
  archive.append(stream, { name: candidato });
}
```

Pero **NO eliminamos el cap en esta tanda** — lo mantenemos como defensa anti-abuso
(un cliente legítimo no descarga 5000 comprobantes; un atacante o un bug en el
frontend sí).

---

## 3. Fases de implementación

| Fase | Qué hace | Effort | PR | Riesgo |
|---|---|---|---|---|
| 1 | `fileStore.js` + driver `db` + refactor de 3 endpoints upload + 3 endpoints download | 4h | #X | Bajo — no-op funcional |
| 2 | Driver `r2` + infra Cloudflare + tests con mock S3 | 4h | #X+1 | Bajo — flag OFF |
| 3 | Migrar `comprobantes` con flag `storage_r2_comprobantes` | 3h | #X+2 | Medio — primer entity en prod |
| 4 | Migrar `productos.foto_data` con flag `storage_r2_productos` | 2h | #X+3 | Bajo |
| 5 | Migrar `venta_comprobantes` con flag `storage_r2_ventas_comprobantes` | 2h | #X+4 | Bajo |
| 6 | Backfill script (mover blobs legacy a R2) + RUNBOOK + cleanup `archivo_data` post-validación | 4-6h | #X+5 | Medio — toca prod data |

**Total**: ~19-21h, alineado con la estimación de la auditoría (16-24h).

### 3.1 Detalle Fase 1 (refactor a fileStore)

Archivos modificados:
- **CREATE** `backend/src/lib/fileStore.js` (driver db únicamente).
- **MODIFY** `backend/src/routes/comprobantes.js`:
  - POST `/` y POST `/manuales`: usar `fileStore.put()` para construir el INSERT.
  - GET `/:id/archivo`: usar `fileStore.get()`.
  - GET `/export-zip`: por ahora sigue usando `archivo_data` directo (Fase 2 lo
    pasa a `fileStore.stream()`).
- **MODIFY** `backend/src/routes/inventario.js`: `POST /productos`, `PUT /productos/:id`, `GET /productos/:id/foto`.
- **MODIFY** `backend/src/routes/ventas-extra.js`: `POST /:id/comprobantes`, `GET /comprobantes/:cid`.

Sin migration en Fase 1. Sin cambio funcional. Tests verde igual.

### 3.2 Detalle Fase 2 (driver R2 + infra)

- **CREATE** bucket R2 (uno staging, uno prod).
- **CREATE** API Token en Cloudflare con permisos `Object Read & Write` solo a
  esos buckets.
- **CONFIG** env vars en Railway:
  - `R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`
  - `R2_BUCKET=ipro-staging` o `ipro-prod`
  - `R2_ACCESS_KEY_ID=...`
  - `R2_SECRET_ACCESS_KEY=...`
  - `STORAGE_DRIVER=db` ← se mantiene `db` hasta Fase 3
- **INSTALL** `@aws-sdk/client-s3` (~3MB, único package nuevo).
- **MODIFY** `backend/src/lib/fileStore.js`: agregar driver `r2`, selector por
  `STORAGE_DRIVER` env var.
- **CREATE** `backend/tests/file-store.test.js` con mock S3 (jest auto-mock o
  `aws-sdk-client-mock`).
- **CREATE** migration `XXXX_add_storage_key_columns.js` con los `ALTER TABLE`.

### 3.3 Detalle Fase 3-5 (migración por entity)

Cada fase es similar:
- Modificar los call sites POST/PUT/PATCH para que cuando el feature flag esté ON,
  usen `fileStore.put({ entity: '<entity>', ... })` que respeta `STORAGE_DRIVER`.
- Los GET ya están unificados desde Fase 1, no requieren cambio.
- Activar flag en staging, smoke test, activar en prod.
- Wait 24h, validar Sentry sin errores, pasar a la siguiente entity.

### 3.4 Detalle Fase 6 (backfill + RUNBOOK)

Script idempotente `backend/scripts/r2-backfill.js`:

```bash
# Dry-run: cuenta cuántas filas migraría, sin tocar nada
node backend/scripts/r2-backfill.js --table comprobantes --dry-run

# Real: en chunks de 50 filas con WHERE archivo_data IS NOT NULL AND archivo_key IS NULL
node backend/scripts/r2-backfill.js --table comprobantes --batch 50

# Validar: SELECT COUNT(*) WHERE archivo_data IS NOT NULL AND archivo_key IS NOT NULL
node backend/scripts/r2-backfill.js --validate

# Limpieza (después de 1 semana de observación):
node backend/scripts/r2-backfill.js --cleanup-legacy --table comprobantes
# = UPDATE comprobantes SET archivo_data = NULL WHERE archivo_key IS NOT NULL
```

RUNBOOK operacional en `docs/OPERATIONS.md`:
- Cómo listar archivos en R2 (`wrangler r2 object list`)
- Cómo recuperar un archivo borrado por error (R2 no tiene versioning por default)
- Cómo monitorear costos (Cloudflare dashboard, alerta a $5/mes)
- Cómo rotar credenciales R2 (lección de los leaks de PAT/password en P-04)
- Failover: si R2 cae, ¿qué pasa? (uploads fallan, downloads de archivos R2 fallan,
  downloads de legacy siguen ok)

---

## 4. Preguntas abiertas (necesito que las respondas)

### 4.1 Cuenta Cloudflare y bucket
¿Tenés cuenta Cloudflare con R2 habilitado? R2 requiere agregar payment method
(aunque el free tier cubre 10GB de almacenamiento y 1M operaciones/mes). Si no
tenés, te paso los pasos para crearla.

### 4.2 Nombre de los buckets
Propuesta: `ipro-staging` y `ipro-prod`. ¿Te sirve o querés otro nombre?

### 4.3 Región del bucket
R2 tiene location hints (WNAM, ENAM, WEUR, EEUR, APAC). ¿Tu tráfico principal
es Argentina/LATAM? Sugerencia: **ENAM** (East North America) — más cerca de
Railway US-East que default y la latencia a Argentina es similar a otras opciones.

### 4.4 Política de retención
¿Querés que los archivos borrados (soft-delete `deleted_at`) se purguen de R2
después de N días? Sugerencia: mantener todo (R2 es barato, $0.015/GB) y dejar
la purga para una TANDA futura cuando ya tengamos métricas reales.

### 4.5 Signed URLs vs proxy
Hoy el backend baja el archivo de R2 y lo manda al cliente como base64 (modo
proxy). Esto **no aprovecha el egress gratis de R2** porque sale por Railway.

Alternativa (futura TANDA, no en P-03): cliente recibe un signed URL de R2 con
TTL 5min y baja directo. Pero requiere cambiar el contrato API (cliente recibe
`{ url }` en lugar de `{ data }`) y cambios en `<img>` y descarga de comprobantes.

¿Te parece bien dejar **proxy mode en P-03** (ya bajamos DB y CPU PostgreSQL,
que es el 80% del beneficio) y meter signed URLs como follow-up cuando haga
falta optimizar egress?

### 4.6 Backfill de blobs históricos
Hoy hay X comprobantes y Y fotos en prod (no conozco el número exacto). El
backfill puede tomar de minutos a horas según el volumen. ¿Querés que sea:

a) **Inmediato post-Fase 5** (todo de una vez en una ventana baja-tráfico),
b) **Gradual** (script corre en cron 1× por hora migrando 100 filas, durante
   varios días) — más seguro pero el "estado mixto" dura más.

Sugerencia: (a) si el dataset es < 5000 archivos (cabe en una ejecución de 30min);
(b) si es > 5000.

---

## 5. Riesgos y mitigaciones

### 5.1 R2 outage durante upload
**Riesgo**: usuario hace POST con un archivo, R2 está caído, el INSERT fallaría.
**Mitigación**: en caso de R2 error, **fallback al driver db** (guardar como
base64 en `archivo_data`) y loggear warn a Sentry. El upload no falla, solo
se queda en estado legacy hasta el próximo backfill. **Trade-off**: cuando hay
outage, perdemos el beneficio de R2 hasta que cleanup posterior lo mueva.

### 5.2 R2 outage durante download
**Riesgo**: `GET /:id/archivo` falla cuando `archivo_key` está seteado pero R2
está caído.
**Mitigación**: response 503 con mensaje claro. El frontend ya maneja 5xx.
**Detección**: Sentry alerta si error rate de `GET archivo` sube por encima de 1%.

### 5.3 archivo_key apunta a objeto inexistente
**Riesgo**: alguien borró un objeto en R2 a mano, pero la fila en DB sigue
referenciándolo.
**Mitigación**: cuando `get(row)` recibe NoSuchKey, devolver 404 con mensaje
"archivo eliminado del storage". Periódicamente correr un script de validación
que verifica que `archivo_key` existen en R2 (puede ser parte del cron de
invariantes nocturno).

### 5.4 Costos descontrolados
**Riesgo**: bug que sube archivos sin límite, factura R2 se dispara.
**Mitigación**:
- Body limit `express.json({ limit: '10mb' })` ya está → tope por request.
- Schemas Zod validan archivo_data size en backend.
- Alert en Cloudflare dashboard cuando bucket pasa $5/mes (Q4.4 sugerida).

### 5.5 Credenciales filtradas (lección P-04)
**Riesgo**: como pasó con PAT y password Redis durante TANDA 6 P-04, las
credenciales R2 podrían filtrarse en screenshots, logs, etc.
**Mitigación**:
- API Token Cloudflare con scope **solo a esos 2 buckets** (no a toda la
  cuenta).
- Rotación rápida disponible: documentada en RUNBOOK Fase 6.
- Sentry beforeSend redacta `R2_ACCESS_KEY_ID` y `R2_SECRET_ACCESS_KEY` (ya
  redacta otros secrets — agregar a la lista).

---

## 6. Rollback plan

Cada fase tiene un rollback distinto:

### Fase 1 (fileStore.js + driver db)
**Rollback**: revertir el PR. Driver db es no-op funcional → reverting no afecta
data.

### Fase 2 (driver r2 + infra)
**Rollback**: revertir el PR. `STORAGE_DRIVER=db` queda → driver r2 ni se carga.
Los buckets R2 quedan vacíos, no se borran nunca para preservar historial.

### Fase 3-5 (migración por entity)
**Rollback nivel 1 (~10 segundos)**: PATCH al feature flag → OFF. Uploads nuevos
vuelven a `archivo_data`. Los uploads ya en R2 se siguen sirviendo (read fallback).

**Rollback nivel 2 (~5 minutos)**: en Railway, setear `STORAGE_DRIVER=db` y reiniciar.
Driver r2 se desactiva. Reads que dependen de R2 (filas con `archivo_key` y sin
`archivo_data`) fallan con 404 — pero **no debería haber tales filas si el flag
estuvo poco tiempo activo**.

**Rollback nivel 3 (escenario peor)**: si activamos el flag por días y hay miles
de filas con `archivo_key` only, no podemos rollback sin migrar los blobs de
vuelta. Mitigación: **mantener el flag en staging por 1 semana antes de prod**.

### Fase 6 (backfill + cleanup)
- Backfill: idempotente, re-correrlo es seguro.
- Cleanup (`SET archivo_data = NULL`): irreversible **a menos que tengamos backup**.
  Plan: hacer backup logical (`pg_dump`) ANTES del cleanup, guardarlo fuera de
  Railway por 30 días. Si surge un bug en R2, restore.

---

## 7. Tests

### 7.1 Unit tests fileStore (`backend/tests/file-store.test.js`)

- Driver db: `put` devuelve `{ data, nombre, tipo, key: null }`.
- Driver db: `get` lee de `archivo_data`.
- Driver r2: `put` con mock S3 valida `PutObjectCommand` params (Bucket, Key, Body, ContentType).
- Driver r2: `get` con fila que tiene solo `archivo_data` (legacy) → no consulta S3, devuelve base64.
- Driver r2: `get` con fila que tiene solo `archivo_key` → consulta S3, devuelve base64.
- Driver r2: `get` con S3 NoSuchKey → devuelve null.
- Driver r2: `delete` con fila legacy (sin key) → no consulta S3.
- Driver r2: error de red en `put` → throwea, no swallow.

### 7.2 Integration tests (`backend/tests/storage-integration.test.js`)

- Upload con `STORAGE_DRIVER=db` → fila tiene `archivo_data`, `archivo_key=null`.
- Upload con `STORAGE_DRIVER=r2` (mock) → fila tiene `archivo_data=null`, `archivo_key='...'`.
- Download de fila legacy + driver r2 → fallback a `archivo_data`, no consulta R2.
- Download de fila R2 + driver db → 404 (driver db no sabe leer key).
- Feature flag toggling: con flag OFF post-Fase 3, uploads nuevos van a `archivo_data` aunque `STORAGE_DRIVER=r2`.

### 7.3 Smoke test post-Fase 2 (manual)

Script `backend/scripts/r2-smoke.js`:
```bash
node backend/scripts/r2-smoke.js
# Outputs:
# ✓ Connected to R2 (latency 47ms)
# ✓ PUT test.txt (1KB)
# ✓ GET test.txt (content matches)
# ✓ DELETE test.txt
# ✓ List bucket (1 object)
```

Esto confirma que las credenciales y el endpoint funcionan antes de meter
código en el path crítico.

---

## 8. Costos esperados

**Hipótesis** (ajustar con datos reales del backfill):
- 1000 comprobantes promedio 1MB cada uno = 1GB
- 5000 fotos producto promedio 500KB cada uno = 2.5GB
- 2000 venta_comprobantes promedio 800KB = 1.6GB
- **Total estimado**: ~5GB en R2

Costo mensual R2:
- Almacenamiento: 5GB × $0.015 = **$0.075/mes**
- Class A operations (PUT, COPY): ~1000/mes × $0.0045 per 1000 = **$0.0045/mes**
- Class B operations (GET): ~50000/mes × $0.00036 per 1000 = **$0.018/mes**
- Egress: **$0** (R2 incluye egress gratis)
- **Total**: **~$0.10/mes** mientras estemos en esta escala.

Free tier cubre los primeros 10GB de almacenamiento, así que el primer
año probablemente sea **$0**.

---

## 9. Métricas de éxito

Post-Fase 6 (cleanup ejecutado):

- ✅ Tamaño de las 3 tablas reducido en al menos 80% (medible con `pg_total_relation_size`).
- ✅ Backup logical (`pg_dump`) toma 30%+ menos tiempo.
- ✅ `SELECT *` sobre `productos` o `comprobantes` es notablemente más rápido (medible con EXPLAIN ANALYZE).
- ✅ Cero errores 5xx en endpoints upload/download durante 1 semana post-Fase 5.
- ✅ Sentry sin warnings de R2 timeout o falla.

---

## 10. Out of scope (para futuras tandas)

- **Signed URLs** para que el cliente baje directo de R2 (Q4.5).
- **Image resizing** automático (thumbnails para `tiene_foto` listings).
- **Public bucket** con CDN para fotos de productos (si las queremos mostrar en
  web pública futura).
- **Multi-region replication** R2.
- **Versioning** de objetos para audit trail de cambios.
- **Lifecycle rules** (auto-delete files older than X years).

---

## Anexo A — Archivos a tocar (resumen)

**Backend** (en orden de fases):
- `backend/src/lib/fileStore.js` (CREATE — Fase 1)
- `backend/src/routes/comprobantes.js` (MODIFY — Fase 1 + Fase 3)
- `backend/src/routes/inventario.js` (MODIFY — Fase 1 + Fase 4)
- `backend/src/routes/ventas-extra.js` (MODIFY — Fase 1 + Fase 5)
- `backend/package.json` (ADD `@aws-sdk/client-s3` — Fase 2)
- `backend/migrations/XXXX_add_storage_key_columns.js` (CREATE — Fase 2)
- `backend/tests/file-store.test.js` (CREATE — Fase 2)
- `backend/tests/storage-integration.test.js` (CREATE — Fase 2)
- `backend/scripts/r2-smoke.js` (CREATE — Fase 2)
- `backend/scripts/r2-backfill.js` (CREATE — Fase 6)

**Docs**:
- `docs/STORAGE.md` (UPDATE — Fase 6: marcar como migrado a R2)
- `docs/OPERATIONS.md` (UPDATE — Fase 6: sección 7 RUNBOOK R2)
- `docs/design/p03-r2-storage.md` (este archivo, marcar IMPLEMENTADO en Fase 6)

**Infra**:
- Cloudflare R2 buckets `ipro-staging` e `ipro-prod` (Fase 2)
- Cloudflare API Token con scope a esos buckets (Fase 2)
- Railway env vars `R2_*` en staging y prod (Fase 2)
- 3 feature flags via `POST /api/admin/feature-flags` (Fases 3-5)
