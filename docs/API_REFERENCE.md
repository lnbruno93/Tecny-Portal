# iPro Portal — API Reference

> Base URL producción: Railway (ver `CORS_ORIGIN` en variables de entorno)  
> Base URL desarrollo: `http://localhost:3001`
>
> Todos los endpoints autenticados requieren header:  
> `Authorization: Bearer <JWT>`

---

## Índice

- [Autenticación](#autenticación-apiaauth)
- [Comprobantes](#comprobantes-apicomprobantes) · [Pagos](#pagos-apipagos) · [Vendedores](#vendedores-apivendedores) · [Config](#config-apiconfig) · [Historial](#historial-apihistorial) · [OCR](#ocr-apiocr)
- [Contactos](#contactos-apicontactos) · [Cajas](#cajas-apicajas)
- [Envíos](#envíos-apienvios)
- [Usuarios](#usuarios-apiusuarios)
- [Health Check](#health-check)
- [Errores](#errores)
- [Paginación](#paginación)

---

## Autenticación (`/api/auth`)

### `POST /api/auth/login`

Autentica al usuario y devuelve un JWT.

**Rate limit:** 10 intentos fallidos / 15 min por IP (requests exitosos no cuentan).

**Body:**
```json
{ "username": "admin", "password": "mi_contraseña" }
// o con email:
{ "email": "user@example.com", "password": "mi_contraseña" }
```

**Respuesta 200:**
```json
{
  "token": "eyJhbGci...",
  "user": {
    "id": 1,
    "nombre": "Lucas Bruno",
    "username": "lucas",
    "email": "lucas@example.com",
    "role": "admin",
    "perms": {
      "cotizador": true,
      "financiera": true,
      "cajas": true,
      "envios": true,
      "usuarios": true
    }
  }
}
```

**Errores:** `400` body inválido · `401` credenciales incorrectas

---

### `GET /api/auth/me`

Devuelve el perfil del usuario autenticado.

**Auth:** Requerida

**Respuesta 200:**
```json
{
  "id": 1,
  "nombre": "Lucas Bruno",
  "username": "lucas",
  "email": "lucas@example.com",
  "role": "admin",
  "perms": { "financiera": true, "cajas": true, ... }
}
```

---

### `POST /api/auth/logout`

Invalida **todos** los tokens activos del usuario (incluyendo otros dispositivos).

**Auth:** Requerida  
**Mecanismo:** actualiza `password_changed_at = NOW()`. Cualquier token con `iat_ms` anterior al cambio es rechazado automáticamente.

**Respuesta 200:** `{ "ok": true }`

---

### `POST /api/auth/change-password`

Cambia la contraseña. Invalida todos los tokens activos.

**Auth:** Requerida

**Body:**
```json
{ "currentPassword": "contraseña_actual", "newPassword": "nueva_min8_chars" }
```

**Respuesta 200:** `{ "ok": true }`

**Errores:** `400` nueva contraseña < 8 chars · `401` contraseña actual incorrecta

---

## Comprobantes (`/api/comprobantes`)

**Permiso requerido:** `financiera`

### `GET /api/comprobantes/totales`

Totales agregados con los mismos filtros que el listado.

**Query params:** `desde?` · `hasta?` · `vendedor?` · `buscar?`

**Respuesta 200:**
```json
{ "count": 42, "total_monto": 850000, "total_financiera": 25500, "total_neto": 824500 }
```

---

### `GET /api/comprobantes`

Lista paginada de comprobantes.

**Query params:**

| Param | Tipo | Descripción |
|-------|------|-------------|
| `desde` | date (YYYY-MM-DD) | Fecha mínima |
| `hasta` | date (YYYY-MM-DD) | Fecha máxima |
| `vendedor` | string | Filtro por nombre de vendedor (exacto) |
| `buscar` | string | ILIKE en cliente y referencia |
| `page` | int | Página (default: 1) |
| `limit` | int | Por página (default: 50, máx: 200) |

**Respuesta 200:**
```json
{
  "data": [
    {
      "id": 1,
      "fecha": "2026-01-15",
      "cliente": "Empresa XYZ",
      "vendedor_id": 2,
      "vendedor_nombre": "Juan Pérez",
      "monto": 50000,
      "monto_financiera": 1500,
      "monto_neto": 48500,
      "referencia": "FAC-001",
      "archivo_nombre": "factura.pdf",
      "archivo_tipo": "application/pdf",
      "created_at": "2026-01-15T10:30:00Z"
    }
  ],
  "pagination": { "total": 42, "page": 1, "limit": 50, "pages": 1 }
}
```

> `archivo_data` (base64) no se incluye en el listado — usar `GET /:id/archivo` para descargarlo.

---

### `POST /api/comprobantes`

Crea un comprobante.

**Body:**
```json
{
  "fecha": "2026-01-15",
  "cliente": "Empresa XYZ",
  "vendedor_id": 2,
  "monto": 50000,
  "monto_financiera": 1500,
  "monto_neto": 48500,
  "referencia": "FAC-001",
  "archivo_data": "data:application/pdf;base64,JVBERi0...",
  "archivo_nombre": "factura.pdf",
  "archivo_tipo": "application/pdf"
}
```

| Campo | Requerido | Tipo | Restricciones |
|-------|-----------|------|---------------|
| `fecha` | ✓ | date | YYYY-MM-DD |
| `cliente` | ✓ | string | 1–200 chars |
| `monto` | ✓ | number | > 0 |
| `monto_financiera` | — | number | ≥ 0 (default 0) |
| `monto_neto` | — | number | ≥ 0 |
| `vendedor_id` | — | int | FK vendedores |
| `referencia` | — | string | ≤ 500 chars |
| `archivo_data` | — | string | base64, máx 7MB |
| `archivo_nombre` | — | string | ≤ 255 chars |
| `archivo_tipo` | — | enum | `image/jpeg` · `image/png` · `image/webp` · `application/pdf` |

**Respuesta 201:** objeto comprobante creado.

---

### `DELETE /api/comprobantes/:id`

Soft-delete de un comprobante.

**Respuesta 200:** `{ "ok": true }` · **404** si no existe

---

### `GET /api/comprobantes/:id/archivo`

Devuelve el archivo adjunto de un comprobante.

**Respuesta 200:**
```json
{
  "data": "data:application/pdf;base64,JVBERi0...",
  "nombre": "factura.pdf",
  "tipo": "application/pdf"
}
```

**Errores:** `404` sin archivo adjunto

---

## Pagos (`/api/pagos`)

**Permiso requerido:** `financiera`

### `GET /api/pagos/totales`

**Respuesta 200:** `{ "count": 5, "total_monto": 75000 }`

---

### `GET /api/pagos`

**Query params:** `page?` · `limit?` (default: 100, máx: 200)

**Respuesta 200:** `{ data: [...], pagination: {...} }` — ordenado por `fecha DESC`.

---

### `POST /api/pagos`

**Body:**
```json
{ "fecha": "2026-01-20", "monto": 15000, "referencia": "Pago proveedores enero" }
```

**Respuesta 201:** objeto pago creado.

---

### `DELETE /api/pagos/:id`

Soft-delete. **Respuesta 200:** `{ "ok": true }`

---

## Vendedores (`/api/vendedores`)

**Permiso requerido:** `financiera`

### `GET /api/vendedores`

**Query params:** `buscar?` — filtro ILIKE por nombre

**Respuesta 200:** array de hasta 500 vendedores activos.
```json
[{ "id": 1, "nombre": "Juan Pérez", "created_at": "..." }]
```

---

### `POST /api/vendedores`

**Body:** `{ "nombre": "Nombre del vendedor" }` (1–100 chars)

**Respuesta 201:** objeto vendedor · **409** si ya existe un vendedor activo con ese nombre.

---

### `DELETE /api/vendedores/:id`

Soft-delete. **Respuesta 200:** `{ "ok": true }`

---

## Config (`/api/config`)

**Permiso requerido:** `financiera` (GET) · solo admin (PUT)

### `GET /api/config`

**Respuesta 200:** `{ "id": 1, "pct_financiera": 3.0, "updated_at": "..." }` o `{}` si no hay configuración.

---

### `PUT /api/config`

**Body:** `{ "pct_financiera": 3.5 }` (0–100)

**Respuesta 200:** config actualizada.

---

## Historial (`/api/historial`)

**Permiso requerido:** `financiera`

### `GET /api/historial`

Lista paginada de todas las acciones auditadas (fuente: `audit_logs`).

**Query params:** `page?` · `limit?` (default: 50, máx: 200)

**Respuesta 200:**
```json
{
  "data": [
    {
      "id": 123,
      "accion": "comprobantes: INSERT",
      "detalle": "Empresa XYZ",
      "usuario_nombre": "Lucas Bruno",
      "creado_en": "2026-01-15T10:30:00Z"
    }
  ],
  "pagination": { "total": 500, "page": 1, "limit": 50, "pages": 10 }
}
```

- `accion`: formato `"tabla: ACCION"` (ej. `"comprobantes: INSERT"`)
- `detalle`: campo descriptivo derivado del dato modificado (cliente, nombre, username, o ID)

---

## OCR (`/api/ocr`)

**Permiso requerido:** `financiera`  
**Rate limit:** 10 llamadas / hora por usuario  
**Requiere:** `ANTHROPIC_API_KEY` en el entorno

### `POST /api/ocr`

Extrae el monto total de una imagen de comprobante/factura usando Claude Haiku.

**Body:**
```json
{
  "imageData": "data:image/jpeg;base64,/9j/4AAQ...",
  "mediaType": "image/jpeg"
}
```

| Campo | Tipo | Valores válidos |
|-------|------|----------------|
| `imageData` | string | base64 con o sin prefijo `data:...` — máx 7MB |
| `mediaType` | enum | `image/jpeg` · `image/png` · `image/webp` · `image/gif` |

**Respuesta 200:**
```json
{ "monto": 15000.50 }
// o si no se puede determinar:
{ "monto": null }
```

**Errores:** `429` límite alcanzado · `503` API key no configurada

---

## Contactos (`/api/contactos`)

**Permiso requerido:** `cajas`

### `GET /api/contactos`

**Query params:** `buscar?` — ILIKE en nombre y apellido

**Respuesta 200:** array de hasta 500 contactos activos.
```json
[{ "id": 1, "nombre": "Ana", "apellido": "García", "tipo": "cliente", "created_at": "..." }]
```

**Tipos válidos:** `amigo` · `familiar` · `cliente` · `inversor` · `ipro team`

---

### `POST /api/contactos`

**Body:**
```json
{ "nombre": "Ana", "apellido": "García", "tipo": "cliente" }
```

**Respuesta 201:** objeto contacto · **409** si ya existe contacto activo con mismo nombre+apellido+tipo.

---

### `PUT /api/contactos/:id`

Actualización parcial — todos los campos son opcionales (COALESCE).

**Body:** `{ "nombre?": "...", "apellido?": "...", "tipo?": "..." }`

**Respuesta 200:** contacto actualizado.

---

### `DELETE /api/contactos/:id`

Soft-delete. **Respuesta 200:** `{ "ok": true }`

---

## Cajas (`/api/cajas`)

**Permiso requerido:** `cajas`

### `GET /api/cajas/resumen`

Agregados por contacto.

**Respuesta 200:**
```json
{
  "deudas": [
    {
      "contacto_id": 1,
      "nombre": "Ana",
      "apellido": "García",
      "saldo_ars": 50000,
      "saldo_usd": 200,
      "movimientos": 5
    }
  ],
  "inversiones": [
    {
      "contacto_id": 2,
      "nombre": "Carlos",
      "apellido": "Lopez",
      "total_invertido": 100000,
      "movimientos": 3,
      "ultima_tasa": "3%"
    }
  ]
}
```

> **Deudas:** `saldo = SUM(debe) - SUM(pago)` en ARS y USD por separado.  
> **Inversiones:** `total_invertido = SUM(monto)` con la tasa del movimiento más reciente.

---

### `GET /api/cajas/deudas`

**Query params:** `contacto_id?` · `page?` · `limit?` (default: 100)

**Respuesta 200:** `{ data: [...], pagination: {...} }` con nombre y apellido del contacto incluidos.

---

### `POST /api/cajas/deudas`

**Body:**
```json
{
  "fecha": "2026-01-10",
  "contacto_id": 1,
  "tipo": "debe",
  "monto_ars": 50000,
  "monto_usd": 0,
  "concepto": "Préstamo enero"
}
```

| Campo | Requerido | Restricciones |
|-------|-----------|---------------|
| `fecha` | ✓ | date |
| `contacto_id` | ✓ | int > 0 |
| `tipo` | ✓ | `debe` o `pago` |
| `monto_ars` | ✓ | ≥ 0 |
| `monto_usd` | ✓ | ≥ 0 |
| — | — | al menos uno > 0 |
| `concepto` | — | ≤ 500 chars |

**Respuesta 201:** movimiento creado.

---

### `DELETE /api/cajas/deudas/:id`

Soft-delete. **Respuesta 200:** `{ "ok": true }`

---

### `GET /api/cajas/inversiones`

**Query params:** `contacto_id?` · `page?` · `limit?` (default: 100)

**Respuesta 200:** `{ data: [...], pagination: {...} }`

---

### `POST /api/cajas/inversiones`

**Body:**
```json
{ "fecha": "2026-01-01", "contacto_id": 2, "monto": 100000, "tasa": "3% mensual" }
```

**Respuesta 201:** movimiento creado.

---

### `DELETE /api/cajas/inversiones/:id`

Soft-delete. **Respuesta 200:** `{ "ok": true }`

---

## Envíos (`/api/envios`)

**Permiso requerido:** `envios`

### `GET /api/envios`

Lista paginada con ítems incluidos.

**Query params:**

| Param | Tipo | Descripción |
|-------|------|-------------|
| `estado` | enum | `Pendiente` · `En camino` · `Entregado` · `Cancelado` |
| `buscar` | string | ILIKE en cliente, dirección, barrio, teléfono, notas |
| `desde` | date | Fecha mínima |
| `hasta` | date | Fecha máxima |
| `page` | int | Default: 1 |
| `limit` | int | Default: 50 |

**Respuesta 200:**
```json
{
  "data": [
    {
      "id": 1,
      "fecha": "2026-01-15",
      "cliente": "María González",
      "telefono": "11-1234-5678",
      "direccion": "Av. Corrientes 1234",
      "barrio": "Centro",
      "costo_envio": 1500,
      "total_cobrado": 8000,
      "horario": "14:00-16:00",
      "operador": "Repartidor A",
      "notas": "Tocar timbre 2B",
      "estado": "Pendiente",
      "prioridad": "Alta",
      "created_at": "...",
      "items": [
        { "id": 1, "tipo": "producto", "descripcion": "Remera talle M", "monto": 6500, "metodo_pago": null },
        { "id": 2, "tipo": "pago", "descripcion": null, "monto": 1500, "metodo_pago": "Efectivo" }
      ]
    }
  ],
  "pagination": { "total": 25, "page": 1, "limit": 50, "pages": 1 }
}
```

---

### `POST /api/envios`

Crea envío + ítems en una transacción.

**Body:**
```json
{
  "fecha": "2026-01-15",
  "cliente": "María González",
  "telefono": "11-1234-5678",
  "direccion": "Av. Corrientes 1234",
  "barrio": "Centro",
  "costo_envio": 1500,
  "total_cobrado": 8000,
  "horario": "14:00-16:00",
  "operador": "Repartidor A",
  "notas": "Tocar timbre 2B",
  "estado": "Pendiente",
  "prioridad": "Alta",
  "items": [
    { "tipo": "producto", "descripcion": "Remera talle M", "monto": 6500 },
    { "tipo": "pago", "monto": 1500, "metodo_pago": "Efectivo" }
  ]
}
```

| Campo | Requerido | Restricciones |
|-------|-----------|---------------|
| `fecha` | ✓ | date |
| `cliente` | ✓ | 1–200 chars |
| `direccion` | ✓ | 1–300 chars |
| `costo_envio` | ✓ | ≥ 0 |
| `total_cobrado` | ✓ | ≥ 0 |
| `estado` | ✓ | `Pendiente` · `En camino` · `Entregado` · `Cancelado` |
| `items` | ✓ | array (puede ser vacío `[]`) |
| `telefono` | — | ≤ 30 chars |
| `barrio` | — | ≤ 100 chars |
| `horario` | — | ≤ 100 chars |
| `operador` | — | ≤ 100 chars |
| `notas` | — | ≤ 1000 chars |
| `prioridad` | — | `Alta` · `Media` · `Baja` |

**Items:**

| Campo | Requerido | Restricciones |
|-------|-----------|---------------|
| `tipo` | ✓ | `producto` · `pago` |
| `monto` | ✓ | ≥ 0 |
| `descripcion` | — | ≤ 300 chars |
| `metodo_pago` | — | ≤ 100 chars |

**Respuesta 201:** objeto envío creado (sin ítems en el body de respuesta).

---

### `PUT /api/envios/:id`

Actualización parcial. Si se incluye `items`, **reemplaza** todos los ítems existentes.

**Body:** todos los campos de POST son opcionales + `items?` (si presente, reemplaza completo).

**Respuesta 200:** envío actualizado.

---

### `DELETE /api/envios/:id`

Soft-delete. **Respuesta 200:** `{ "ok": true }`

---

## Usuarios (`/api/usuarios`)

**Auth requerida** · **Solo admin**

### `GET /api/usuarios`

Lista todos los usuarios activos (máx 200).

**Respuesta 200:**
```json
[
  {
    "id": 1,
    "nombre": "Lucas Bruno",
    "username": "lucas",
    "email": "lucas@example.com",
    "role": "admin",
    "created_at": "...",
    "perms": { "cotizador": true, "financiera": true, "cajas": true, "envios": true, "usuarios": true }
  }
]
```

---

### `POST /api/usuarios`

Crea usuario + permisos en transacción.

**Body:**
```json
{
  "nombre": "Nombre Apellido",
  "username": "username_sin_espacios",
  "email": "user@example.com",
  "password": "minimo8chars",
  "role": "op",
  "perms": {
    "cotizador": false,
    "financiera": true,
    "cajas": false,
    "envios": true,
    "usuarios": false
  }
}
```

| Campo | Requerido | Restricciones |
|-------|-----------|---------------|
| `nombre` | ✓ | 1–100 chars |
| `username` | ✓ | 2–50 chars · solo `[a-z0-9_]` |
| `password` | ✓ | ≥ 8 chars |
| `role` | ✓ | `admin` · `op` |
| `perms` | ✓ | objeto con los 5 tools |
| `email` | — | formato email |

**Respuesta 201:** usuario con perms · **409** si username o email ya existe.

---

### `PUT /api/usuarios/:id`

Actualización parcial de usuario + permisos.

**Body:** todos los campos de POST son opcionales.  
Si se incluye `password`, se hashea automáticamente.  
Si se incluye `perms`, hace UPSERT de todos los tools incluidos.

**Respuesta 200:** usuario actualizado.

---

### `DELETE /api/usuarios/:id`

Soft-delete. No se puede eliminar el propio usuario.

**Respuesta 200:** `{ "ok": true }` · **400** si intenta auto-eliminarse · **404** si no existe

---

## Health Check

### `GET /health`

Sin autenticación.

**Respuesta 200** (DB conectada):
```json
{
  "status": "ok",
  "ts": "2026-01-15T10:30:00.000Z",
  "uptime": 3600,
  "version": "1.0.1",
  "db": {
    "status": "ok",
    "latency_ms": 2,
    "pool": { "total": 2, "idle": 2, "waiting": 0 }
  },
  "memory": { "rss_mb": 85, "heap_used_mb": 45, "heap_total_mb": 60 }
}
```

**Respuesta 503** (DB error):
```json
{
  "status": "degraded",
  "db": { "status": "error", "latency_ms": null, "pool": { ... } }
}
```

> `db.error` solo aparece en entornos non-production (evita filtrar detalles de conexión).

---

## Errores

Todos los errores siguen el mismo formato:

```json
{ "error": "Descripción del error" }
```

| Código | Significado |
|--------|-------------|
| `400` | Body o query inválido (validación Zod) |
| `401` | Sin autenticación o token inválido/expirado |
| `403` | Sin permiso para el módulo o acción |
| `404` | Recurso no encontrado |
| `409` | Conflicto (duplicado — username, vendedor, contacto) |
| `429` | Rate limit alcanzado |
| `500` | Error interno del servidor |
| `503` | Servicio no disponible (DB caída, API key faltante) |

---

## Paginación

Todos los endpoints de lista (excepto contactos y vendedores) devuelven:

```json
{
  "data": [...],
  "pagination": {
    "total": 150,
    "page": 2,
    "limit": 50,
    "pages": 3
  }
}
```

**Params estándar:**
- `page` — número de página (default: 1)
- `limit` — resultados por página (default y máx varía por endpoint)

| Endpoint | Default limit | Máx limit |
|----------|--------------|-----------|
| `/api/comprobantes` | 50 | 200 |
| `/api/pagos` | 100 | 200 |
| `/api/envios` | 50 | — |
| `/api/cajas/deudas` | 100 | — |
| `/api/cajas/inversiones` | 100 | — |
| `/api/historial` | 50 | 200 |
| `/api/usuarios` | 200 (fijo) | — |
| `/api/vendedores` | 500 (fijo) | — |
| `/api/contactos` | 500 (fijo) | — |
