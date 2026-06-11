# GRAN Auditoría — 2026-06-10

**Lente**: Infraestructura, velocidad, escalabilidad, detalles. Plazo 12+ meses para
"producto vendible a cientos de empresas".

**Metodología**: 6 agentes en paralelo, cada uno con instrucciones de hiper-puntillez,
file:line por finding, código de muestra en cada fix, priorización BLOCKER/HIGH/MEDIUM/LOW.

**Total**: 198 findings (20 BLOCKER, 72 HIGH, 71 MEDIUM, 39 LOW)

---

## Índice

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Métricas globales](#2-métricas-globales)
3. [Top 10 hiper-prioritarios (cruzados)](#3-top-10-hiper-prioritarios-cruzados)
4. [Findings por eje](#4-findings-por-eje)
   - [4.1 Seguridad](#41-seguridad-28-findings)
   - [4.2 Tests & Cobertura](#42-tests--cobertura-25-findings)
   - [4.3 Solidez & Correctness](#43-solidez--correctness-34-findings)
   - [4.4 Performance & Escalabilidad](#44-performance--escalabilidad-34-findings)
   - [4.5 UX & Frontend Quality](#45-ux--frontend-quality-54-findings)
   - [4.6 Repo Hygiene & DX](#46-repo-hygiene--dx-23-findings)
5. [Tandas propuestas](#5-tandas-propuestas)
6. [Roadmap por trimestre](#6-roadmap-por-trimestre)

---

## 1. Resumen ejecutivo

**Estado del portal**: muy por encima del promedio de una app SaaS construida por una
sola persona. Backend con 2FA, lockout per-user, audit log con PII redaction, helmet,
CSP estricto, rate limiting por Postgres store, validación Zod en todas las rutas,
race conditions cubiertas en tests, advisory locks, invariantes nocturnas, documentación
operativa. Frontend con design system propio, dark mode estable, accessible focus-visible,
PWA configurada, command palette. Cero TODO/FIXME, cero console.log en código.

**Lo que falta para vender a empresas**:

- 🔴 **20 BLOCKERs**: 5 bugs activos (orphan-movs commit silencioso, JWT 7 días en
  localStorage, audit post-commit en 25 endpoints, dashboard CC con cifras erróneas,
  GET /api/ventas que explota a 10× datos, foto_data en columna TEXT, caches in-memory
  con multi-réplica, modales spreadsheet inusables en mobile, i18n inexistente, 3 screens
  críticas sin tests).
- 🟠 **72 HIGHs**: gaps sistémicos (auth/perms sin caché → probable culpable del
  incidente Railway de hoy; audit log sin IP/UA; archivos monstruo de 1000-1700 líneas;
  duplicación crónica de Badge/Status; cero focus trap real; etc.).

**Probable causa del incidente Railway de hoy**: auth middleware hace 3 queries DB por
request sin caché → cuando GET /api/ventas bloquea una conexión 8s → pool agotado →
todos los requests timeoutean. Fix en P-02.

**Diferencial actual de iPro vs competidores SaaS**: ⌘K + 360 & Capital + Cambios divisa
+ Tarjetas con liquidaciones. Funcionalidades especializadas que Tiendanube/Holded/Zoho
no tienen.

**Convergencias críticas** (findings que aparecen en múltiples lentes):

1. **Cero `tenant_id`** → flagged por 4/6 lentes. Gap arquitectural #1 para SaaS.
2. **Audit log gaps** → flagged por 3/6 lentes. Patrón sistémico.
3. **Auth sin caché** → flagged por 2/6 lentes. Probable causa incidente Railway.
4. **Modales en mobile + a11y** → 4 findings UX convergentes.

---

## 2. Métricas globales

| Eje | Findings | BLOCKER | HIGH | MEDIUM | LOW |
|---|---|---|---|---|---|
| Seguridad | 28 | 2 | 9 | 11 | 6 |
| Tests | 25 | 5 | 11 | 9 | 4 |
| Solidez | 34 | 5 | 14 | 9 | 6 |
| Performance | 34 | 4 | 14 | 11 | 5 |
| UX | 54 | 4 | 18 | 21 | 11 |
| Hygiene | 23 | 0 | 6 | 10 | 7 |
| **TOTAL** | **198** | **20** | **72** | **71** | **39** |

**Distribución por nivel**:
- BLOCKER: 10% (20 findings) → fixear en próximas 4 semanas
- HIGH: 36% (72 findings) → próximos 3 meses
- MEDIUM: 36% (71 findings) → próximos 6 meses
- LOW: 20% (39 findings) → backlog continuo

---

## 3. Top 10 hiper-prioritarios (cruzados)

Los findings que aparecen en **2+ lentes** son hiper-prioritarios:

| # | Tema | Lentes que lo flagean | IDs |
|---|---|---|---|
| 1 | **Cero `tenant_id` en tablas** | Seguridad, Solidez, Performance, UX (i18n) | SE-02, S-24, P-17, U-01 |
| 2 | **Auth/Perms sin caché** (probable causa incidente Railway) | Performance, Solidez | P-02, S-14 |
| 3 | **Audit log gaps** (sin IP/UA, post-commit, sin partición) | Seguridad, Solidez, Performance | SE-05, S-05, S-21, P-07, P-19 |
| 4 | **JWT en localStorage 7 días** | Seguridad | SE-01 |
| 5 | **GET /api/ventas explota a escala** | Performance + assertion fake-green Tests | P-01, T-09 |
| 6 | **Caches in-memory + 2 réplicas** | Performance | P-04 |
| 7 | **foto_data/archivo_data en columna TEXT base64** | Performance | P-03 |
| 8 | **Modales mobile inusables + a11y** | UX (4 convergentes) | U-02, U-06, U-08, U-15 |
| 9 | **i18n inexistente** | UX | U-01 |
| 10 | **3 screens críticas sin tests** | Tests + Solidez (bugs históricos) | T-01, T-02, T-03 |

---

## 4. Findings por eje

### 4.1 Seguridad (28 findings)

**Estado**: backend muy por encima del promedio. 2FA con anti-replay, lockout per-user,
audit log con redacción PII, helmet, CSP, rate limiting compartido vía Postgres.

**Top findings**:

| ID | Sev | Título | Archivo |
|---|---|---|---|
| SE-01 | 🔴 | JWT de 7 días en `localStorage`, sin refresh, sin rotación | `frontend/src/lib/api.js:4-14`, `backend/src/routes/auth.js:36` |
| SE-02 | 🔴 | Cero `tenant_id`/`org_id` en CUALQUIER tabla → no hay data isolation | TODAS las tablas |
| SE-03 | 🟠 | SQL injection latente con `LOCKOUT_DURATION_MIN` en `INTERVAL` | `backend/src/routes/auth.js:78,138` |
| SE-04 | 🟠 | `POST /admin/restore-producto` sin ownership check (futuro multi-tenant) | `backend/src/routes/admin.js:253-304` |
| SE-05 | 🟠 | `audit_logs` no captura IP, User-Agent, ni request_id | `backend/src/lib/audit.js:97-102` |
| SE-06 | 🟠 | Audit log no redacta `dni`, `fecha_nacimiento`, `apellido` | `backend/src/lib/audit.js:34-37` |
| SE-07 | 🟠 | `POST /api/auth/change-password` sin rate limit dedicado, sin re-verificación 2FA | `backend/src/routes/auth.js:214-239` |
| SE-08 | 🟠 | `PUT /api/usuarios/:id` permite admin reset password sin re-auth + cambio de role sin gate | `backend/src/routes/usuarios.js:76-148` |
| SE-09 | 🟠 | Comprobante `archivo_data` no valida que la imagen REAL coincida con `archivo_tipo` declarado | `backend/src/schemas/comprobantes.js:44-46` |
| SE-10 | 🟠 | `/api/comprobantes/export-zip` sin paginación + sin tamaño máximo total | `backend/src/routes/comprobantes.js:392-490` |
| SE-11 | 🟠 | `/api/historial?q=` corre `ILIKE` sobre `JSONB::text` de toda `audit_logs` | `backend/src/routes/historial.js:96-104` |
| SE-12 | 🟡 | JWT_SECRET en `.env` local débil + sin política de rotación | `backend/.env:4` |
| SE-13 | 🟡 | Setup 2FA: `enable` no audita IP ni invalida sesiones viejas | `backend/src/routes/twoFa.js:205-221` |
| SE-14 | 🟡 | `POST /api/auth/2fa/setup` reemplaza secret existente no-enabled → race idempotency | `backend/src/routes/twoFa.js:156-202` |
| SE-15 | 🟡 | `/api/contactos` GET visible para CUALQUIER user logueado | `backend/src/app.js:368` |
| SE-16 | 🟡 | `buscar` ILIKE con `%${input}%` permite wildcards SQL | múltiples |
| SE-17 | 🟡 | `req.query` paginación arbitraria en algunos endpoints | `backend/src/schemas/comprobantes.js:63` |
| SE-18 | 🟡 | `server.js:18` no enforce minimum entropy de JWT_SECRET (solo longitud) | `backend/server.js:8-30` |
| SE-19 | 🟡 | `requireAuth` hace 1 query DB por request (no usa cache) | `backend/src/middleware/auth.js:20-38` |
| SE-20 | 🟡 | `express.json({ limit: '10mb' })` global — atacante puede subir 10MB JSON spam | `backend/src/app.js:126` |
| SE-21 | 🟡 | `archivo_nombre` (filename) hasta 255 chars no sanitiza path traversal | `backend/src/schemas/comprobantes.js:45` |
| SE-22 | ⚪ | Mensaje de error de login distinguible entre lockout (423) y bad credentials (401) | `backend/src/routes/auth.js:62-67` |
| SE-23 | ⚪ | Política de password: solo 8 chars + 1 letra + 1 número | `backend/src/lib/password.js:6-12` |
| SE-24 | ⚪ | CSP del frontend permite `'unsafe-inline'` en `style-src` | `netlify.toml:41` |
| SE-25 | ⚪ | `/health` expone `db.pool.total/idle/waiting` sin auth | `backend/src/app.js:262-273` |
| SE-26 | ⚪ | `tools.js` permission keys no validados estrictamente | `backend/src/routes/usuarios.js:53-56` |
| SE-27 | ⚪ | Sin `npm audit` automatizado en CI / sin alerta sobre CVEs | N/A |
| SE-28 | ⚪ | No hay verificación de que `helmet` HSTS preload esté activo | `backend/src/app.js:65-79` |

**Bonus — Multi-tenant SaaS** (8 ítems):
- MT-01: RBAC granular por tenant
- MT-02: Audit trail particionado por tenant
- MT-03: Data isolation testing automatizado
- MT-04: Secrets management por tenant (BYOK)
- MT-05: Rate limit por tenant (no solo por IP/user)
- MT-06: API keys per-tenant + HMAC para webhooks
- MT-07: Backup encryption + per-tenant export (GDPR)
- MT-08: Soft-delete + tenant cascade gap

---

### 4.2 Tests & Cobertura (25 findings)

**Estado**: backend muy sólido (783 tests, race conditions, advisory locks, invariants).
Frontend asimétrico: 3 screens críticas sin tests (las mismas donde nacieron los bugs
históricos).

| ID | Sev | Título | Archivo |
|---|---|---|---|
| T-01 | 🔴 | Envíos screen sin un solo test frontend | `frontend/src/screens/Envios.jsx` (1185 LOC) |
| T-02 | 🔴 | Inventario screen sin tests — modal Nuevo Producto, EditableCell, import XLSX | `frontend/src/screens/Inventario.jsx` (1116 LOC) |
| T-03 | 🔴 | Cajas screen sin tests — registro de movimiento, transferencias, conciliación | `frontend/src/screens/Cajas.jsx` (1089 LOC) |
| T-04 | 🔴 | No hay E2E suite (Playwright/Cypress) — venta crítica end-to-end no testeada | N/A |
| T-05 | 🔴 | Migraciones sin tests up/down — 70 migraciones sin chequeo de idempotencia | `backend/migrations/` (70 archivos) |
| T-06 | 🟠 | Schemas `.strict()` solo testeados en cuentas — 20 schemas sin guarda | `backend/tests/cuentas.test.js:1445-1484` |
| T-07 | 🟠 | Conciliación frontend sin test — auto-match preview puede mostrar datos rotos | `frontend/src/screens/Conciliacion.jsx` (530 LOC) |
| T-08 | 🟠 | Load test no corre en CI — baseline #105 silenciosamente puede degradarse | `.github/workflows/ci.yml`, `backend/loadtest/run.js` |
| T-09 | 🟠 | `tests/ventas.test.js` describe "B2B pendiente" tiene aserción frágil (fake-green) | `backend/tests/ventas.test.js:629-635` |
| T-10 | 🟠 | `crud.test.js` — assertions de smoke test sin verificar mutación | `backend/tests/crud.test.js` (458 LOC) |
| T-11 | 🟠 | Fuzzing / SQL injection / XSS probes — cero tests de seguridad ofensiva | N/A |
| T-12 | 🟠 | No hay test de zero-state / 10k-element en frontend | N/A |
| T-13 | 🟡 | Coverage threshold en branches=65% es bajo para un proyecto en producción | `backend/jest.config.js:36-43` |
| T-14 | 🟡 | Tests no aíslan `pool` entre describe blocks → bleeding silencioso | `backend/tests/helpers/setup.js:25-92` |
| T-15 | 🟡 | Comprobantes manuales — sin tests de concurrencia | `backend/tests/comprobantes-manuales.test.js` |
| T-16 | 🟡 | No hay test del `permisos-modulos` para operaciones de escritura | `backend/tests/permisos-modulos.test.js` |
| T-17 | 🟡 | No hay test del rate-limit (express-rate-limit) — política puede romperse | N/A |
| T-18 | 🟡 | `VentaB2BModal` y `CobranzaMasivaModal` tests son fake-green parciales | `frontend/src/components/VentaB2BModal.test.jsx` |
| T-19 | 🟡 | Backfill / admin tests sin chequeo de invariants post-backfill | múltiples |
| T-20 | 🟡 | Tests pre-crean cajas en setup() — fixture compartido inflado, lento | `backend/tests/helpers/setup.js:56-75` |
| T-21 | ⚪ | `tools-sync.test.js` es solo 17 LOC — probablemente sub-testeado | `backend/tests/tools-sync.test.js` |
| T-22 | ⚪ | Tests con `if (...) return` que skippean condicionalmente | `backend/tests/dashboard.test.js:112` |
| T-23 | ⚪ | No hay test que importe la API real (no mockeada) desde el frontend | N/A |
| T-24 | ⚪ | Tests de auth-lockout no verifican que el lockout NO afecte otros usuarios | `backend/tests/auth-lockout.test.js` |
| T-25 | ⚪ | Tests no verifican Helmet/CSP del backend | N/A |

**Bonus — Roadmap E2E Playwright (4 sprints)**:
- Sprint 1: infra + login spec
- Sprint 2: 4 flows críticos (venta retail, B2B, envío→entrega, conciliación)
- Sprint 3: 4 flows secundarios (compra IMEI, cobranza masiva, permisos, dashboard)
- Sprint 4: estabilización + helpers reutilizables

**Bonus — Tests obsoletos/redundantes** (candidatos a borrar):
- `crud.test.js` (458 LOC) probablemente superpuesto
- `financiera-*.test.js` (3 archivos, 848 LOC totales) — consolidar
- `tarjetas-*.test.js` (3 archivos, 1135 LOC totales) — consolidar

---

### 4.3 Solidez & Correctness (34 findings)

**Estado**: TX disciplinadas en módulos principales (ventas/cuentas/proveedores), pero
patrón roto en módulos secundarios. Bug ACTIVO en cleanup admin.

| ID | Sev | Título | Archivo |
|---|---|---|---|
| S-01 | 🔴 | `orphan-movs/apply` commitea estado inconsistente cuando un cancel falla | `backend/src/routes/admin.js:359-405` |
| S-02 | 🔴 | DELETE /usuarios no revoca el JWT del usuario eliminado | `backend/src/routes/usuarios.js:150-169` |
| S-03 | 🔴 | Inconsistencia en saldo CC entre dashboard y módulo | `backend/src/lib/dashboardMensual.js:182-198` |
| S-04 | 🔴 | POST /productos/bulk: audit post-commit + FK pre-tx | `backend/src/routes/inventario.js:584-686` |
| S-05 | 🔴 | Audits post-commit con pool global (~25 endpoints) | múltiples |
| S-06 | 🟠 | DELETE /proveedores/:id no valida movimientos activos | `backend/src/routes/proveedores.js:240-251` |
| S-07 | 🟠 | Schemas de sub-objetos sin `.strict()` permiten field smuggling | `backend/src/schemas/ventas.js`, `envios.js` |
| S-08 | 🟠 | Sin hard cap en valores numéricos de ventas | múltiples schemas |
| S-09 | 🟠 | Mensaje genérico de auth permite enumerar usuarios borrados | `backend/src/middleware/auth.js:21-25` |
| S-10 | 🟠 | POST /generar (egresos recurrentes) sin transacción + N round-trips | `backend/src/routes/egresos.js:148-170` |
| S-11 | 🟠 | PUT /usados/:id race condition + UPDATE inválido si body vacío | `backend/src/routes/usados.js:101-133` |
| S-12 | 🟠 | POST /garantias y PUT /garantias commits ANTES del audit | `backend/src/routes/ventas-extra.js:77-94, 96-119` |
| S-13 | 🟠 | `historial.js` VALID_TABLAS desincronizada | `backend/src/routes/historial.js:29-48` |
| S-14 | 🟠 | `requirePermission` hace una query DB por request | `backend/src/middleware/requirePermission.js:18-21` |
| S-15 | 🟠 | `cancelMovimientoCC` no chequea liquidaciones de tarjeta antes de revertir caja | `backend/src/lib/cancelMovimientoCC.js:58` |
| S-16 | 🟠 | `reverseCajaMovimientos` N round-trips para lockear cajas | `backend/src/lib/cajaLedger.js:90-137` |
| S-17 | 🟠 | `tarjetas.syncTarjetaCobros` postCajaMovimientoTarjeta no pasa user_id | `backend/src/lib/tarjetas.js:135-144` |
| S-18 | 🟠 | Validación de fecha en cambios.js permite fechas futuras | `backend/src/schemas/cambios.js:3` |
| S-19 | 🟠 | `pagosPorMetodo` mal calcula USDT (divide por TC ARS) | `backend/src/lib/dashboardMensual.js:79-99` |
| S-20 | 🟡 | `cobranzas-masivas` valida cajas dos veces, segundo lock redundante | `backend/src/routes/cuentas.js:960-996` |
| S-21 | 🟡 | `audit_logs` no es append-only en DB | `backend/migrations/20260521000001_initial-schema.js:168-181` |
| S-22 | 🟡 | No hay índice en `caja_movimientos(user_id)` para auditoría por usuario | migraciones |
| S-23 | 🟡 | Frontend usa `Date()` browser local en algunos componentes | `frontend/src/screens/EgresosPanel.jsx:12,15` |
| S-24 | 🟡 | Multi-tenant readiness: `pgmigrations` global, no por tenant | Todo el schema |
| S-25 | 🟡 | Movimientos de deudas/inversiones con `ON DELETE CASCADE` en contactos | migración inicial |
| S-26 | 🟡 | Frontend caches user permissions but never revalidates | `frontend/src/lib/api.js` |
| S-27 | 🟡 | `proveedor_movimientos.created_by_user_id` no se valida null en delete handler | `backend/src/routes/proveedores.js:464-472` |
| S-28 | 🟡 | No hay test de race en transferencias cross-modulo | `backend/tests/race-conditions.test.js` |
| S-29 | ⚪ | `inventario.js` PUT productos sin transacción + sin lock | `backend/src/routes/inventario.js:458-479` |
| S-30 | ⚪ | Schemas no usan `.brand()` para evitar mezcla de IDs | Todos los schemas |
| S-31 | ⚪ | `archivo_data` base64 viaja en INSERT comprobantes/productos | múltiples |
| S-32 | ⚪ | Sentry captura request body que puede contener PII | Sentry init |
| S-33 | ⚪ | `recovery_codes` se redactan en audit pero pueden colarse en otros logs | múltiples |
| S-34 | ⚪ | Migraciones no son "down-able" (varias dicen "no se revierte") | múltiples |

---

### 4.4 Performance & Escalabilidad (34 findings)

**Estado**: portal sufre a 4 escalas: (a) listados que cargan todo a memoria, (b) auth
sin caché, (c) caches in-memory process-local, (d) audit_logs sin particionar. Probable
causa del incidente Railway: P-02.

| ID | Sev | Título | Archivo |
|---|---|---|---|
| P-01 | 🔴 | GET /api/ventas carga TODA la tabla retail + B2B antes de paginar | `backend/src/routes/ventas.js:373-545` |
| P-02 | 🔴 | Auth middleware hace 2-3 queries DB por request | `backend/src/middleware/auth.js:21`, `requirePermission.js:18` |
| P-03 | 🔴 | `productos.foto_data` (base64) almacenado en TABLA PostgreSQL | `backend/migrations/20260524000001_inventario.js:76` |
| P-04 | 🔴 | Caches in-memory rompen consistencia con 2+ réplicas Railway | `backend/src/lib/cacheTtl.js`, `cajasCache.js`, etc. |
| P-05 | 🟠 | GET /api/ventas/dashboard dispara 11 queries agregadas en paralelo | `backend/src/routes/ventas.js:154-259` |
| P-06 | 🟠 | Loops con N+1 en `insertarDetalle` (ventas) e `insertarItems` (envíos) | `backend/src/routes/ventas.js:70-130` |
| P-07 | 🟠 | `audit()` corre fuera de tx en mayoría de routes y bloquea respuesta | `backend/src/lib/audit.js`, ~50 call sites |
| P-08 | 🟠 | GET /clientes lista con subquery SUM por cliente correlacionada | `backend/src/routes/cuentas.js:147-176` |
| P-09 | 🟠 | Falta índice en `movimientos_cc(fecha)` para queries dashboard B2B | migraciones |
| P-10 | 🟠 | Index `idx_audit_tabla` no cubre el dashboard query | `backend/migrations/20260521000001:179` |
| P-11 | 🟠 | `caja_movimientos` sin índice para queries de saldo histórico | múltiples |
| P-12 | 🟠 | Bundle vendor de 226KB + html2canvas 195KB cargado en rutas que no lo necesitan | `frontend/vite.config.js:152` |
| P-13 | 🟠 | `productos.cantidad` UPDATE bloquea row con FOR UPDATE en ventas concurrentes | `backend/src/routes/cuentas.js:590-596` |
| P-14 | 🟠 | Crons en el web tier compiten con tráfico activo | `backend/server.js:60-80` |
| P-15 | 🟠 | Double-release de pg client en error paths | `backend/src/routes/ventas.js:594, 598, 679, 683` |
| P-16 | 🟠 | Listados con LIMIT 500-5000 en frontend (Tarjetas, Financiera) | múltiples |
| P-17 | 🟠 | Sin `tenant_id` en NINGUNA tabla — multi-tenant requiere refactor masivo | TODAS las migraciones |
| P-18 | 🟠 | CSV/XLSX export en memoria sin streaming | múltiples |
| P-19 | 🟡 | `audit_logs` no particionada | `backend/migrations/20260521000001:168` |
| P-20 | 🟡 | Falta índice compuesto en `egresos(estado, fecha)` para dashboard | múltiples |
| P-21 | 🟡 | `historial.js` cast `JSONB::text ILIKE` impide uso de índice | `backend/src/routes/historial.js:103` |
| P-22 | 🟡 | Frontend pide `proveedoresApi.list({ limit: 500 })` en Inventario.jsx | `frontend/src/screens/Inventario.jsx:231` |
| P-23 | 🟡 | `metodos_pago.saldo_inicial + SUM(CASE...)` no usa index | múltiples |
| P-24 | 🟡 | `contactosSync` se llama best-effort sin batching | múltiples |
| P-25 | 🟡 | Conciliación queries — auto-match sin index para fecha+caja | `backend/src/routes/conciliacion.js:69` |
| P-26 | 🟡 | No hay React.memo en filas de listados grandes | múltiples |
| P-27 | 🟡 | pino-http loggea cada request sin redacción de body | `backend/src/app.js:192-200` |
| P-28 | 🟡 | `rate_limit_entries` UPSERT en cada request del API | `backend/src/app.js:110-123` |
| P-29 | 🟡 | No hay error boundaries por screen para errores async | `frontend/src/components/ErrorBoundary.jsx` |
| P-30 | ⚪ | Falta `idx_movimientos_cc (deleted_at)` para FK lookups | migraciones |
| P-31 | ⚪ | `inventario.productos({ limit: 200 })` con `vista=todos_visibles` carga muchas filas | `frontend/src/screens/Inventario.jsx:366` |
| P-32 | ⚪ | Logging de `req.url` puede incluir query strings sensibles | `backend/src/app.js:197` |
| P-33 | ⚪ | `dotenv.config({ override: !production })` puede saltar vars Railway | `backend/server.js:4` |
| P-34 | ⚪ | `manifest.webmanifest` SW NetworkFirst con 10s timeout puede mostrar UI cached | `frontend/vite.config.js:67` |

**Bonus — Queries para EXPLAIN ANALYZE en producción ahora mismo**:
1. Listado de ventas con detalle (P-01)
2. B2B en el mismo listado
3. Dashboard de ventas — sobrepagos/faltantes (CTE)
4. Saldo de cajas (cacheado)
5. Saldos de clientes CC paginados
6. Audit historial con búsqueda libre
7. Tarjetas movimientos con window function
8. pg_stat_statements top 20
9. Tablas más grandes + tasas de crecimiento
10. Pool stats en runtime

---

### 4.5 UX & Frontend Quality (54 findings)

**Estado**: base de design system muy sólida (tokens CSS, theme dark, useModal con Esc+
scroll-lock, ConfirmModal, Toast con aria-live, focus-visible global, skip-link CSS).
Lo que falla concentrado en 4 áreas: inconsistencia entre módulos, mobile real, i18n,
latencia percibida.

**BLOCKERS**:

| ID | Sev | Título | Archivo |
|---|---|---|---|
| U-01 | 🔴 | Cero infraestructura de internacionalización | Toda la app |
| U-02 | 🔴 | Modales spreadsheet inusables en mobile | múltiples modales |
| U-03 | 🔴 | No hay paginación cuando hay >200 ventas/envíos | `Ventas.jsx:118`, `Envios.jsx:352` |
| U-04 | 🔴 | Inicio hace 5 fetches paralelos y descarta 3 | `frontend/src/screens/Inicio.jsx:71-92` |

**HIGHs**:

| ID | Sev | Título | Archivo |
|---|---|---|---|
| U-05 | 🟠 | Money formatting fragmentado en 4 estilos | múltiples |
| U-06 | 🟠 | 13 modales sin `role="dialog"`/`aria-modal`/`aria-labelledby` | múltiples |
| U-07 | 🟠 | Skip-link CSS existe pero NO está injectado en Shell | `styles.css:1649-1662`, `Shell.jsx` |
| U-08 | 🟠 | No hay focus trap real en modales | `frontend/src/lib/useModal.js:74-81` |
| U-09 | 🟠 | Modal grande sin confirm-on-close = pérdida de datos | `Ventas.jsx:798`, `Envios.jsx:882` |
| U-10 | 🟠 | Pickers de búsqueda con keyboard nav inconsistente | `Ventas.jsx:813`, `Envios.jsx:1001-1018` |
| U-11 | 🟠 | `inputMode` ausente en ~50 inputs numéricos | múltiples |
| U-12 | 🟠 | No hay skeletons, solo "Cargando…" | 13 ocurrencias |
| U-13 | 🟠 | `Badge` y `Seg` re-declarados localmente en 7+3 pantallas | múltiples |
| U-14 | 🟠 | Tablas sin sorting | TODAS las tablas |
| U-15 | 🟠 | No hay tooltips accesibles | múltiples |
| U-16 | 🟠 | Confirmaciones destructivas sin doble-confirm para acciones de cascada amplia | `Inventario.handleVaciarStock` |
| U-17 | 🟠 | Dashboard de Ventas usa emojis (📱 🎧) como iconos | `screens/ventas/Dashboard.jsx:44` |
| U-18 | 🟠 | Date inputs nativos = comportamiento dispar | 36 instancias |
| U-19 | 🟠 | Dropdowns/popovers se cortan al final del viewport | múltiples |
| U-20 | 🟠 | `Capital` carga 7 endpoints en paralelo sin batching | `Capital.jsx:48-60` |
| U-21 | 🟠 | "⌘K" hardcoded — Windows users no saben qué significa | `Shell.jsx:310` |
| U-22 | 🟠 | PWA: `registerType: 'autoUpdate'` pero UpdateBanner asume prompt | `Shell.jsx`, `vite.config.js:55` |

**MEDIUMs** (21) y **LOWs** (11) en el reporte completo.

**Bonus — Comparativa con SaaS competidores**: i18n, búsqueda global, demo data,
mobile nativa, tablas sortable, tooltips accesibles son gaps comunes vs Tiendanube/Holded/Zoho.

---

### 4.6 Repo Hygiene & DX (23 findings)

**Estado**: el repo está **en sorprendentemente buen estado** para una sola persona.
Observabilidad sólida, tests reales, Sentry+health+invariantes, audit logs con PII
redaction, soft delete universal, documentación operativa. 0 TODO/FIXME, 0 console.log.

| ID | Sev | Título | Archivo |
|---|---|---|---|
| H-01 | 🟠 | Documentación frontend completamente desactualizada | `frontend/README.md` |
| H-02 | 🟠 | `OPERATIONS.md §4` contradice la implementación (réplicas) | `docs/OPERATIONS.md:54-64` |
| H-03 | 🟠 | Errores async se silencian en frontend (`catch(console.error)`) | 31 ocurrencias |
| H-04 | 🟠 | Archivos monstruo (>1000 líneas) | 8 archivos |
| H-05 | 🟠 | Duplicación crónica de `Badge`, `Status`, `fmtARS`, `fmtMoney` | 7+ archivos |
| H-06 | 🟠 | No hay versioning de API (`/v1/`) | `backend/src/app.js` |
| M-01 | 🟡 | Frontend README + ONBOARDING.md huérfanos / stale | múltiples docs |
| M-02 | 🟡 | Scripts backend huérfanos | `backend/scripts/` |
| M-03 | 🟡 | `backend/src/config/schema.sql` está stale | `backend/src/config/schema.sql:11` |
| M-04 | 🟡 | `VITE_SENTRY_DSN` documentado pero nunca usado en código | `frontend/.env.local.example:12` |
| M-05 | 🟡 | No hay Prettier, .editorconfig, Husky, lint-staged | raíz |
| M-06 | 🟡 | ESLint rules en `warn` — los warnings acumulan | eslint configs |
| M-07 | 🟡 | No hay TypeScript / casi no hay JSDoc | todo el repo |
| M-08 | 🟡 | Sin feature flags | N/A |
| M-09 | 🟡 | Sin pre-commit que valide `.env` no se cuele al commit | N/A |
| M-10 | 🟡 | Naming inconsistente en frontend (snake_case API vs camelCase JS) | múltiples |
| L-01 | ⚪ | Naming files inconsistente backend (`twoFa.js` vs `metodos-pago.js`) | `backend/src/routes/` |
| L-02 | ⚪ | Naming files inconsistente frontend (`CuentasCC.jsx`, `Desglose360.jsx`) | `frontend/src/screens/` |
| L-03 | ⚪ | Sin CONTRIBUTING.md, CODEOWNERS, CHANGELOG, SECURITY.md, PR template | N/A |
| L-04 | ⚪ | Sin ADRs explícitos | `docs/ARCHITECTURE.md:358-373` |
| L-05 | ⚪ | Sin script central para correr "checks completos" antes de push | N/A |
| L-06 | ⚪ | `RecepcionStock` chunk 476KB un-gzipped | `frontend/src/screens/RecepcionStock.jsx` |
| L-07 | ⚪ | `docs/legacy/` ocupa 324KB en repo (HTMLs viejos pre-React) | `docs/legacy/` |

**Bonus — Roadmap TypeScript gradual** (4 fases, 2-3 meses):
- Fase 0: setup tsconfig + ESLint TS plugin
- Fase 1: `// @ts-check` por archivo en lib críticos
- Fase 2: lib/ a `.ts`
- Fase 3: Routes a `.ts`
- Fase 4: Frontend a `.tsx`

**Bonus — Archivos candidatos a split** (Tier 1):
- `Financiera.jsx` (1727 → 5 archivos)
- `Tarjetas.jsx` (1410 → 6 archivos)
- `CuentasCC.jsx` (1407 → 7 archivos)
- `Ventas.jsx` (1284 → 5 archivos)
- `cuentas.js` (1179 → 6 archivos)

---

## 5. Tandas propuestas

### TANDA 0 — HOTFIX inmediato (1-2 días) ⚡

**Foco**: bugs activos y fixes de minutos con alto ROI.

| ID | Acción | Effort |
|---|---|---|
| SE-01 | Bajar `JWT_EXPIRES_IN` de 7d → 8h | 5 min |
| S-02 | DELETE /usuarios bumpea `password_changed_at` | 5 min |
| S-01 | SAVEPOINTs en `orphan-movs/apply` (**bug ACTIVO**) | 1 h |
| U-04 | Inicio: borrar dead fetches | 30 min |
| P-15 | Double-release de pg client en error paths | 30 min |
| S-19 | Bug numérico USDT en `pagosPorMetodo` | 30 min |
| H-01 | Corregir `frontend/README.md` | 30 min |
| H-02 | Corregir `OPERATIONS.md §4` | 20 min |
| M-04 | Borrar `VITE_SENTRY_DSN` muerta | 5 min |

**Total**: ~4-6 horas. Cierra 3 BLOCKERs + 1 HIGH + 5 fixes administrativos.

### TANDA 1 — Auth & Observabilidad real (~1 semana)

**Foco**: resolver lo que probablemente causó el incidente Railway de hoy.

| ID | Acción | Effort |
|---|---|---|
| P-02 | Cachear perms en JWT + LRU 60s en `requireAuth` | 8 h |
| SE-05 | `audit_logs` +IP/UA/request_id | 1 día |
| SE-07 | Rate limit + re-auth 2FA en `change-password` | 2 h |
| SE-08 | Re-auth 2FA en PUT `/usuarios/:id` | 4 h |
| H-03 | 31 `.catch(console.error)` → `reportError` | 1 día |
| SE-10 | Cap en `/comprobantes/export-zip` (LIMIT 1000) | 1 día |

**Total**: 4-5 días.

### TANDA 2 — Correctness BLOCKERs (~1 semana)

| ID | Acción | Effort |
|---|---|---|
| S-03 | Unificar fórmula saldo CC (dashboard vs módulo) | 4 h |
| S-04 + S-05 | Audit dentro de TX en TODOS los endpoints (25 endpoints, refactor incremental) | 3-4 días |
| T-09 | Fix assertion fake-green en `ventas.test.js` | 2 h |
| T-06 | Tests `.strict()` parametrizados para 20 schemas | 4 h |
| S-18 | Validación de fecha en cambios.js (no futuras) | 30 min |

**Total**: 5-6 días.

### TANDA 3 — Performance crítica (~2 semanas)

| ID | Acción | Effort |
|---|---|---|
| P-01 | Refactor GET /api/ventas: paginación a SQL con UNION ALL | 6 h |
| P-05 | Dashboard ventas con cache TTL 30s | 6 h |
| P-11 | Denormalizar `saldo_actual` en `metodos_pago` (triggers) | 6 h |
| P-06 | Bulkificar `insertarDetalle` + `insertarItems` (UNNEST) | 4 h |
| P-09, P-10, P-20 | Índices faltantes | 2 h |
| P-13 | UPDATE atomic en lugar de FOR UPDATE para stock lote | 4 h |

**Total**: ~10 días.

### TANDA 4 — Tests críticos (~2 semanas)

| ID | Acción | Effort |
|---|---|---|
| T-01 | Tests `Envios.jsx` (15 tests) | 2 días |
| T-02 | Tests `Inventario.jsx` (10-12 tests) | 1 día |
| T-03 | Tests `Cajas.jsx` | 1 día |
| T-05 | Tests up/down de migraciones | 1-2 días |
| T-08 | Load test en CI (job nuevo) | 1 día |
| T-11 | Tests SQL injection / XSS probes (15 endpoints) | 1 día |
| T-17 | Test rate-limit del login | 2 h |

**Total**: ~10 días.

### TANDA 5 — E2E + UX foundations (~3-4 semanas)

| ID | Acción | Effort |
|---|---|---|
| T-04 | E2E suite Playwright (4 sprints, 4 flows críticos) | 4 semanas |
| U-01 | i18n: react-i18next + Shell + Login + Inicio | 5-10 días |
| U-05+U-13 | `fmtMoney` único + eliminar Badge/Seg locales | 2-3 h |
| U-12 | Skeletons en 6 pantallas críticas | 3-4 días |
| U-08+U-06 | Focus trap real + ARIA en modales | 2-3 días |
| U-15 | Componente `Tooltip` accesible | 2 días |
| U-14 | Tablas con sorting (`SortableTable`) | 2-3 días |
| U-02 | Modales spreadsheet responsive en mobile | 3 semanas |

**Total**: ~3-4 semanas (con paralelismo).

### TANDA 6 — Arquitectura SaaS (3-6 meses)

| ID | Acción | Effort |
|---|---|---|
| SE-02 + S-24 + P-17 | `tenant_id` en TODAS las tablas (migración + RLS + middleware) | 4-6 semanas |
| P-03 | `foto_data`/`archivo_data` → Cloudflare R2 | 16-24 h |
| P-04 | Redis (Upstash) para caches + rate-limit | 8-12 h |
| P-07 + P-19 | Audit logs async (queue) + particionado por mes | 12-16 h |
| H-06 | API versioning `/v1/` como alias | 30 min |
| M-07 | TypeScript gradual (Fases 0-4) | 2-3 meses |
| M-08 | Sistema de feature flags | 1 día |
| U-23 | Búsqueda global de datos | 2-3 días |

**Total**: 200-400 horas.

---

## 6. Roadmap por trimestre

| Trimestre | Foco | Tandas |
|---|---|---|
| **Q3 2026** (jul-sep) | Estabilidad y correctness | TANDA 0 + 1 + 2 |
| **Q4 2026** (oct-dic) | Performance + Tests | TANDA 3 + 4 |
| **Q1 2027** (ene-mar) | E2E + i18n + UX foundations | TANDA 5 |
| **Q2-Q3 2027** (abr-sep) | Arquitectura SaaS multi-tenant | TANDA 6 (primera mitad) |
| **Q4 2027** | Pulido + producto vendible | TANDA 6 (segunda mitad) + go-to-market |

---

## 7. Recomendaciones tácticas

1. **Arrancá YA con TANDA 0** — son 1-2 días de bugs reales que ya estás pagando.
2. **TANDA 1 + 2 en paralelo** después — fixes precisos, no se pisan.
3. **TANDA 4 (tests) ANTES de TANDA 3 (perf)** si tenés que elegir — red de seguridad
   antes del refactor performance.
4. **No empieces TANDA 6 sin TANDA 4 cerrada** — multi-tenancy sin tests E2E es suicidio.
5. **i18n infra (U-01) puede arrancar ya mismo en background** — cada feature post-julio
   entra con `t()`, sin esperar migración masiva.

---

*Documento generado el 2026-06-10 por 6 agentes paralelos. Base: `main` post-merge del
PR fix/envios-detalle-moneda-real (commit feda69b).*
