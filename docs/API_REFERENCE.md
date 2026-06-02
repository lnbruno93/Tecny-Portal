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
- **Módulos transaccionales:** [Inventario](#inventario-apiinventario) · [Ventas](#ventas-apiventas) · [Cuentas CC](#cuentas-cc-apicuentas) · [Proveedores](#proveedores-apiproveedores)
- **Módulos financieros:** [Tarjetas](#tarjetas-apitarjetas) · [Egresos](#egresos-apiegresos) · [Cambios de divisa](#cambios-apicambios) · [Proyectos](#proyectos-apiproyectos)
- [Cajas: CRUD y movimientos](#cajas-crud-y-movimientos-apicajascajas)
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

## 2FA — TOTP (`/api/auth/2fa`)

Endpoints para gestionar el segundo factor (RFC 6238 TOTP) del usuario actual.
Todos requieren JWT válido (`requireAuth`) — son del flow "user gestiona su
propia 2FA". El gate de 2FA durante login vive en `/api/auth/login` (ver arriba).

**Rate limit dedicado:** 10 intentos / 15 min por `user.id` (no por IP).
`skipSuccessfulRequests:true` — solo los fallos cuentan.

### `GET /api/auth/2fa/status`

Estado del 2FA del usuario actual.

**Response 200:**
```json
{
  "configured": true,
  "enabled": true,
  "enabled_at": "2026-06-01T10:00:00Z",
  "last_used_at": "2026-06-02T22:00:00Z",
  "recovery_codes_remaining": 7
}
```

### `POST /api/auth/2fa/setup`

Inicia el flow: genera secret TOTP cifrado + 8 recovery codes hasheados.

Idempotente: si ya hay row pero NO `enabled_at`, lo reemplaza (re-setup).
Si ya está enabled, devuelve `409` — primero `disable`.

**Response 200:**
```json
{
  "secret": "ABCDEFGH12345678ABCD",     // base32, fallback si el QR falla
  "otpauth_uri": "otpauth://totp/...",   // para generar QR en el cliente
  "recovery_codes": ["XXXX-XXXX-XX", ...] // 8 codes, mostrar AL USER UNA SOLA VEZ
}
```

**Errores:** `409` 2FA ya activado (disable primero).

### `POST /api/auth/2fa/enable`

Confirma el setup con el primer código TOTP de la app autenticadora. Marca
`enabled_at = NOW()`. Desde acá el login va a exigir 2FA.

**Body:** `{ "code": "123456" }`

**Response 200:** `{ "ok": true, "enabled_at": "..." }`

**Errores:** `400` sin setup previo · `400` código incorrecto · `409` ya enabled.

### `POST /api/auth/2fa/disable`

Desactiva 2FA. Requiere código actual TOTP o un recovery code (defense vs
alguien que tomó la sesión sin el cel del legítimo).

**Body:** `{ "code": "123456" }` o `{ "code": "XXXX-XXXX-XX" }`

**Response 200:** `{ "ok": true }`

**Errores:** `400` 2FA no activado · `400` código incorrecto.

### `POST /api/auth/2fa/regenerate-recovery`

Genera 8 nuevos recovery codes e invalida los viejos. Mismo `code` requerido
que en `disable`.

**Body:** `{ "code": "123456" }` o `{ "code": "XXXX-XXXX-XX" }`

**Response 200:** `{ "recovery_codes": ["XXXX-XXXX-XX", ...] }` (8 codes plain
para mostrar UNA SOLA VEZ).

**Errores:** `400` 2FA no activado · `400` código incorrecto.

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

## Inventario (`/api/inventario`)

Gestión de productos, categorías, depósitos, métricas y desglose 360.

### Catálogos auxiliares

- `GET /api/inventario/categorias` — lista categorías administrables (orden alfabético).
- `POST /api/inventario/categorias` — body: `{ nombre }`. Requiere `permisos.inventario`.
- `DELETE /api/inventario/categorias/:id` — soft-delete. **409** si hay productos asociados.
- `GET /api/inventario/depositos` · `POST` · `DELETE /:id` — mismo patrón que categorías.

### Productos

- `GET /api/inventario/productos` — listado con filtros + paginación.
  - Query: `vista` (`no_vendidos` | `no_vendidos_ocultos` | `ocultos` | `vendidos` | `todos_visibles` | `todos_ocultos`), `clase`, `categoria_id`, `deposito_id`, `condicion`, `nombre`, `proveedor`, `gb`, `color`, `search`, `page`, `limit`.
  - Compat legacy: `solo_stock=true` → equivale a `vista=no_vendidos`.
  - **Respuesta 200:** `{ data: [...], pagination: {...} }`.
- `GET /api/inventario/productos/metricas` — KPIs del Dashboard (count, USD por categoría).
- `GET /api/inventario/productos/proveedores` — lista distinct de proveedores en stock.
- `GET /api/inventario/desglose` — vista 360 agregada por dimensión (nombre, proveedor, categoría, depósito).
- `GET /api/inventario/productos/:id/foto` — devuelve la imagen del producto (lazy load).
- `POST /api/inventario/productos` — crear producto. Validación cruzada: unitario debe tener cantidad=1.
- `PUT /api/inventario/productos/:id` — edición parcial. Tx con FOR UPDATE.
- `DELETE /api/inventario/productos/:id` — soft-delete. **409** si está vendido en una venta activa.
- `POST /api/inventario/productos/bulk` — import masivo (CSV/XLSX). Rate-limited.

---

## Ventas (`/api/ventas`)

Ventas + cobros + dashboard de KPIs.

- `GET /api/ventas/dashboard` — query: `desde`, `hasta` (ISO date). Devuelve totales, ticket promedio, top productos, top vendedores. Caché TTL 60s.
- `GET /api/ventas` — listado paginado con filtros (`cliente`, `etiqueta`, `estado`, `desde`, `hasta`, `search`). **Respuesta 200:** `{ data, pagination }`.
- `POST /api/ventas` — crear venta. Body: `{ items[], pagos[], tc_venta, ... }`. Cobra a `metodos_pago` (caja) + descuenta stock dentro de tx + audit.
- `PUT /api/ventas/:id` — edición parcial o full (con items). Recalcula stock + saldo CC.
- `DELETE /api/ventas/:id` — soft-delete + reposición de stock + reverso de movimientos de caja + reverso CC.

**Permisos:** todas las rutas requieren `permisos.ventas`. El dashboard puede requerir `permisos.dashboard`.

---

## Cuentas CC (`/api/cuentas`)

Clientes con cuenta corriente, movimientos (compra/pago/devolución/parte de pago/entrega), cobranza masiva y reportes.

### Clientes

- `GET /api/cuentas/clientes/search?q=texto` — autocomplete (top 10, por nombre/apellido).
- `GET /api/cuentas/clientes` — listado paginado con saldo calculado. Query: `categoria`, `search`, `page`, `limit`.
- `GET /api/cuentas/clientes/:id` — incluye `saldo` y `saldo_usd`.
- `POST /api/cuentas/clientes` — body: `{ nombre, apellido?, categoria (VIP|A+|A-), saldo_inicial?, ... }`.
- `PUT /api/cuentas/clientes/:id` — edición parcial.
- `DELETE /api/cuentas/clientes/:id` — soft-delete. **409** si tiene saldo distinto de 0.

### Movimientos

- `GET /api/cuentas/clientes/:id/movimientos` — paginado, orden `fecha DESC`.
- `POST /api/cuentas/movimientos` — body: `{ cliente_cc_id, fecha, tipo, monto_total, items?, caja_id?, ... }`. `tipo` en `compra|pago|devolucion|parte_de_pago|entrega_mercaderia`. Si trae `caja_id`, también postea ingreso/egreso en caja (cobranza inline).
- `DELETE /api/cuentas/movimientos/:id` — soft-delete con reverso de stock + caja + audit.

### Cobranza masiva

- `POST /api/cuentas/cobranzas-masivas` — N pagos en bloque (max 100/lote, rate-limit 10/15min). Body:
  ```json
  { "cobranzas": [{ "cliente_cc_id", "fecha", "monto", "moneda", "tc?", "caja_id", "tipo": "pago|parte_de_pago" }, ...] }
  ```
  Transaccional: si una fila falla, **ninguna** se aplica. Pre-validación con `FOR UPDATE ORDER BY id` sobre clientes y cajas (anti-deadlock #M-01).

### Reportes

- `GET /api/cuentas/clientes/:id/resumen` — saldo + breakdown por moneda + últimos N movs.
- `GET /api/cuentas/resumen-general` — totales globales por categoría.
- `GET /api/cuentas/calendario` — vencimientos / próximos pagos.

---

## Proveedores (`/api/proveedores`)

Compras + pagos a proveedores, paralelo al módulo Cuentas CC pero con orientación inversa (les debemos).

- `GET /api/proveedores` — listado **paginado** (#M-06, default 100, max 200). Query: `buscar`, `page`, `limit`. **Respuesta 200:** `{ data, pagination }`.
- `GET /api/proveedores/:id` — detalle con saldo.
- `POST /api/proveedores` — body: `{ nombre, contacto_nombre?, whatsapp?, ubicacion?, notas?, saldo_inicial? }`.
- `PUT /api/proveedores/:id` — edición parcial. Sincroniza contacto en agenda (best-effort).
- `DELETE /api/proveedores/:id` — soft-delete. **409** si hay movimientos.
- `GET /api/proveedores/:id/movimientos` — paginado.
- `POST /api/proveedores/movimientos` — body: `{ proveedor_id, fecha, tipo (compra|pago), monto, moneda, tc?, caja_id?, items? }`. Si `items[].producto_stock` viene, crea producto en Inventario (proveedor heredado, #M-02 requiere monto > 0). Rate-limited.
- `DELETE /api/proveedores/movimientos/:id` — soft-delete con reverso completo. Bulk `UNNEST` sobre productos para devolución (#M-05). ORDER BY id antes de FOR UPDATE (#B-3).
- `GET /api/proveedores/resumen/saldos` — total a pagar por proveedor (USD).

---

## Tarjetas (`/api/tarjetas`)

Tarjetas de crédito propias + movimientos (cobros pendientes de liquidación + liquidaciones).

- `GET /api/tarjetas` — lista de tarjetas activas con saldo a liquidar.
- `GET /api/tarjetas/movimientos` — listado global paginado de movimientos.
- `GET /api/tarjetas/:id` · `GET /:id/movimientos`.
- `POST /api/tarjetas/liquidaciones` — body: `{ tarjeta_id, fecha, monto, caja_id, notas? }`. Resta del saldo de la tarjeta y suma a caja.
- `DELETE /api/tarjetas/movimientos/:id` — soft-delete con reverso (no permitido si fue auto-creado por una venta — debe borrarse desde la venta).

---

## Egresos (`/api/egresos`)

Gastos: categorías + recurrentes (generación periódica) + movimientos.

### Catálogos

- `GET /api/egresos/categorias` · `POST` · `PUT /:id` · `DELETE /:id`.
- `GET /api/egresos/recurrentes` · `POST` · `PUT /:id` · `DELETE /:id` — definición de gastos recurrentes (alquiler, sueldos, servicios).
- `POST /api/egresos/generar` — body: `{ mes (YYYY-MM) }`. Genera egresos del mes para todos los recurrentes activos.

### Movimientos

- `GET /api/egresos` — listado paginado con filtros (`categoria_id`, `desde`, `hasta`, `search`).
- `POST /api/egresos` — body: `{ fecha, categoria_id, monto, moneda, tc?, caja_id, descripcion? }`. Egreso de caja inline.
- `PUT /api/egresos/:id` — edición parcial con reverso/repost de caja si cambia monto/caja.
- `DELETE /api/egresos/:id` — soft-delete con reverso.

---

## Cambios (`/api/cambios`)

Cambios de divisa: cuevas, brokers, contactos cripto.

### Entidades (catálogos de partidas)

- `GET /api/cambios/entidades` · `GET /:id` · `POST` · `PUT /:id` · `DELETE /:id`.
- Body POST: `{ nombre, tipo (cueva|broker|cripto|otro), notas? }`.

### Movimientos (operaciones)

- `GET /api/cambios/entidades/:id/movimientos` — paginado.
- `POST /api/cambios/movimientos` — body: `{ entidad_id, fecha, caja_origen_id, caja_destino_id, monto_origen, monto_destino, tc, notas? }`. Egreso de la caja origen + ingreso en la destino (TX atómica).
- `DELETE /api/cambios/movimientos/:id` — soft-delete con reverso de ambas cajas.

---

## Proyectos (`/api/proyectos`)

Tracking de proyectos con ingresos/egresos asignables.

- `GET /api/proyectos` — listado paginado con saldo neto + estado.
- `GET /api/proyectos/:id` · `POST` · `PUT /:id` · `DELETE /:id`.
- `GET /api/proyectos/:id/movimientos`.
- `POST /api/proyectos/movimientos` — body: `{ proyecto_id, fecha, tipo (ingreso|egreso), monto, caja_id, descripcion? }`.
- `DELETE /api/proyectos/movimientos/:id`.

---

## Cajas: CRUD y movimientos (`/api/cajas/cajas`)

> **No confundir con** `/api/cajas` (subruta legacy "deudas/inversiones" documentada arriba). Esta subruta `/cajas/cajas` es el CRUD nuevo de **métodos de pago** (efectivo, banco, USDT wallet, etc.).

### CRUD

- `GET /api/cajas/cajas` — lista todas las cajas activas + saldo actual (calculado on-the-fly).
- `GET /api/cajas/cajas/negativas` — cajas con saldo < 0 (alerta).
- `POST /api/cajas/cajas` — body: `{ nombre, moneda (USD|ARS|USDT), saldo_inicial? }`.
- `PUT /api/cajas/cajas/:id` — edición. No permite cambiar `moneda` si hay movimientos.
- `DELETE /api/cajas/cajas/:id` — soft-delete. **409** si saldo ≠ 0.

### Movimientos (ledger)

- `GET /api/cajas/movimientos` — ledger global paginado con filtros (`caja_id`, `tipo`, `origen`, `desde`, `hasta`).
- `GET /api/cajas/cajas/:id/movimientos` — ledger de UNA caja.
- `POST /api/cajas/cajas/:id/movimientos` — ajuste manual (`ajuste_suma` o `ajuste_resta`). Body: `{ fecha, tipo, monto, moneda, tc?, concepto? }`. Valida saldo no-negativo en `ajuste_resta` (#M-04).
- `DELETE /api/cajas/movimientos/:id` — soft-delete. Solo se permite si origen=`ajuste`. Otros (venta/b2b/proveedor/etc.) deben borrarse desde su tabla de origen.

### Resumen

- `GET /api/cajas/resumen` — totales por moneda + USD agregado.

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
