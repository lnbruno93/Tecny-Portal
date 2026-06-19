# Arquitectura — iPro Portal

Vista panorámica del sistema: qué módulos hay, cómo se relacionan, qué patrones
se repiten, y por qué las decisiones durables son como son.

Para procedimientos cotidianos ver [OPERATIONS.md](OPERATIONS.md). Para "qué
hacer si X" ver [RUNBOOK.md](RUNBOOK.md). Para observabilidad ver
[OBSERVABILITY.md](OBSERVABILITY.md).

---

## 1. Qué es iPro Portal

Portal operativo interno para iPro Tech (mayorista de tecnología en AR).
Maneja:

- **Inventario** (productos, IMEIs, stock, condición nuevo/usado, ocultos).
- **Ventas** (retail) y **Ventas B2B** (mayorista, con cobranza diferida).
- **Cuentas corrientes** (clientes que pagan a plazo).
- **Proveedores** (deuda a proveedores, compras a crédito).
- **Cajas** (cuentas en ARS/USD/USDT que se mueven con cada venta/pago/egreso).
- **Egresos** (gastos fijos y variables, recurrentes).
- **Cambios de divisa** (USD↔ARS, USDT↔USD, etc.).
- **Tarjetas de crédito** (planes de cuotas con recargos).
- **Envíos** (logística que cierra en venta real).
- **Proyectos** (desarrollos con participantes y aportes financieros).
- **Conciliación bancaria** (cruzar extracto con caja_movimientos).
- **Alertas** (caja negativa, stock bajo, mora CC, TC de referencia).
- **Resumen mensual** (gerencia: KPIs cross-módulo).
- **Dashboard, Cotizador, Historial, etc.**

---

## 2. Stack

| Capa | Tech | Notas |
|---|---|---|
| Frontend | React 19 + Vite + react-router | PWA. Bundle ~600kb gzip. |
| Frontend tests | Vitest | 156 tests |
| Backend | Node 20 + Express | JWT HS256, helmet, compression |
| Backend tests | Jest + supertest | 539 tests integration |
| DB | PostgreSQL 18 | node-pg-migrate, sin ORM |
| Auth | JWT HS256 + bcrypt + lockout + 2FA TOTP opcional | Ver §8 decisiones durables; sin OAuth todavía |
| Deploy backend | Railway | `Postgres-AueP` (DB) + `tecny-backend` (rename a `tecny-backend` pendiente — fase 2 del rebrand) |
| Deploy frontend | Netlify | `tecnyapp.com` (custom domain) — fallback `ipro-portal.netlify.app` |
| Observability | pino (logs) + Sentry (errors) + UptimeRobot | Plus `/health` y `/ready` |
| CI | GitHub Actions | npm audit + lint + tests + build |

**Cero infra extra:** no hay Redis, no hay queue worker, no hay storage S3
externo. Todo dentro de Railway. Cuando crezca, migrar caches in-memory a
Redis y jobs internos a Railway Scheduler / pg_cron.

---

## 3. Estructura del repo

```
backend/
  migrations/           62 migraciones secuenciales (node-pg-migrate)
  src/
    app.js              Express app (middleware + mount routes)
    routes/             25 módulos de rutas (uno por dominio)
    lib/                Lógica compartida: cajaLedger, ventaCore, money, etc.
    middleware/         requireAuth, requirePermission, adminOnly
    jobs/               Crons internos (invariantsJob, audit purga)
    schemas/            Zod schemas por endpoint
  tests/                37 suites integration con supertest
  loadtest/             autocannon scenarios + driver
  server.js             Entrypoint: dotenv + Sentry init + listen + shutdown

frontend/
  src/
    screens/            Pantallas (una por módulo de UI)
    components/         Reusables (Shell, Modales, Icons, TcWarning, etc.)
    contexts/           Auth, Toast, Confirm, TcReferencia
    lib/                api client, format, parsers, xlsx, useDebouncedValue
    test-setup.js       Vitest setup
  vite.config.js        Build, PWA, define __BUILD_COMMIT__

docs/                   API_REFERENCE, OPERATIONS, RUNBOOK, OBSERVABILITY,
                        DISASTER_RECOVERY, LOAD_BASELINE, STAGING, STORAGE,
                        ARCHITECTURE (este archivo)
```

---

## 4. Dominios y tablas

47 tablas agrupadas por área:

### Inventario
`productos`, `categorias`, `depositos`, `etiquetas`, `plantillas_garantia`

### Ventas
`ventas`, `venta_items`, `venta_pagos`, `venta_comprobantes`, `vendedores`,
`canjes`, `ventas_rapidas`, `pagos`, `comprobantes`

### Cuentas corrientes (clientes)
`clientes_cc`, `movimientos_cc`, `items_movimiento_cc`

### Proveedores
`proveedores`, `proveedor_movimientos`, `proveedor_movimiento_items`

### Cajas + ledger central
`metodos_pago` (las "cajas"), `caja_movimientos` (ledger único — TODOS los
módulos que mueven dinero pasan por acá)

### Egresos
`egresos`, `egresos_recurrentes`, `egreso_categorias`

### Cambios de divisa + Tarjetas
`cambio_entidades`, `cambio_movimientos`, `tarjeta_entidades`,
`tarjeta_planes`, `tarjeta_movimientos`

### Envíos
`envios`, `envio_items`

### Proyectos
`proyectos`, `proyecto_movimientos`, `proyecto_participantes`

### Conciliación bancaria
`conciliaciones`, `conciliacion_lineas` (+ campos `conciliado_en` y
`conciliacion_id` en `caja_movimientos`)

### Sistema
`users`, `user_permissions`, `audit_logs`, `historial`, `contactos`,
`config`, `alertas_config`, `movimientos_inversiones`, `movimientos_deudas`

### Auth + multi-tenant (TANDA 0/1/2/2.4)
`tenants` (entidad de cliente), `tenant_users` (link user↔tenant con rol:
owner/admin/member), `email_verification_tokens` (single-use tokens con TTL
24h, purgados periódicamente). El JWT trae `tenant_id` + `tenant_rol`;
`adminOnly` middleware valida por `tenant_rol`, NO por `users.role` global.
Signup público crea tenant + user (`role='op'`) + link como owner + seeds 3
cajas default. Email verification es bloqueo blando: GET libre, POST/PUT/DELETE
bloqueados hasta verificar. RLS activado en tablas de negocio (NO en `users`
ni `tenant_users` — esas tienen filtro explícito por `tenant_id` en cada
query). Resend SaaS para envío de emails con fallback stub si no hay API key.

---

## 5. Patrones recurrentes

Aplican en todos los módulos. Si vas a tocar código, conocer estos patrones
te ahorra recrear soluciones que ya existen.

### 5.1 Soft delete (deleted_at)

Casi todas las tablas tienen `deleted_at TIMESTAMPTZ NULL`. Borrar = `UPDATE
SET deleted_at = NOW()`. Listados filtran `WHERE deleted_at IS NULL`.

**Por qué:** auditoría + recovery. Borrado físico solo se permite via
`pg_dump` manual o purga del audit_log (>365 días, configurable).

**Trampa común:** al hacer JOIN, no olvidar el `AND tabla.deleted_at IS NULL`
en la cláusula ON (no en el WHERE) si la tabla es `LEFT JOIN` y querés
preservar la fila padre.

### 5.2 Ledger central (caja_movimientos)

**Toda operación que mueve dinero genera una fila en `caja_movimientos`**.
Sin excepciones. Eso permite reconstruir el saldo de cualquier caja en
cualquier momento histórico, y darle a la conciliación bancaria un solo
lugar donde buscar.

API: `lib/cajaLedger.js`
- `postCajaMovimiento(client, { caja_id, fecha, tipo, monto, moneda, tc,
  origen, ref_tabla, ref_id, concepto, user_id })`
- `reverseCajaMovimientos(client, ref_tabla, ref_id)` — para deshacer un
  egreso/venta/etc. soft-deleted.

**Validación:** `postCajaMovimiento` valida que la caja tenga saldo
suficiente, que la moneda match el grupo de la caja, etc. Lanza error 400 o
409 — el route handler debe propagarlo.

**Origen vs ref_tabla:** `origen` es el tipo lógico (`venta`, `egreso`,
`proyecto`, etc.). `ref_tabla` + `ref_id` apuntan a la fila exacta. Eso
permite invariantes tipo "todo caja_mov con origen=egreso debe tener un
egreso correspondiente vivo" (ver §7).

#### 5.2.1 Trazabilidad por módulo (Financiera + Tarjetas, junio 2026)

Dos módulos exponen su propio saldo virtual que **debe coincidir** con el
saldo real de una caja específica. La trazabilidad la garantizan helpers
dedicados que envuelven `postCajaMovimiento`:

**Financiera ↔ caja `es_financiera=true` (singleton):**
- `lib/financiera.js → postCajaMovimientoFinanciera(client, { fecha, tipo, monto, ref_tabla, ref_id, concepto, user_id })`
- Busca internamente la caja con `es_financiera=true` (debe existir 1, throwea
  400 si no). Origen: `'financiera'`.
- Forward path: `comprobantes.js` POST (+ingreso por venta), POST /manuales
  (+ingreso), DELETE/PATCH (reverse+repost si cambió neto); `pagos.js` POST
  (−egreso por pago a vendedor).
- **Decisión durable:** se usa `monto_neto`, NO bruto. La comisión retenida
  por la financiera no pasa por caja — es ingreso virtual del módulo, no real.

**Tarjetas ↔ caja `es_tarjeta=true` (N, una por tarjeta):**
- `lib/tarjetas.js → postCajaMovimientoTarjeta(client, { metodo_pago_id, fecha, tipo, monto, ref_id, concepto, user_id })`
- Recibe `metodo_pago_id` explícito porque cada tarjeta es su propia caja
  (modelo N-to-N, no singleton como Financiera).
- Forward path: `tarjetas.js` POST /cobros-iniciales (+ingreso), POST
  /liquidaciones (−egreso), POST /liquidaciones-multiples (−egreso por
  reparto); `syncTarjetaCobros` reverse+repost cobros de venta al editar.
- **Decisión durable:** monto = neto cobrado (igual que Financiera). La
  comisión nunca toca caja.

**Backfill histórico:** `scripts/backfill-caja-financiera.js` y
`scripts/backfill-caja-tarjetas.js` reconstruyen los movs pre-cutover.
Idempotentes (WHERE NOT EXISTS), corren en una tx con advisory lock
(`pg_try_advisory_xact_lock`) para evitar 2 admins en paralelo, validan
saldo final ≥ 0 antes de COMMIT. UI inline en Config → Mantenimiento
(admin only) + endpoints `GET|POST /api/admin/backfill-caja-*` con
rate-limit propio.

### 5.3 Audit logs

Cada `INSERT`/`UPDATE`/`DELETE` significativo escribe en `audit_logs`:
`{ tabla, accion, registro_id, datos_antes, datos_despues, user_id }`.

API: `lib/audit.js` → `audit(client, tabla, accion, id, { antes, despues, user_id })`

- **Pasar el client de TX** para que el audit log persista en la misma
  transacción que el cambio. Si pasás `db` (pool), el cambio puede commitear
  pero el audit perderse — anti-patrón.
- **Redaction de PII:** teléfono, dirección, IMEI, password, etc. se
  redactan antes de persistir (Ley 25.326 / GDPR).

### 5.4 Permisos por tool

Cada módulo "user-facing" tiene un permiso: `ventas`, `cajas`, `cambios`,
`proveedores`, `proyectos`, `financiera`, etc.

API: `middleware/requirePermission.js`
- `requirePermission('cajas')` — el user debe tener `user_permissions.cajas
  = true` o ser `role='admin'`.
- `role='admin'` siempre tiene bypass.

**Para módulos solo-admin (no granular):** `middleware/adminOnly.js` →
`router.use(adminOnly)`. Ej: usuarios, admin/invariants.

### 5.5 Caché TTL in-memory

Endpoints de lectura con queries pesadas usan `lib/cacheTtl.js`:

```js
const fetchAlertas = createCachedFetcher('alertas:eval', 5 * 60_000, async () => {
  return await db.query('...');
});
```

- TTL configurable por caso (60s para dashboard, 5min para alertas).
- Promise de-dup: si llegan N requests simultáneos con caché expirado, se
  hace UNA sola query.
- Process-local (no compartido entre workers).

**Cuándo no usarlo:** queries filtradas por usuario (la caché global no
distingue). Para esos casos cachear por user_id como key.

### 5.6 Schemas Zod con `.strict()`

Cada endpoint POST/PUT valida body con un schema Zod en `src/schemas/`.

```js
const createConciliacionSchema = z.object({
  caja_id: z.coerce.number().int().positive(),
  fecha_desde: z.string().date(),
  // ...
}).strict()  // ← rechaza claves desconocidas
  .refine(d => d.fecha_desde <= d.fecha_hasta, '...');
```

- **`.strict()` siempre** — rechaza claves desconocidas (prototype pollution
  defense + atrapa typos del frontend).
- **`.refine()` para invariantes cross-field** (ej. `fecha_desde <= fecha_hasta`).
- **`z.coerce.number()` para query strings** que vienen como string.

### 5.7 Paginación uniforme

`lib/paginate.js`:
- `parsePagination(req.query, { defaultLimit, maxLimit })` → `{ page, limit, offset }`
- `paginatedResponse(rows, total, { page, limit })` → `{ data, pagination }`

**Default 50, max 200.** Caps en el schema previenen DoS (`limit=999999`).

### 5.8 Money con redondeo a 2 decimales

`lib/money.js`:
- `toUsd(monto, moneda, tc)` — convierte a USD usando el TC dado.
- `round2(n)` — Math.round(n*100)/100. Aplicar SIEMPRE antes de persistir
  en columnas `NUMERIC(14,2)` para evitar drift por punto flotante.

### 5.9 Rate limits

- Global: 300 req/15min por IP (configurable via `GLOBAL_RATE_LIMIT_MAX`).
  `/health` y `/ready` exentos.
- Específicos por endpoint costoso: cobranza masiva, bulk inventory,
  conciliación, etc. Usan `ipKeyGenerator` para IPv6 safety.

### 5.10 Transacciones explícitas

Cuando una operación toca >1 tabla:

```js
const client = await db.connect();
try {
  await client.query('BEGIN');
  // ... múltiples queries
  await audit(client, ...);  // dentro de la TX
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

`lib/withTx.js` ofrece un helper para wrappear esto.

---

## 6. Flujo típico de una operación: "registrar una venta"

1. **Frontend** envía POST `/api/ventas` con `{ items, pagos, cliente, tc, ... }`.
2. **requireAuth + requirePermission('ventas')** → middleware valida JWT y perms.
3. **validate(createVentaSchema)** → Zod parsea + valida body.
4. **routes/ventas.js → handler:**
   - `client.query('BEGIN')`
   - `INSERT INTO ventas`
   - Por cada item: `INSERT INTO venta_items` + descuento de stock
     (`UPDATE productos SET cantidad = cantidad - X WHERE ... AND cantidad >= X`).
   - Por cada pago: `INSERT INTO venta_pagos` + `postCajaMovimiento(...)`.
   - Si CC: `INSERT INTO movimientos_cc` con tipo `compra`.
   - `audit(client, 'ventas', 'INSERT', id, { despues, user_id })`.
   - `COMMIT`
5. **Response 201** con la venta creada.

Si algo falla → `ROLLBACK`, el frontend recibe 4xx con mensaje y el estado
de la DB no cambia.

---

## 7. Invariantes financieros

Reglas que el código **siempre** debe mantener. El cron nocturno
(`backend/src/jobs/invariantsJob.js`) las valida y reporta a Sentry si hay
drift. Ver `lib/checkInvariants.js` para la lista completa.

Las críticas (severity `crítica`):
- **Cajas con saldo ≥ 0:** ninguna caja activa puede estar en negativo.
- **Egreso pagado → caja_movimiento:** todo egreso `estado='pagado'` con
  `metodo_pago_id` debe tener un `caja_movimientos` correspondiente.
- **Proyecto mov con caja_id → caja_movimiento:** análogo.

Trazabilidad por módulo (severity `alta`, ver §5.2.1):
- **Comprobante manual → +ingreso en caja FV:** todo comprobante con
  `venta_id IS NULL` debe tener `caja_movimientos` `tipo=ingreso` referenciándolo.
- **Pago → −egreso en caja FV:** todo `pagos.caja_id IS NOT NULL` debe tener
  un −egreso en la caja `es_financiera=true`.
- **Cobro → +ingreso en caja-tarjeta:** todo `tarjeta_movimientos.tipo='cobro'`
  debe tener `caja_movimientos` `tipo=ingreso` en su caja-tarjeta (`metodo_pago_id`).
- **Liquidación → −egreso en caja-tarjeta:** análogo con `tipo=liquidacion`.

Las medias miran consistencia referencial de conciliación, soft-delete
across tables, etc.

---

## 8. Decisiones durables (y por qué)

| Decisión | Por qué |
|---|---|
| **Sin ORM (queries SQL crudas)** | Control fino + transparencia. ORM agrega magia que esconde N+1 y bugs sutiles en TX. La codebase es chica para JS dev único — el costo de mantenibilidad es bajo. |
| **Sin Redis** | Single-instance hobby tier — cache process-local alcanza. Migrar a Redis cuando escalemos a >1 worker. |
| **Sin queue worker** | Idem. `setInterval` interno con `.unref()` cubre los crons. |
| **Sin `@sentry/react`** | ~30kb gz al bundle. Custom reporter via `/api/client-errors` reusa Sentry backend. |
| **Soft-delete universal** | Recovery + auditoría. El costo es queries con `WHERE deleted_at IS NULL`. Pagable. |
| **Audit log con redacción PII** | Cumplimiento Ley 25.326 (AR) + GDPR. Redaction en `lib/audit.js`. |
| **JWT HS256 (no RS256)** | Single backend, no necesitamos public key dist. Symmetric secret en env var. |
| **money.js round2 en JS** | Evita float drift comparando contra `NUMERIC(14,2)`. Si la DB redondea distinto que JS, perdés centavos por venta. |
| **CSP estricto** | Mitigación XSS. Reporta violaciones via `csp-report-uri`. |
| **Trust proxy: 1** | Railway hace SSL termination + LB. Sin esto, rate limit usaría IPs internas. |
| **2FA TOTP opcional, no obligatorio inicial** | Permitimos que cada user decida activar 2FA. Forzarlo desde día 1 lockea a usuarios actuales fuera del portal. Política durable: opcional para todos, banner sugiriendo a admins activarlo, en PR futuro forzar para admins cuando todos lo tengan setup. Mecanismo: TOTP (RFC 6238) con `speakeasy`, secret cifrado con AES-256-GCM via `TWOFA_ENCRYPTION_KEY`, 8 recovery codes one-time-use hasheados con bcrypt. |
| **Backend + DB en US West (California)** | Las regions sudamericanas no están disponibles en Railway. Mover a US East ahorraría 30-50ms vs ~190ms desde AR — beneficio marginal vs riesgo de migración. Ver investigación completa en [LOAD_BASELINE.md](LOAD_BASELINE.md). |

---

## 9. Cómo agregar un módulo nuevo (template)

Cuando aparece una feature que merece su propio "dominio":

1. **DB:** `npm run migrate:create nombre_feature` → editar la migración con
   `CREATE TABLE` + índices + FK + CHECK constraints. Incluir `deleted_at` y
   `created_at`.
2. **Schemas:** `src/schemas/<feature>.js` con Zod `.strict()`.
3. **Route:** `src/routes/<feature>.js` con CRUD + `audit(client, ...)` en
   cada mutación + paginación en listados.
4. **App.js:** importar y montar con `requireAuth + requirePermission('X')`.
5. **Permiso:** agregar el tool a `lib/tools.js` (TOOLS array).
6. **Tests:** `tests/<feature>.test.js` cubriendo happy path + errors +
   permisos + edge cases.
7. **Frontend:** `screens/<Feature>.jsx` + entrada en `Shell.jsx` NAV_MAIN.
8. **Si mueve dinero:** integrar con `postCajaMovimiento` + agregar
   invariante a `lib/checkInvariants.js`.
9. **Si tiene queries pesadas:** envolver con `createCachedFetcher`.
10. **Documentar:** `docs/API_REFERENCE.md` con los nuevos endpoints.

---

## 10. Roadmap arquitectural (cuándo escalar)

Triggers que cambian decisiones:

- **>1 instancia backend** → caches in-memory dejan de servir → Redis.
- **>1 hour de downtime aceptable inaceptable** → blue-green deploys, db
  replica, multi-region. Hoy Railway hobby = single point.
- **Más de 1 dev en el código** → CODEOWNERS, ADRs explícitos por decisión
  controversial, PR templates.
- **>50k usuarios/mes** → métricas custom (Prometheus + Grafana), APM, no
  solo logs/Sentry.
- **Cumplimiento estricto (AFIP facturación electrónica)** → módulo
  dedicado con cola de reintentos, idempotency keys, reconciliación con
  ente externo.

Por ahora ninguno de esos triggers se activó. Buena señal: la arquitectura
está alineada con el tamaño del problema.
