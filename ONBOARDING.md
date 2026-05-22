# iPro Portal — Guía de Onboarding

> Guía técnica para desarrolladores. Cubre arquitectura, setup local, estructura del proyecto y decisiones de diseño clave.

---

## Índice

1. [¿Qué es iPro Portal?](#qué-es-ipro-portal)
2. [Stack tecnológico](#stack-tecnológico)
3. [Arquitectura](#arquitectura)
4. [Setup local](#setup-local)
5. [Variables de entorno](#variables-de-entorno)
6. [Estructura del proyecto](#estructura-del-proyecto)
7. [Sistema de autenticación y permisos](#sistema-de-autenticación-y-permisos)
8. [Módulos de negocio](#módulos-de-negocio)
9. [Base de datos](#base-de-datos)
10. [Testing](#testing)
11. [Deploy](#deploy)
12. [Decisiones de diseño](#decisiones-de-diseño)

---

## ¿Qué es iPro Portal?

Portal de administración interna para gestionar:

| Módulo | Descripción |
|--------|-------------|
| **Financiera** | Comprobantes de ventas, pagos a proveedores, comisiones, adjuntos de facturas |
| **Cajas** | Registro de deudas e inversiones por contacto (ARS y USD) |
| **Envíos** | Gestión de órdenes de delivery con ítems, estados y seguimiento |
| **Usuarios** | Administración de cuentas con permisos granulares por módulo |

El portal es **multi-usuario** con control de acceso por módulo. El frontend es una SPA de archivo único (`Index.html`) servida desde Netlify, conectada a un backend API REST en Railway.

---

## Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| Frontend | HTML/CSS/JS vanilla · SPA de un archivo (`Index.html`) |
| Backend | Node.js 20+ · Express 4 |
| Base de datos | PostgreSQL (Railway managed) |
| Auth | JWT HS256 · bcrypt |
| Validación | Zod v4 |
| Logging | Pino + pino-http |
| Errores | Sentry (`@sentry/node`) |
| Migrations | node-pg-migrate |
| Tests | Jest 30 + Supertest |
| Deploy frontend | Netlify (GitHub auto-deploy) |
| Deploy backend | Railway (GitHub auto-deploy desde rama `main`) |

---

## Arquitectura

```
┌─────────────────────────────┐
│       Netlify (Frontend)     │
│   SPA: Index.html           │
│   Vanilla JS + Tailwind     │
└──────────┬──────────────────┘
           │ HTTPS / REST API
           │ Authorization: Bearer <JWT>
┌──────────▼──────────────────┐
│       Railway (Backend)      │
│   Node.js + Express          │
│   PORT: auto-assigned        │
│   ┌─────────────────────┐   │
│   │   Middleware stack   │   │
│   │  compression → helmet│   │
│   │  cors → rateLimit    │   │
│   │  json → pinoHttp     │   │
│   └─────────┬───────────┘   │
│             │                │
│   ┌─────────▼───────────┐   │
│   │   Route handlers     │   │
│   │  requireAuth         │   │
│   │  requirePermission   │   │
│   └─────────┬───────────┘   │
└─────────────┼───────────────┘
              │ pg Pool (internal Railway network)
┌─────────────▼───────────────┐
│   PostgreSQL (Railway DB)    │
│   ipro_portal (prod)         │
│   ipro_test (tests)          │
└─────────────────────────────┘
```

### Flujo de un request autenticado

```
Request → compression → helmet (CSP/headers)
       → cors (allowlist) → rateLimit (300/15min)
       → express.json (10mb) → pinoHttp (log)
       → requireAuth (JWT verify + password_changed_at)
       → requirePermission (tool check)
       → route handler → db.query() → res.json()
```

---

## Setup local

### Requisitos

- Node.js ≥ 20
- PostgreSQL ≥ 14 corriendo localmente
- `npm`

### Paso a paso

```bash
# 1. Clonar el repo
git clone https://github.com/lnbruno93/iPro-Portal.git
cd iPro-Portal/backend

# 2. Instalar dependencias
npm install

# 3. Crear base de datos local
psql -U postgres -c "CREATE DATABASE ipro_portal;"
psql -U postgres -c "CREATE DATABASE ipro_test;"

# 4. Crear archivo de entorno de desarrollo
cp .env.example .env
# Editar .env con tu DATABASE_URL y JWT_SECRET (ver sección Variables de entorno)

# 5. Crear archivo de entorno de tests
cp .env.example .env.test
# Editar .env.test: DATABASE_URL debe apuntar a ipro_test

# 6. Correr migraciones
npm run migrate

# 7. Iniciar servidor en modo desarrollo
npm run dev
# → http://localhost:3001
```

> **Frontend:** Abrí `Index.html` directamente en el browser o con Live Server. Ya apunta a `http://localhost:3001` en desarrollo.

---

## Variables de entorno

### Obligatorias

| Variable | Descripción | Ejemplo |
|----------|-------------|---------|
| `DATABASE_URL` | Conexión a PostgreSQL | `postgresql://user:pass@host:5432/ipro_portal` |
| `JWT_SECRET` | Clave para firmar JWTs (mínimo 32 chars random) | `openssl rand -hex 32` |

### Opcionales

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3001` | Puerto del servidor |
| `NODE_ENV` | — | `production` desactiva ciertas info en logs/errores |
| `JWT_EXPIRES_IN` | `7d` | Expiración del token (formato ms/zeit) |
| `CORS_ORIGIN` | `http://localhost:3000,http://localhost:5500` | Orígenes permitidos (separados por coma) |
| `ANTHROPIC_API_KEY` | — | Para el endpoint de OCR (Haiku 4.5) |
| `SENTRY_DSN` | — | URL de Sentry para error tracking |
| `DB_POOL_MAX` | `10` | Máximo de conexiones en el pool |
| `DB_CONN_TIMEOUT` | `5000` | Timeout de conexión en ms |
| `DB_IDLE_TIMEOUT` | `30000` | Timeout de conexiones ociosas en ms |

> ⚠️ **Nunca** commitees `.env` ni `.env.test`. El `.gitignore` y `.railwayignore` ya los excluyen.

---

## Estructura del proyecto

```
iPro-Portal/
├── Index.html                    # Frontend SPA (Netlify)
├── ONBOARDING.md                 # Este archivo
├── docs/
│   └── API_REFERENCE.md          # Referencia completa de endpoints
└── backend/
    ├── server.js                 # Entry point: dotenv → Sentry init → app.listen
    ├── jest.config.js            # Config de tests
    ├── railway.json              # Config de deploy (Nixpacks, start command, health check)
    ├── .env.example              # Template de variables de entorno
    ├── .railwayignore            # Excluye .env, tests, logs del upload a Railway
    ├── migrations/               # node-pg-migrate: una por cambio de schema
    │   ├── 20260521000001_initial-schema.js
    │   ├── 20260521000002_soft-delete-comprobantes-pagos.js
    │   ├── 20260521000003_users-password-changed-at.js
    │   ├── 20260521000004_cajas-indexes.js
    │   ├── 20260521000005_soft-delete-cajas-vendedores.js
    │   ├── 20260522000006_constraints-y-limpieza.js
    │   └── 20260522000007_gin-indexes-ilike.js
    └── src/
        ├── app.js                # Express app: middleware + rutas + error handler
        ├── config/
        │   └── database.js       # pg.Pool singleton con configuración de timeouts
        ├── lib/
        │   ├── audit.js          # Escribe a audit_logs; falla silencioso + Sentry
        │   ├── logger.js         # Instancia Pino (structured JSON logging)
        │   ├── paginate.js       # parsePagination() + paginatedResponse()
        │   ├── parseId.js        # parseInt con validación (evita NaN/injection)
        │   └── validate.js       # Middleware wrapper para schemas Zod
        ├── middleware/
        │   ├── auth.js           # JWT verify (HS256) + password_changed_at check
        │   ├── requirePermission.js # Verifica tool en user_permissions (admin bypass)
        │   └── adminOnly.js      # role === 'admin' guard
        ├── routes/
        │   ├── auth.js           # login, me, logout, change-password
        │   ├── comprobantes.js   # CRUD + totales + archivo adjunto
        │   ├── pagos.js          # CRUD + totales
        │   ├── vendedores.js     # CRUD (soft-delete) + buscar filter
        │   ├── contactos.js      # CRUD (soft-delete) + buscar filter
        │   ├── cajas.js          # deudas CRUD + inversiones CRUD + resumen agregado
        │   ├── usuarios.js       # CRUD admin + permisos por tool (transaccional)
        │   ├── config.js         # Singleton config (pct_financiera)
        │   ├── historial.js      # Lectura paginada de audit_logs
        │   ├── ocr.js            # Claude Haiku: extrae monto de imagen de comprobante
        │   └── envios.js         # CRUD delivery con envio_items (transaccional)
        └── schemas/              # Zod schemas para validación de input
            ├── auth.js
            ├── cajas.js
            ├── comprobantes.js
            ├── contactos.js
            ├── envios.js
            ├── ocr.js
            ├── pagos.js
            ├── usuarios.js
            └── vendedores.js
```

---

## Sistema de autenticación y permisos

### JWT

- **Algoritmo:** HS256 explícito (previene algorithm confusion attacks)
- **Payload:** `{ id, username, email, role, iat_ms }`
  - `iat_ms`: timestamp de emisión en milisegundos (precisión sub-segundo vs `iat` estándar que es en segundos)
- **Expiración:** `JWT_EXPIRES_IN` (default `7d`)

### Invalidación de sesión

```
token.iat_ms  <  user.password_changed_at  →  401 "Sesión expirada"
```

Esto significa que al cambiar contraseña (o al hacer logout) **todos** los tokens del usuario quedan inválidos automáticamente, sin necesidad de blocklist ni Redis.

### Flujo de login

```
POST /api/auth/login
  → bcrypt.compare(password, hash ?? DUMMY_HASH)   # siempre corre para evitar timing attack
  → si válido: makeToken(user) + perms query
  → responde { token, user: { ...campos, perms } }
```

### Permisos por módulo

```
roles: 'admin' | 'op'

admin → bypass de todos los permisos
op    → necesita row en user_permissions con tool=X AND enabled=true

tools: cotizador | financiera | cajas | envios | usuarios
```

### Rate limits

| Endpoint | Límite |
|----------|--------|
| Global (todas las rutas) | 300 req / 15 min por IP |
| `POST /api/auth/login` | 10 fallos / 15 min por IP (solo requests fallidos) |
| `POST /api/ocr` | 10 llamadas / 1 hora por user_id |

---

## Módulos de negocio

### Financiera (`/api/comprobantes`, `/api/pagos`, `/api/vendedores`)

Registra operaciones de la financiera:
- **Comprobantes:** facturas/recibos con monto bruto, comisión de financiera, neto, vendedor y archivo adjunto (base64 en DB, máx 7MB)
- **Pagos:** pagos a proveedores/otros
- **Config:** porcentaje de comisión de la financiera
- **OCR:** extrae el monto de una imagen con Claude Haiku (útil para carga rápida desde celular)

### Cajas (`/api/contactos`, `/api/cajas`)

Registra deudas e inversiones de contactos:
- **Deudas:** saldos en ARS y USD por contacto (tipo `debe` o `pago`)
- **Inversiones:** montos invertidos con tasa de interés
- **Resumen:** agregados por contacto con última tasa y saldo neto

### Envíos (`/api/envios`)

Gestión de deliveries:
- Envío tiene `n` ítems (productos o pagos)
- Estados: `Pendiente → En camino → Entregado | Cancelado`
- Búsqueda ILIKE sobre cliente, dirección, barrio, teléfono, notas (acelerado con GIN index)

### Usuarios (`/api/usuarios`)

Solo admins pueden gestionar usuarios:
- CRUD completo con permisos granulares por módulo
- Creación transaccional: INSERT user + INSERT permissions en una sola transacción
- Audit log captura antes/después sin exponer `password_hash`

---

## Base de datos

### Decisiones de diseño

| Decisión | Motivo |
|----------|--------|
| **Soft deletes** en todas las tablas | `deleted_at IS NULL` filtra borrados sin perder historial |
| **audit_logs** centralizado | Una sola tabla para toda la trazabilidad; no se escribe en historial |
| **JSONB** en audit_logs | Flexible para capturar cualquier estructura sin schema fijo |
| **UNIQUE parciales** (`WHERE deleted_at IS NULL`) | Permite "reusar" nombres de contactos/vendedores borrados |
| **GIN trigram indexes** | Búsquedas ILIKE eficientes sin cambiar la query logic |
| **Archivos en DB** | base64 en columna TEXT — simple, sin dependencia de S3/storage externo |

### Migraciones

Las migraciones usan `node-pg-migrate` y se corren automáticamente al deployar:

```bash
# Crear una nueva migración
npm run migrate:create -- nombre-descriptivo

# Aplicar migraciones pendientes
npm run migrate

# Revertir la última migración
npm run migrate:down
```

> Las migraciones son **idempotentes** (usan `IF NOT EXISTS`, `IF EXISTS`). Se pueden correr múltiples veces sin problema.

---

## Testing

### Setup

```bash
# Requiere ipro_test DB creada y .env.test configurado
npm test
```

### Organización

```
tests/
├── helpers/
│   ├── setEnv.js           # Carga .env.test antes de todos los tests
│   ├── setup.js            # setupTestDb() / teardownTestDb()
│   └── globalTeardown.js   # Cierra el pool singleton de pg al finalizar Jest
├── auth.test.js            # Login, /me, rutas protegidas
├── cajas.test.js           # Deudas, inversiones, resumen
├── crud.test.js            # Usuarios, config, contactos, vendedores, permisos
├── envios.test.js          # CRUD envíos + items, filtros, paginación
├── financiera.test.js      # Comprobantes, pagos, totales, health, JWT invalidation
└── historial.test.js       # Historial paginado, logout, archivos, buscar filters
```

### Filosofía de tests

- `setupTestDb()` hace TRUNCATE + RESTART IDENTITY al inicio de cada suite
- `teardownTestDb()` hace TRUNCATE + `pool.end()` al finalizar
- `--runInBand` garantiza ejecución secuencial (sin concurrencia entre suites)
- Los tests de integración usan la DB real (`ipro_test`) — no mocks

---

## Deploy

### Infraestructura

```
GitHub (main branch)
    ↓ push → trigger
Railway (backend auto-deploy)
    start: npm run migrate && node server.js
    health: GET /health (timeout 60s)

GitHub (main branch)
    ↓ push → trigger
Netlify (frontend auto-deploy)
    serve: Index.html (static)
```

### Comando de inicio en Railway

```bash
npm run migrate && node server.js
```

Esto garantiza que las migraciones pendientes se aplican **antes** de que el servidor arranque. La migración es idempotente.

### Health check

```
GET /health
→ {
    status: "ok" | "degraded",
    ts: ISO timestamp,
    uptime: segundos,
    version: "1.0.1",
    db: { status, latency_ms, pool: { total, idle, waiting } },
    memory: { rss_mb, heap_used_mb, heap_total_mb }
  }
```

---

## Decisiones de diseño

### Seguridad

| Decisión | Detalle |
|----------|---------|
| **Timing attack en login** | `bcrypt.compare` siempre corre con `DUMMY_HASH` si el usuario no existe |
| **JWT algorithm pinning** | `{ algorithms: ['HS256'] }` en verify() previene algorithm confusion (none, RS256) |
| **iat_ms en payload** | Timestamp en ms para invalidación sub-segundo; `iat` estándar solo tiene precisión de segundos |
| **CSP explícito** | `defaultSrc: 'none'` — API server, no sirve HTML propio |
| **password_hash fuera de audit** | Los PUT/DELETE de usuarios excluyen `password_hash` del JSON auditado |

### Arquitectura

| Decisión | Detalle |
|----------|---------|
| **SPA en un archivo** | `Index.html` contiene todo el frontend. Apropiado para el tamaño actual; fácil de deployar en Netlify sin build step |
| **Singleton pool** | `src/config/database.js` exporta un pool compartido entre todas las rutas. Evita abrir conexiones por request |
| **Schemas Zod separados** | Cada módulo tiene su schema en `src/schemas/`. Separación clara entre validación y lógica |
| **Paginación estándar** | `parsePagination` + `paginatedResponse` en `lib/paginate.js` — todos los endpoints de lista usan el mismo formato `{ data, pagination }` |
| **Audit silencioso** | `audit()` nunca lanza error — si falla el log, el request sigue adelante. Los errores van a Sentry |
| **Transacciones explícitas** | Operaciones multi-tabla (usuarios+permisos, envios+items) usan `client.query('BEGIN/COMMIT/ROLLBACK')` |
