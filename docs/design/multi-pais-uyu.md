# Multi-país: Soporte para Pesos Uruguayos (UYU)

**Estado**: 🛠 DISEÑO — pendiente de implementación (F1 → F5).
**Fecha**: 2026-06-29 (creación y decisiones cerradas con Lucas).
**Origen**: pedido de Lucas tras cerrar un cliente UY comprometido — abrir el mercado Uruguay manteniendo el mismo producto.
**Effort estimado**: 8-12 días total. F1 ≈ 1.5-2 días, F2 ≈ 2-3 días, F3 ≈ 1-1.5 días, F4 ≈ 2-3 días, F5 ≈ 1-2 días.
**Decisiones cerradas con Lucas**: ver sección 2 (8 decisiones).
**Issue**: #467.

**Progreso de implementación**:
| Fase | PR/Status | Notas |
|---|---|---|
| F1 schema + helpers backend | ⏸ Pendiente | tenant.pais, tc_defaults_pais, CHECK moneda |
| F2 validaciones + endpoints | ⏸ Pendiente | Zod por país, /api/config/tc-default |
| F3 frontend formatters + dropdowns | ⏸ Pendiente | fmtMoney UYU, gating por pais |
| F4 cotizador + signup UY | ⏸ Pendiente | Adaptar pantalla + selector país en signup |
| F5 red B2B cross-frontera + docs | ⏸ Pendiente | AR↔UY partnerships, ARCHITECTURE.md update |

---

## 1. Motivación

### 1.1 Qué resolvemos

Hasta hoy, **todos los tenants de Tecny son argentinos**: el portal asume operación en ARS + USD + USDT, con tipo de cambio (TC) entendido siempre como **ARS por USD** (e.g. 1400 ARS = 1 USD). El cotizador, los selectores de moneda, los símbolos visuales (`$`, `u$s`, `USDT`) y los defaults de Zod codifican esa asunción.

Lucas cerró un cliente uruguayo (revendedor de tecnología en Montevideo) que necesita usar Tecny **igual que un cliente argentino**: ventas en moneda local + USD + USDT, cuentas corrientes con clientes y proveedores, inventario en USD, mismo flujo retail/B2B/envíos/financiera. La única diferencia: **la moneda local es UYU (peso uruguayo)**, no ARS, y el TC relevante es **UYU por USD** (e.g. 40 UYU = 1 USD).

### 1.2 Qué proponemos

Introducir el concepto de **país del tenant** (`tenant.pais`) como dimensión de configuración multi-tenant, y derivar de ahí:
- **Moneda local** habilitada en dropdowns: ARS para `pais='AR'`, UYU para `pais='UY'`. USD + USDT habilitadas para ambos (son monedas universales del negocio).
- **TC default** consultado del backend: ARS/USD para AR, UYU/USD para UY. Cada tenant tiene su propio default editable.
- **Símbolo + formato**: `$` ARS vs `$U` UYU, mismo separador `es-AR` / `es-UY` (idéntico estructuralmente).
- **Cotizador adaptado**: muestra TC UYU/USD y porcentajes equivalentes (la lógica `1/(1-comisión)` es universal — no cambia).

### 1.3 Por qué importa para el negocio

- **Apertura de mercado regional** sin re-arquitectura. Uruguay es un mercado natural por proximidad cultural, mismas dinámicas de reseller (USD como anchor, peso local volátil, USDT como reserva). El cliente UY ya está comprometido — perderlo implica perder la apertura.
- **Network effect Red B2B cross-frontera**: AR↔UY ya es un caso real (revendedores argentinos abastecen a uruguayos). Una vez ambos lados están en Tecny, las partnerships cross-tenant (feature ya implementada) cruzan frontera sin tocar nada del schema partnerships — esto multiplica el valor del producto.
- **Validación del modelo multi-país**: si UY funciona, agregar CL, PY, PE, MX, etc., es repetir el mismo patrón con datos. La inversión inicial paga la opción.

### 1.4 Por qué este es un proyecto serio, no un hotfix

Tocar `tenant.pais` introduce una dimensión transversal que afecta:
- **DB**: nuevas columnas, CHECK constraints de moneda extendidos, tabla de defaults por país.
- **Backend**: helpers `toUsd()` ya son moneda-agnósticos (✅), pero validaciones Zod hardcodean enums `['USD','ARS','USDT']` en 5+ schemas.
- **Frontend**: 30+ ocurrencias de dropdowns `<option>ARS</option>` hardcoded, símbolo `$` asumido = ARS en `fmtMoney`, locale `es-AR` cementado en `format.ts`.
- **Cotizador**: hardcodea texto "USD → ARS", default TC=1400, mensajes de copy con "ARS" y "$".
- **Red B2B**: AR↔UY partnership requiere conversión UYU↔USD↔ARS y caja default por tenant compatible con la moneda del pago.

Si se hace mal:
- Tenants UY ven dropdown con ARS (basura visual, riesgo de cargar ventas en la moneda equivocada).
- TC default por API externa (BCRA, BCU) introduce dependencia inestable y costo operativo (Lucas pidió explícitamente NO usar API externa — TC 100% manual).
- Red B2B AR↔UY con TC mal calculado → saldos divergentes (mismo riesgo que detalla el doc Red B2B sección 9).

Por eso este doc cierra 8 decisiones antes de tocar código, define el schema completo y particiona en 5 fases mergeables.

---

## 2. Decisiones cerradas (Lucas, 2026-06-29)

| # | Tema | Decisión |
|---|---|---|
| 1 | **Identificación del país** | Columna `tenant.pais` enum `('AR','UY')`, DEFAULT `'AR'` en la migration. Tenants existentes backfilleados a `'AR'` (todos los actuales son argentinos). `CHECK (pais IN ('AR','UY'))` extensible a futuro (CL/PY/MX/etc.) con migración de un solo ALTER. |
| 2 | **Selector de país en signup** | El signup público pregunta país antes de crear tenant. Default visual = AR (mercado mayoritario hoy). Selector con flag emoji + texto ("🇦🇷 Argentina" / "🇺🇾 Uruguay"). Backend recibe `pais` en el body, persiste en `tenants.pais`. Una vez creado el tenant, **el país NO se puede cambiar desde la UI**: requiere intervención del super-admin (ver decisión 8 + Open decision). |
| 3 | **TC UYU/USD** | **100% manual + default configurable por admin del tenant.** Sin API externa (BCU, exchanges, Open Exchange Rates). Sin BCU integration. Same patrón que ARS: cada tenant edita su TC default desde una pantalla nueva (`/config/tc-defaults` o tab en Cotizador). El backend persiste el último TC usado en la venta más reciente y lo devuelve como default sensato (mismo patrón que `GET /api/config/last-tc` existente para AR). |
| 4 | **Billing / pricing** | **Todos los planes siguen en USD para todos los tenants** (AR y UY). Cero cambios a `plan_prices`. La landing muestra USD para todos. Cada tenant decide cómo paga (transferencia USD, USDT, ARS al TC del día, UYU al TC del día) por fuera del producto — Tecny factura en USD. Esto evita re-cálculo de MRR por país y mantiene un único pricing. |
| 5 | **Monedas operativas habilitadas** | **AR**: ARS + USD + USDT (igual a hoy). **UY**: UYU + USD + USDT. USD y USDT habilitadas en ambos países (universales para el negocio reseller — todos pagan/cobran en USD/USDT a proveedores chinos y mayoristas). ARS NO disponible para tenants UY y UYU NO disponible para tenants AR — el dropdown filtra por `tenant.pais`. |
| 6 | **Cotizador adaptado** | El cotizador es **la pantalla más visiblemente "argentina"** del portal (texto "USD → ARS", default TC 1400, mensaje "transferencia ARS", etc.). Para UY: misma estructura, pero "USD → UYU", default TC UYU/USD, mensaje "transferencia UYU". La lógica de `1/(1-c)` aplicada a tarjetas + transferencias **no cambia** (es universal). El texto generado para el cliente (`copyText`) usa "UYU" / "$U" en lugar de "ARS" / "$". |
| 7 | **Locale y formato** | Sigue siendo `es-AR` para el formato numérico (1.234,56) — el separador es el mismo en es-UY, no se nota visualmente la diferencia. **Símbolos**: AR usa `$` (ARS) y `u$s` (USD). UY usa `$U` (UYU) y `u$s` (USD). USDT igual en ambos (`USDT `). Decisión durable: NO introducimos `es-UY` para no abrir bug surface — `toLocaleString('es-AR')` y `es-UY` son funcionalmente idénticos para nuestros formatos. Si en el futuro necesitamos divergir (porcentajes, fechas), revisar. |
| 8 | **Red B2B cross-frontera AR↔UY** | El esquema de partnerships actual NO conoce país — funciona transparente. La operación cross-tenant ya soporta moneda heterogénea: el seller fija el TC en su par (ARS/USD para AR, UYU/USD para UY) y `cross_tenant_operations.total_usd` es el anchor en USD. Lo único nuevo: la caja default cross-tenant (`tenants.red_b2b_caja_default_id`) debe ser compatible con la moneda del pago (ya validado en `redB2b/pagos.js`). Tenant AR puede recibir pago en USD/USDT de tenant UY sin que su lado tenga UYU. F5 documenta este flow + agrega un test E2E cross-frontera. |

---

## 3. Modelo de datos

### 3.1 Schema actual relevante

**Tabla `tenants`** (`backend/migrations/20260615000001_multitenant_schema.js:120-129`):

```sql
CREATE TABLE tenants (
  id          SERIAL PRIMARY KEY,
  nombre      TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE
                CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$' AND char_length(slug) BETWEEN 2 AND 40),
  plan        TEXT NOT NULL DEFAULT 'trial'
                CHECK (plan IN ('trial','starter','pro','enterprise')),
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

Hoy NO tiene noción de país. Otros campos agregados por migraciones posteriores (`paid_until`, `suspended_at`, `red_b2b_caja_default_id`, `red_b2b_email_prefs`, `custom_mrr_usd`, etc.) — todos `ALTER TABLE` aditivos.

**CHECK constraints de moneda** (distribuidos en migraciones por módulo):

- `backend/migrations/20260524000002_ventas.js`: 5 columnas `moneda TEXT NOT NULL DEFAULT 'USD'/'ARS' CHECK (moneda IN ('USD','ARS','USDT'))` en `metodos_pago`, `ventas`, `venta_pagos`, `venta_items`, `pagos`.
- `backend/migrations/20260525000002_proveedores.js`: idem en `proveedor_movimientos`.
- `backend/migrations/20260528000001_egresos_modulo.js`: idem en `egresos`.
- `backend/migrations/20260530000001_tarjetas.js`: idem en `tarjetas` (deprecada, ahora `metodos_pago`).
- `backend/migrations/20260603000004_envio_item_moneda_tc.js`: idem en `envio_items`.
- `backend/migrations/20260628100000_red_b2b_pagos_multidivisa.js`: `cross_tenant_pagos.moneda_pago CHECK IN ('USD','ARS')` (sin USDT).

**Total de tablas con CHECK moneda**: 6+ tablas críticas, todas con el mismo enum `('USD','ARS','USDT')`. Hay también `('USD','ARS')` sin USDT en algunos pocos lugares (`venta_pagos`, `pagos`).

**Helpers actuales**:
- `backend/src/lib/money.js` — `toUsd(monto, moneda, tc)`: `if (moneda === 'USD' || 'USDT') return m; if (moneda === 'ARS') return tc>0 ? m/tc : 0; return m;`. Funciona moneda-agnóstico para USD/USDT pero **hardcodea ARS** como el único caso que requiere TC.
- `frontend/src/lib/money.ts` — réplica idéntica del helper backend, con tipo `Moneda = 'ARS' | 'USD' | 'USDT'`.
- `frontend/src/lib/format.ts` — `fmtMoney(n, moneda)`: prefix `'$'` para ARS, `'u$s'` para USD, `'USDT '` para USDT, default `'u$s'`. **Hardcodea símbolo `$` = ARS.**

**Cotizador** (`frontend/src/screens/Cotizador.jsx`):
- Hardcodea "USD → ARS" en headers (línea 199, 482, 735).
- Default TC 1400 (línea 89, 363).
- Llama a `configApi.lastTc()` (en `backend/src/routes/config.js:35`) que devuelve el TC de la venta más reciente del tenant. **El endpoint NO conoce moneda** — devuelve `tc_venta` (NUMERIC) sin contexto de si es ARS/USD o UYU/USD. Hoy es siempre ARS/USD por construcción.
- Mensaje copy usa "ARS", "$", "Transferencia ARS", "Transferencia USD" (líneas 156-169, 426-446).

**`plan_prices`** (`backend/migrations/20260622153000_plan_prices_table.js`): tabla global, precios en USD. **No se toca en esta feature.**

### 3.2 Schema propuesto

#### 3.2.1 `tenants.pais`

```sql
-- Migration: 20260629100001_tenants_pais.js
ALTER TABLE tenants ADD COLUMN pais TEXT NOT NULL DEFAULT 'AR'
  CHECK (pais IN ('AR', 'UY'));

-- Backfill defensivo (todos los tenants existentes son AR; DEFAULT cubre, esto es
-- explícito para evidenciar la decisión en el audit log).
UPDATE tenants SET pais = 'AR' WHERE pais IS NULL OR pais NOT IN ('AR','UY');

COMMENT ON COLUMN tenants.pais IS
  'País del tenant. Determina moneda local habilitada, TC default y símbolo visual. AR = Argentina (ARS), UY = Uruguay (UYU). Extensible (CL/PY/MX/etc.) con ALTER del CHECK.';
```

**Justificación de TEXT vs ENUM**: PostgreSQL ENUM type requiere `ALTER TYPE ... ADD VALUE` que NO es DDL transaccional segura en algunos casos. TEXT + CHECK constraint es el patrón ya usado en el repo (`plan`, `moneda`, todos los enums) — agregar países es un único `ALTER TABLE ... DROP CONSTRAINT + ADD CONSTRAINT` en una transacción.

**Por qué DEFAULT 'AR'**: backward compatibility total. Toda la lógica existente sigue funcionando contra tenants AR sin tocar nada. Nuevos signups setean `pais` explícito (decisión 2).

#### 3.2.2 Extender CHECK moneda a UYU

Hay que extender el enum `('USD','ARS','USDT')` a `('USD','ARS','USDT','UYU')` en las 6+ tablas que lo tienen. Postgres NO permite ALTER CHECK directo — patrón estándar: `DROP CONSTRAINT + ADD CONSTRAINT`.

```sql
-- Migration: 20260629100002_moneda_check_uyu.js
-- Tablas afectadas (en este orden, cada una con su nombre de constraint real
-- que debe verificarse vía \d antes del DROP):
--
--   metodos_pago               (constraint: metodos_pago_moneda_check)
--   ventas                     (sin constraint nombrado — usa anónimo inline, hay que DROP por nombre tras lookup)
--   venta_pagos                (idem)
--   venta_items                (idem)
--   pagos                      (idem)
--   proveedor_movimientos      (idem)
--   egresos                    (idem)
--   egresos_recurrentes        (idem)
--   envio_items                (envio_items_moneda_check — único con nombre explícito)
--   cambio_movimientos         (verificar — los cambios de divisa pueden necesitar UYU)
--   tarjeta_movimientos        (verificar)
--
-- Patrón:
ALTER TABLE <tabla> DROP CONSTRAINT IF EXISTS <constraint_name>;
ALTER TABLE <tabla> ADD CONSTRAINT <tabla>_moneda_check
  CHECK (moneda IN ('USD','ARS','USDT','UYU'));
```

**Atención**: `cross_tenant_pagos.moneda_pago` en `20260628100000_red_b2b_pagos_multidivisa.js` tiene `CHECK IN ('USD','ARS')` (sin USDT, sin UYU). **F4 (Red B2B cross-frontera) extiende este CHECK a `('USD','ARS','USDT','UYU')`** para soportar que un seller UY reciba pago en UYU de un buyer UY, o que cross-frontera un buyer UY pague en USD a un seller AR (el caso más probable).

**Verificación obligatoria pre-implementación**: el subagente que implemente F1 debe correr `\d <tabla>` en una DB de staging para obtener los nombres exactos de los constraints existentes — algunos fueron creados anónimos (Postgres genera `<tabla>_moneda_check` por convención, pero en algunos casos pueden ser distintos).

#### 3.2.3 Tabla `tc_defaults_pais` (NUEVA)

Almacena el TC default editable por tenant para cada par de monedas. Por simplicidad inicial, solo `<moneda_local>/USD` (no necesitamos UYU/ARS directamente — pasa por USD como anchor).

```sql
-- Migration: 20260629100003_tc_defaults_pais.js
CREATE TABLE tc_defaults (
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  moneda_local TEXT    NOT NULL CHECK (moneda_local IN ('ARS','UYU')),
  -- TC: cuántas unidades de moneda_local equivalen a 1 USD.
  -- Ej. AR: tc=1400 significa 1400 ARS = 1 USD.
  -- Ej. UY: tc=40 significa 40 UYU = 1 USD.
  tc           NUMERIC(14, 4) NOT NULL CHECK (tc > 0),
  -- Notas libres del operador ("subió 3% por inflación junio 2026").
  notes        TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,

  PRIMARY KEY (tenant_id, moneda_local)
);

CREATE INDEX idx_tc_defaults_tenant ON tc_defaults(tenant_id);

-- RLS estándar (mismo patrón que el resto del schema multi-tenant).
ALTER TABLE tc_defaults ENABLE ROW LEVEL SECURITY;
CREATE POLICY tc_defaults_select ON tc_defaults FOR SELECT USING (
  tenant_id = current_setting('app.current_tenant', true)::int
);
CREATE POLICY tc_defaults_modify ON tc_defaults FOR ALL USING (
  tenant_id = current_setting('app.current_tenant', true)::int
);

COMMENT ON TABLE tc_defaults IS
  'TC default editable por tenant para conversiones moneda_local↔USD. Manual 100%, sin API externa. Lookup default cuando no hay historia de ventas reciente.';
```

**Por qué tabla nueva en vez de columna en `tenants`**: extensible si en el futuro un tenant opera con más de una moneda local (caso edge — un revendedor UY que también factura ARS para clientes argentinos). PK compuesta `(tenant_id, moneda_local)` permite múltiples filas por tenant sin schema change.

**Por qué NO `tc_defaults_pais` global** (un único TC por país): cada tenant tiene su propia perspectiva del TC (un revendedor que opera con dólar MEP vs dólar oficial vs blue), incluso en el mismo país. Mantenerlo por tenant es la postura solidez/escalabilidad correcta — un día el cliente UY pedirá editarlo desde su admin y el schema ya lo soporta.

**Seed**: al ejecutar la migration, NO seedeamos filas. El primer lookup del backend (sección 4.3) cae al fallback (1400 para AR, 40 para UY) y persiste si el admin lo edita.

#### 3.2.4 Cambios a `cross_tenant_pagos` (F4)

```sql
-- Migration: 20260630000001_cross_tenant_pagos_uyu.js (parte de F4)
ALTER TABLE cross_tenant_pagos DROP CONSTRAINT cross_tenant_pagos_moneda_pago_check;
ALTER TABLE cross_tenant_pagos ADD CONSTRAINT cross_tenant_pagos_moneda_pago_check
  CHECK (moneda_pago IN ('USD','ARS','USDT','UYU'));
```

### 3.3 RLS / multi-tenant impact

**`tenants.pais` NO tiene impacto RLS**: la columna está en una tabla que filtra indirectamente vía `tenant_users` (no tiene RLS policy propia — el acceso se controla por endpoint con `req.tenantId`). El campo `pais` lo lee el backend en cada request al cargar el contexto del tenant (igual que `plan`, `paid_until`, etc.).

**`tc_defaults` SÍ tiene RLS**: sigue el patrón del resto del schema. Importante para defensa: si un tenant AR intenta leer/escribir el TC de un tenant UY, el RLS lo rechaza incluso si hay un bug en el endpoint.

**Red B2B cross-frontera**: las queries `BYPASSRLS` que escriben en ambos lados de una partnership ya están auditadas (sección 9 doc Red B2B). El `tc_defaults` se consulta del lado del seller (que fija el TC), entonces se lee con `app.current_tenant = seller_tenant_id` — RLS aplica correctamente.

### 3.4 Migration plan

Orden secuencial estricto. Cada migration es reversible y no rompe deploys intermedios.

```
20260629100001_tenants_pais.js
  → ADD COLUMN tenants.pais NOT NULL DEFAULT 'AR' CHECK (...).
  → Backfill UPDATE (redundante con DEFAULT, evidencia explícita).
  → COMMENT.

20260629100002_moneda_check_uyu.js
  → DROP + ADD CONSTRAINT en cada tabla con CHECK moneda (verificar nombres reales).
  → NO toca data — solo extiende el enum válido.
  → Reversible: revertir CHECK al enum original (pero requiere DELETE de filas con moneda='UYU' previo).

20260629100003_tc_defaults_pais.js
  → CREATE TABLE tc_defaults.
  → ENABLE RLS + 2 policies (select + ALL).
  → Sin seed (lookup cae a fallback hasta que el admin edite).

20260629100004_tenant_admin_actions_add_pais_change.js
  → ADD 'tenant_pais_change' al CHECK de tenant_admin_actions.action.
  → Para audit del super-admin si en el futuro hay que cambiar el país de un tenant
    (caso edge — ver Open decisions).

[F4]
20260630000001_cross_tenant_pagos_uyu.js
  → DROP + ADD CONSTRAINT cross_tenant_pagos.moneda_pago para incluir UYU + USDT.
```

**Test obligatorio**: el repo ya tiene `backend/tests/migrations-rls-nosuperuser.test.js` que valida que las migraciones corren bajo el role `ipro_app` NOSUPERUSER (TANDA 0c). Las 4 migraciones nuevas deben ser tested ahí — pasar limpio sin requerir BYPASSRLS.

---

## 4. Backend

### 4.1 Helpers de moneda

#### 4.1.1 `backend/src/lib/money.js`

Hoy `toUsd(monto, moneda, tc)` hardcodea ARS como la única moneda que requiere TC. Extender a UYU:

```javascript
function toUsd(monto, moneda, tc) {
  const m = Number(monto) || 0;
  if (moneda === 'USD' || moneda === 'USDT') return m;
  // ARS y UYU son monedas locales que requieren TC para convertir a USD.
  // Mismo tratamiento: dividir por TC. Si TC inválido, devolver 0 (no NaN).
  if (moneda === 'ARS' || moneda === 'UYU') {
    return tc && Number(tc) > 0 ? m / Number(tc) : 0;
  }
  return m;
}
```

**Decisión durable**: NO introducimos un parámetro `pais` al helper. La moneda lleva toda la información (`ARS` implica país AR, `UYU` implica UY). Si en el futuro hay moneda compartida entre países, esto se reconsiderará.

#### 4.1.2 `backend/src/lib/pais.js` (NUEVO)

Helper centralizado para lookups de configuración por país:

```javascript
// backend/src/lib/pais.js

/** Lista canónica de países soportados. Sincronizar con el CHECK constraint. */
const PAISES = ['AR', 'UY'];

/** Moneda local por país. */
const MONEDA_LOCAL_POR_PAIS = {
  AR: 'ARS',
  UY: 'UYU',
};

/** Monedas operativas habilitadas por país. USD + USDT son universales. */
const MONEDAS_POR_PAIS = {
  AR: ['ARS', 'USD', 'USDT'],
  UY: ['UYU', 'USD', 'USDT'],
};

/** TC fallback por país cuando no hay venta reciente ni default editado. */
const TC_FALLBACK_POR_PAIS = {
  AR: 1400,  // mismo fallback histórico de Cotizador (hardcoded 2026-06-25 #445).
  UY: 40,    // sensato para UYU/USD 2026 (UYU ~ 38-42 por USD).
};

function getMonedaLocal(pais) {
  return MONEDA_LOCAL_POR_PAIS[pais] || 'ARS';  // fallback defensivo.
}

function getMonedasOperativas(pais) {
  return MONEDAS_POR_PAIS[pais] || MONEDAS_POR_PAIS.AR;
}

function getTcFallback(pais) {
  return TC_FALLBACK_POR_PAIS[pais] || 1400;
}

function isMonedaValidaParaPais(pais, moneda) {
  return getMonedasOperativas(pais).includes(moneda);
}

module.exports = {
  PAISES,
  getMonedaLocal,
  getMonedasOperativas,
  getTcFallback,
  isMonedaValidaParaPais,
};
```

**Por qué centralizado**: cada decisión "qué monedas habilita UY" o "qué TC default uso" debe responderse en un solo lugar. Si mañana UY también habilita BRL (revendedores que importan de Brasil), se cambia acá y el resto del backend lo absorbe.

#### 4.1.3 Carga de `pais` en el contexto del request

Hoy `req.tenantId` se setea en `withTenant` middleware. Para evitar SELECT extra por cada endpoint que necesite el país, **agregamos `pais` al payload del JWT** (igual que `tenant_id` y `tenant_rol` actuales).

Cambios:
- `backend/src/routes/auth.js` (`POST /login`, `POST /signup`): incluir `pais` en el JWT payload.
- `backend/src/lib/auth.js` (middleware): exponer `req.tenantPais` desde el JWT.
- `backend/src/routes/auth.js` (`GET /me`): incluir `pais` en la response (para que el frontend lo lea).

**Trade-off**: el JWT crece ~3 bytes. Justificado vs. SELECT extra por request.

**Migración del JWT existente**: usuarios con JWT viejo (sin `pais`) no son rechazados — el middleware lee `req.tenantPais = decoded.pais || 'AR'` (fallback AR, válido para todos los users existentes). Cuando renuevan token (re-login o refresh), el nuevo JWT incluye `pais`.

### 4.2 Validaciones Zod por país

Las 5+ schemas de Zod hardcodean `z.enum(['USD','ARS','USDT'])`. Necesitamos validación dinámica por país del tenant:

**Opción A — Schema fija extendida (RECOMENDADA)**:

```javascript
// backend/src/schemas/_shared.js (NUEVO archivo compartido)
const { z } = require('zod');

// Enum global de monedas válidas en cualquier país soportado.
// La validación POR PAÍS se hace en el handler vía isMonedaValidaParaPais().
const MonedaEnum = z.enum(['USD', 'ARS', 'USDT', 'UYU']);

module.exports = { MonedaEnum };
```

Reemplazar las 5+ ocurrencias `z.enum(['USD','ARS','USDT'])` por `MonedaEnum`. En cada handler que recibe `moneda` del body, agregar:

```javascript
const { isMonedaValidaParaPais } = require('../lib/pais');

// ... dentro del handler:
if (!isMonedaValidaParaPais(req.tenantPais, body.moneda)) {
  return res.status(400).json({
    error: 'moneda_no_habilitada_para_pais',
    details: { pais: req.tenantPais, moneda: body.moneda },
  });
}
```

**Por qué A y no validación dinámica en Zod**: la validación Zod tiene que ser estática (no depende de `req`) para que `validate(schema)` funcione antes del handler. La validación por país es una check de policy del negocio, NO de shape — corresponde al handler, después del parse.

**Listado de schemas a actualizar (5 archivos)**:
- `backend/src/schemas/ventas.js` (4 ocurrencias)
- `backend/src/schemas/cajas.js` (2 ocurrencias)
- `backend/src/schemas/egresos.js` (3 ocurrencias)
- `backend/src/schemas/envios.js` (1 ocurrencia)
- `backend/src/schemas/_shared.js` (NUEVO — la fuente única)

**Schemas en `redB2b/`**: `partnerships.js`, `pagos.js`, `operations.js`. Revisar — `pagos.js` tiene `moneda_pago` con enum propio que también se extiende en F4.

### 4.3 TC default lookup por país

#### 4.3.1 Refactor de `GET /api/config/last-tc`

Hoy `backend/src/routes/config.js:35` devuelve el TC de la venta más reciente, asumiendo ARS/USD. Refactor:

```javascript
router.get('/last-tc', async (req, res, next) => {
  try {
    const monedaLocal = getMonedaLocal(req.tenantPais);  // 'ARS' o 'UYU'

    const tc = await db.withTenant(req.tenantId, async (client) => {
      // 1. Buscar TC en venta reciente con moneda local del país (últimos 90d).
      const { rows } = await client.query(
        `SELECT tc_venta
           FROM ventas
          WHERE tc_venta IS NOT NULL
            AND moneda = $1
            AND deleted_at IS NULL
            AND created_at >= NOW() - INTERVAL '90 days'
          ORDER BY created_at DESC
          LIMIT 1`,
        [monedaLocal]
      );
      if (rows[0]?.tc_venta) return { tc: Number(rows[0].tc_venta), source: 'venta' };

      // 2. Lookup default editable en tc_defaults.
      const { rows: defaults } = await client.query(
        `SELECT tc FROM tc_defaults WHERE tenant_id = $1 AND moneda_local = $2`,
        [req.tenantId, monedaLocal]
      );
      if (defaults[0]?.tc) return { tc: Number(defaults[0].tc), source: 'default_admin' };

      // 3. Fallback hardcoded (1400 AR, 40 UY).
      return { tc: getTcFallback(req.tenantPais), source: 'fallback' };
    });

    res.json({
      ...tc,
      moneda_local: monedaLocal,
      pais: req.tenantPais,
      computed_at: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});
```

**Backward compat**: el endpoint mantiene la shape `{ tc, source, computed_at }` y agrega `moneda_local` + `pais`. Frontend existente sigue funcionando (lee `tc` solamente). Frontend nuevo lee `moneda_local` para mostrar contexto.

#### 4.3.2 Nuevo endpoint admin: `GET/PATCH /api/config/tc-default`

Para que el admin del tenant edite el TC default desde la UI:

```javascript
// GET: lista los defaults del tenant (puede haber varios si el día de mañana
// un tenant UY también factura ARS — la PK compuesta lo soporta).
router.get('/tc-default', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT moneda_local, tc, notes, updated_at, updated_by
           FROM tc_defaults
          WHERE tenant_id = $1
          ORDER BY moneda_local`,
        [req.tenantId]
      );
      return rows;
    });
    res.json({ defaults: rows, pais: req.tenantPais });
  } catch (err) { next(err); }
});

// PATCH: upsert del default para una moneda local.
// Body: { moneda_local: 'UYU' | 'ARS', tc: number, notes?: string }
// Auth: adminOnly (cap 'config.write' o rol owner).
router.patch('/tc-default', adminOnly, validate(tcDefaultSchema), async (req, res, next) => {
  const { moneda_local, tc, notes } = req.body;

  // Defensa: la moneda local debe corresponder al país del tenant.
  if (moneda_local !== getMonedaLocal(req.tenantPais)) {
    return res.status(400).json({
      error: 'moneda_no_corresponde_pais',
      details: { pais: req.tenantPais, moneda_local },
    });
  }

  try {
    const result = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO tc_defaults (tenant_id, moneda_local, tc, notes, updated_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, moneda_local) DO UPDATE
           SET tc = EXCLUDED.tc,
               notes = EXCLUDED.notes,
               updated_at = NOW(),
               updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [req.tenantId, moneda_local, tc, notes || null, req.user.id]
      );
      return rows[0];
    });
    res.json(result);
  } catch (err) { next(err); }
});
```

**Schema Zod**:
```javascript
// backend/src/schemas/config.js (extender)
const tcDefaultSchema = z.object({
  moneda_local: z.enum(['ARS', 'UYU']),
  tc:           z.coerce.number().positive().max(1_000_000),  // sanity cap
  notes:        z.string().trim().max(500).optional().nullable(),
}).strict();
```

**Audit**: este PATCH NO necesita entry en `tenant_admin_actions` (ese audit es para super-admin actions). Sí necesita `audit_logs` entry estándar via el helper `audit()` — patrón ya usado en el resto de config.

### 4.4 Validación de moneda contra país en escrituras

En cada endpoint que inserta filas con `moneda` (ventas, egresos, etc.), después del parse Zod agregar la check explícita:

```javascript
if (!isMonedaValidaParaPais(req.tenantPais, body.moneda)) {
  return res.status(400).json({
    error: 'moneda_no_habilitada_para_pais',
    details: { pais: req.tenantPais, moneda: body.moneda },
  });
}
```

**Endpoints afectados** (lista no exhaustiva — el subagente F2 hace `grep -rn "body.moneda" backend/src/routes/`):
- `POST /api/ventas`, `PUT /api/ventas/:id`
- `POST /api/egresos`, `PUT /api/egresos/:id`
- `POST /api/envios`, `PUT /api/envios/:id`
- `POST /api/cajas`, `PUT /api/cajas/:id`
- `POST /api/proveedores/.../compras`
- `POST /api/cambios/.../movimientos` (cambios de divisa — UYU↔USD relevante en UY)

**Trade-off ergonomía**: 8+ endpoints con la misma validación. Considerar middleware factory `requireMonedaValidaPara(req.tenantPais)` — pero la validación es trivial y depende del shape de cada body (a veces `moneda`, a veces `monedas` array). F2 evalúa si crear helper o inline.

### 4.5 Red B2B cross-frontera AR↔UY

#### 4.5.1 Compatibilidad de partnerships

`tenant_partnerships` (definido en `docs/design/red-b2b-cross-tenant.md` sección 4.1) NO conoce país — solo IDs. Una partnership entre tenant AR (id=5) y tenant UY (id=12) es estructuralmente idéntica a una AR↔AR.

**Nada que cambiar en el schema partnerships.**

#### 4.5.2 Creación de operación cross-frontera (`POST /api/red-b2b/operations`)

El handler (en `backend/src/routes/redB2b/operations.js`) toma del body: `partnership_id`, `items`, `tc`, `total_usd`, `total_ars`. **El nombre `total_ars` es ahora misleading cross-frontera** — debería ser `total_moneda_local_seller` o pasar a `total_usd` como único anchor.

**Decisión durable**: F5 introduce `total_moneda_local_seller NUMERIC(14,2)` como columna en `cross_tenant_operations` (puede ser ARS o UYU según `pais` del seller) y deja `total_ars` como **alias deprecated** que se llena por compatibilidad con el frontend viejo. La nueva columna se chequea contra `pais` del seller en el INSERT.

```sql
-- Migration F5: 20260630000002_cross_tenant_ops_moneda_local.js
ALTER TABLE cross_tenant_operations
  ADD COLUMN total_moneda_local_seller NUMERIC(14, 2);

-- Backfill: las ops existentes (todas AR↔AR hoy) tienen total_ars.
UPDATE cross_tenant_operations SET total_moneda_local_seller = total_ars
  WHERE total_moneda_local_seller IS NULL;

ALTER TABLE cross_tenant_operations ALTER COLUMN total_moneda_local_seller SET NOT NULL;

-- total_ars NO se dropea (compat). Se documenta como deprecated.
COMMENT ON COLUMN cross_tenant_operations.total_ars IS
  'DEPRECATED multi-país (2026-06-30): usar total_moneda_local_seller. Backfilled = total_moneda_local_seller para tenants AR. Para tenants UY, contiene el total en UYU (mal nombrado, kept for backward compat con queries legacy).';
```

#### 4.5.3 Caja default cross-tenant

`tenants.red_b2b_caja_default_id` (creada en `20260628100000_red_b2b_pagos_multidivisa.js`) apunta a una caja del tenant que recibe el pago propagado del otro lado. **El validador de compatibilidad de moneda ya existe** (`redB2b/pagos.js:240-250` chequea `caja.moneda === 'ARS'` vs `'USD'/'USDT'`).

**Cambio necesario**: extender el check a UYU. Hoy:
```javascript
const cajaCompat = body.moneda_pago === 'ARS'
  ? callerCaja.moneda === 'ARS'
  : (callerCaja.moneda === 'USD' || callerCaja.moneda === 'USDT');
```

Después:
```javascript
const cajaCompat = (
  // Moneda local: AR↔ARS, UY↔UYU.
  (body.moneda_pago === 'ARS'  && callerCaja.moneda === 'ARS') ||
  (body.moneda_pago === 'UYU'  && callerCaja.moneda === 'UYU') ||
  // Monedas universales: USD/USDT son compatibles con caja USD o USDT.
  ((body.moneda_pago === 'USD' || body.moneda_pago === 'USDT') &&
   (callerCaja.moneda === 'USD' || callerCaja.moneda === 'USDT'))
);
```

#### 4.5.4 Flow seller AR ↔ buyer UY (ejemplo del happy path)

```
SELLER (AR, pais=AR)                              BUYER (UY, pais=UY)
─────────────                                     ───────────────
Lucas (AR) carga venta cross-tenant:
  partnership_id: 42 (AR↔UY)
  items: 10× iPhone 15 Pro, USD 950 c/u
  tc (ARS/USD): 1400  ← el SELLER pone su TC
  total_usd: 9500
  total_moneda_local_seller: 13_300_000  ← ARS

  Backend (BYPASSRLS):
    1. Carga partnership → ambos tenants activos.
    2. SET LOCAL current_tenant = seller (AR).
       INSERT venta AR en moneda='USD' con tc_venta=1400.
       Stock decrement.
    3. SET LOCAL current_tenant = buyer (UY).
       Para cada item: auto-create producto con flag pending_review.
       INSERT compra UY en moneda='USD' (NO en UYU — el buyer ve la deuda en USD,
       que es la moneda anchor de la operación). Stock increment.
    4. INSERT cross_tenant_operations:
         total_usd=9500
         total_moneda_local_seller=13_300_000 (ARS — perspectiva seller)
         tc_used=1400 (ARS/USD)
    5. Notification al buyer UY: "iPro AR te envió una venta de USD 9500".
    6. COMMIT.
                                                  Ve operación cross-tenant.
                                                  Su CC con iPro: USD 9500 deuda.
                                                  Stock subió +10 iPhones.

[Pago — el buyer UY paga en USD]
                                                  Buyer UY registra pago:
                                                    monto_pago: 9500
                                                    moneda_pago: 'USD'
                                                    tc_pago: N/A (USD = USD, no aplica)
                                                    caja_id: 7 (caja USD del buyer)

                                                  Backend:
                                                    1. Valida caja UY moneda='USD' compat con moneda_pago='USD'.
                                                    2. SET LOCAL current_tenant = buyer.
                                                       Egreso de la caja USD del buyer.
                                                       CC con iPro baja a 0.
                                                    3. SET LOCAL current_tenant = seller.
                                                       Lookup caja default seller compatible con USD.
                                                       Si la default es ARS → 400 'caja_no_compat'
                                                       (el seller AR tiene que tener una caja USD/USDT como default
                                                        cross-tenant, configurable en /red-b2b/config).
                                                       Si OK: ingreso a esa caja USD del seller.
                                                       CC con buyer baja a 0.
                                                    4. INSERT cross_tenant_pagos con
                                                       moneda_pago='USD', diferencia_cambiaria=0
                                                       (no aplica porque la venta y el pago son ambos USD).
                                                    5. COMMIT.
```

**Caso alternativo — buyer UY paga en UYU** (menos común, pero válido):
- `moneda_pago='UYU'`, `tc_pago` = UYU/USD del día del pago.
- Caja default del buyer UY debe ser UYU.
- Caja default del seller AR debe ser USD/USDT (NO ARS — la diferencia cambiaria UYU→USD→ARS sería una pesadilla; el seller cobra en USD y conviene a su sistema).
- `cross_tenant_pagos.diferencia_cambiaria` se calcula contra `tc_venta=1400 ARS/USD` solo si `moneda_pago='ARS'` — para UYU, la diferencia es siempre 0 (porque el seller AR NO opera UYU como moneda local — la operación quedó cerrada en USD).

Este edge case se documenta en F5 con un test explícito.

### 4.6 Cambios a `GET /api/auth/me`

Agregar `pais` a la response (el frontend lo necesita para configurar dropdowns):

```javascript
res.json({
  user: { id, nombre, email, role, ... },
  tenant: {
    id, nombre, slug, plan, paid_until,
    pais: tenant.pais,           // ← NUEVO
    moneda_local: getMonedaLocal(tenant.pais),  // ← NUEVO (conveniencia)
  },
  // ...
});
```

---

## 5. Frontend

### 5.1 Símbolo y formato UYU

#### 5.1.1 Extender `frontend/src/lib/format.ts`

```typescript
export type Moneda = 'ARS' | 'USD' | 'USDT' | 'UYU';

export function fmtMoney(n: MontoInput, moneda?: Moneda | string | null): string {
  let prefix: string;
  if (moneda === 'ARS') prefix = '$';
  else if (moneda === 'UYU') prefix = '$U';   // ← NUEVO. Convención UY: $U separa visualmente.
  else if (moneda === 'USDT') prefix = 'USDT ';
  else prefix = 'u$s'; // USD y default
  return prefix + fmt(n);
}
```

**Decisión durable**: `$U` (con U) es el símbolo estándar UY. La alternativa `$U ` (con espacio) o `UYU ` se descarta — el espacio rompe la alineación tabular y `UYU` extenso ocupa demasiado en grillas densas.

#### 5.1.2 Locale `es-AR` se mantiene

NO introducimos `es-UY` en `toLocaleString`. Visualmente idéntico (separador `.` miles, `,` decimal en ambos). Si el día de mañana hay divergencia que importe (formato de fechas, porcentajes), se evalúa.

#### 5.1.3 Extender `frontend/src/lib/money.ts`

```typescript
export type Moneda = 'ARS' | 'USD' | 'USDT' | 'UYU';

export function toUsd(monto: NumInput, moneda: Moneda | string | null | undefined, tc: NumInput): number {
  const m = Number(monto) || 0;
  if (moneda === 'USD' || moneda === 'USDT') return m;
  if (moneda === 'ARS' || moneda === 'UYU') return tc && Number(tc) > 0 ? m / Number(tc) : 0;
  return m;
}
```

#### 5.1.4 Helper frontend `frontend/src/lib/pais.ts` (NUEVO)

```typescript
// frontend/src/lib/pais.ts
export type Pais = 'AR' | 'UY';
export type Moneda = 'ARS' | 'USD' | 'USDT' | 'UYU';

export const MONEDAS_POR_PAIS: Record<Pais, Moneda[]> = {
  AR: ['ARS', 'USD', 'USDT'],
  UY: ['UYU', 'USD', 'USDT'],
};

export const MONEDA_LOCAL_POR_PAIS: Record<Pais, Moneda> = {
  AR: 'ARS',
  UY: 'UYU',
};

export const PAIS_LABEL: Record<Pais, string> = {
  AR: '🇦🇷 Argentina',
  UY: '🇺🇾 Uruguay',
};

export function getMonedasOperativas(pais: Pais | string | undefined): Moneda[] {
  return MONEDAS_POR_PAIS[pais as Pais] || MONEDAS_POR_PAIS.AR;
}

export function getMonedaLocal(pais: Pais | string | undefined): Moneda {
  return MONEDA_LOCAL_POR_PAIS[pais as Pais] || 'ARS';
}
```

### 5.2 Dropdowns de moneda gating por `tenant.pais`

`grep -rn "<option>ARS</option>" frontend/src/` da ~25 ocurrencias en 8 archivos. Todas son dropdowns hardcoded.

**Patrón actual** (e.g. `frontend/src/screens/Ventas.jsx:1119`):
```jsx
<select value={it.moneda} onChange={...}>
  <option>USD</option><option>ARS</option>
</select>
```

**Patrón propuesto**:
```jsx
// Al inicio del archivo:
import { useAuth } from '../contexts/AuthContext';
import { getMonedasOperativas } from '../lib/pais';

// Dentro del componente:
const { user } = useAuth();
const monedas = getMonedasOperativas(user?.tenant?.pais);

// Render:
<select value={it.moneda} onChange={...}>
  {monedas.map(m => <option key={m} value={m}>{m}</option>)}
</select>
```

**Archivos afectados** (con el conteo aproximado de ocurrencias):
- `frontend/src/screens/Ventas.jsx` (2)
- `frontend/src/screens/Envios.jsx` (2)
- `frontend/src/screens/Inventario.jsx` (4 — costo/precio dropdowns)
- `frontend/src/screens/RecepcionStock.jsx` (4)
- `frontend/src/screens/Sanidad.jsx` (1)
- `frontend/src/screens/Tarjetas.jsx` (selects mostrando cajas filtradas por moneda — revisar lógica de filtrado)
- `frontend/src/screens/Financiera.jsx` (1)
- `frontend/src/screens/Conciliacion.jsx` (1, ya muestra caja moneda)
- `frontend/src/screens/Proveedores.jsx` (1, ya muestra caja moneda)

**Default value**: cuando el dropdown se inicializa por primera vez en un componente nuevo, el default debe ser la moneda local (ARS para AR, UYU para UY) o USD según la lógica del módulo (Inventario ya defaultea a USD para precio costo, eso es independiente del país).

### 5.3 Banner / indicación visual del país

**Decisión durable**: NO mostramos banner persistente "Estás operando en pesos uruguayos". Es ruido visual. **En su lugar**:
- En el topbar (donde aparece el nombre del tenant), agregar una flag emoji al lado: `iPro UY 🇺🇾` o `Tecny Tech 🇦🇷`. Sutil pero contextual.
- En el sidebar (footer del menú), tooltip al hover muestra "País: Uruguay · Moneda local: UYU".
- En modales que cargan operaciones críticas (alta venta, alta egreso), el placeholder de moneda muestra "Moneda local: UYU" como hint.

### 5.4 Cotizador adaptation para UY

`frontend/src/screens/Cotizador.jsx` requiere cambios contenidos. Hoy todo dice "ARS" — hay que parametrizar por `user.tenant.pais` (que ya viene en `/api/auth/me` post F1).

**Cambios concretos**:

1. **Default TC** (líneas 89, 363): el state inicial sigue siendo `useState(0)`, y el `useEffect` con `configApi.lastTc()` ahora hidrata con el TC correcto (ya parametrizado por país en el backend, sección 4.3.1). El fallback duro `1400` se elimina del frontend — viene del backend.

2. **Headers y labels**:

   ```jsx
   // Antes (línea 199):
   <div className="field-label">Tipo de cambio (USD → ARS)</div>

   // Después:
   const monedaLocal = getMonedaLocal(user?.tenant?.pais);
   <div className="field-label">Tipo de cambio (USD → {monedaLocal})</div>
   ```

3. **Tab "USD → ARS"** (línea 735): pasa a `USD → ${monedaLocal}` (e.g. "USD → UYU").

4. **`copyText` y `copyUsd`** (líneas 152-190 y 424-450): el mensaje generado para el cliente usa "$" + "ARS" + "Transferencia ARS". Refactor:

   ```jsx
   const symbolLocal = monedaLocal === 'UYU' ? '$U' : '$';
   txt += `- Precio: USD ${fmt(p.usd)} | TC ${symbolLocal}${fmt(tc)}\n\n`;
   txt += `- Contado en pesos ${monedaLocal}: ${symbolLocal}${fmt(contado)}\n`;
   txt += `- Transferencia ${monedaLocal}: ${symbolLocal}${fmt(transf)}\n\n`;
   ```

5. **Mensaje "recomendamos llamar previamente a tu banco"** (línea 183): es universal, no cambia.

6. **Frase de Google** (`buildGoogleLine`): ya es per-tenant via `tenantProfile.get()`, no necesita cambios.

7. **Tab `usd`**: ya hace USD → ARS con check de "Transferencia ARS" / "Transferencia USD". Reemplaza "ARS" por `monedaLocal` y "$" por `symbolLocal` en los labels y mensajes.

**Decisión durable**: NO renombramos el tab "USD → ARS" a algo genérico tipo "USD → Local" — preferimos mostrar la moneda real ("USD → UYU") para que el operador sepa qué está cotizando. El componente Cotizador es una pantalla universal con texto dinámico, no un componente AR específico con feature flag UY.

### 5.5 Signup flow selector de país

`frontend/src/screens/Signup.jsx`: agregar selector de país antes del campo "Nombre de empresa".

**Diseño**:
- Dos cards radio button (visual): "🇦🇷 Argentina" / "🇺🇾 Uruguay".
- Default visual: AR (mercado mayoritario).
- Below: hint "Vas a operar en {moneda_local del país elegido}. Podés vender/comprar también en USD y USDT en cualquier caso."

**Cambios body del POST `/signup`**:
- Agregar `pais: 'AR' | 'UY'`.
- Backend valida con Zod (`pais: z.enum(['AR','UY'])`).
- Backend persiste en `tenants.pais` (`INSERT INTO tenants (..., pais) VALUES (..., $3)`).

**Schema Zod del signup** (`backend/src/schemas/signup.js`):
```javascript
const signupSchema = z.object({
  nombre: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: passwordField(),
  tenant_nombre: z.string().trim().min(2).max(80),
  pais: z.enum(['AR', 'UY']).default('AR'),  // ← NUEVO
  hcaptcha_response: z.string().trim().max(10_000).optional(),
}).strict();
```

**Backend `signup.js:211`**:
```javascript
const { rows: [tenant] } = await client.query(
  `INSERT INTO tenants (nombre, slug, plan, pais) VALUES ($1, $2, 'trial', $3)
   RETURNING id, nombre, slug, plan, pais`,
  [tenant_nombre, slug, pais]
);
```

**Tests**:
- Signup AR (sin `pais` en body) → tenant creado con `pais='AR'` (default funciona).
- Signup UY (con `pais: 'UY'`) → tenant creado con `pais='UY'`.
- Signup con `pais: 'CL'` → 400 (Zod rechaza).

### 5.6 Pantalla "TC defaults" en config

Para que el admin del tenant edite el TC default UYU/USD (o ARS/USD para AR, también útil):

**Ubicación**: tab nueva en Cotizador (al lado de "Configuración" que ya existe), o subpestaña en Config. **Decisión durable**: tab en Cotizador. El Cotizador YA es la pantalla mental "qué TC usamos hoy" — tener ahí el editor es contextual.

**UI mínima**:
- Lista de defaults del tenant (1 fila para UY, 1 para AR, dependiendo del país).
- Para cada uno: input `tc` editable, textarea `notes`, botón "Guardar".
- Read-only para non-admin (mismo patrón que `BusinessProfileSection`).

**Endpoint llamado**: `GET/PATCH /api/config/tc-default` (sección 4.3.2).

---

## 6. Flow examples

### 6.1 Tenant UY: alta venta retail en UYU

```
Operador UY (tenant_id=12, pais='UY') carga venta:
  POST /api/ventas
  body: {
    moneda: 'UYU',
    items: [{ producto_id: 88, cantidad: 1, precio_unit: 38_000 }],
    pagos: [{ metodo_id: 3, monto: 38_000, moneda: 'UYU', tc: 40 }]
  }

Backend:
  1. Zod parse (MonedaEnum extendido — UYU pasa).
  2. isMonedaValidaParaPais('UY', 'UYU') → true. OK.
  3. SET LOCAL current_tenant = 12.
  4. INSERT venta con moneda='UYU', tc_venta=40.
     toUsd(38000, 'UYU', 40) → 950 USD (anchor interno).
  5. INSERT venta_items, decrement stock.
  6. INSERT cobro en caja UYU del tenant 12.
  7. COMMIT.
```

**Frontend**: el dropdown de moneda en `Ventas.jsx` mostró `[UYU, USD, USDT]` (no ARS — gated por `tenant.pais='UY'`). Al elegir UYU, el TC default cargado fue 40 (de `GET /api/config/last-tc` que devolvió `{tc: 40, moneda_local: 'UYU', source: 'default_admin'}`).

### 6.2 Tenant UY: alta venta en USD con TC manual

```
Operador UY carga venta en USD (más común que UYU para reseller, importan).
  POST /api/ventas
  body: {
    moneda: 'USD',
    items: [{ producto_id: 88, cantidad: 1, precio_unit: 950 }],
    pagos: [{ metodo_id: 5, monto: 950, moneda: 'USD' }]
  }

Backend:
  - moneda='USD' → válido para UY (USD está en MONEDAS_POR_PAIS.UY).
  - INSERT venta en USD. tc_venta NULL (no aplica conversión).
  - Cobro en caja USD del tenant 12.
```

### 6.3 Red B2B: AR vende a UY, cobra en USD

Ver flow detallado en sección 4.5.4.

**Resumen**:
- Seller AR (id=5, pais=AR) crea op con `tc=1400 (ARS/USD)`, `total_usd=9500`, `total_moneda_local_seller=13_300_000` (ARS).
- Buyer UY (id=12, pais=UY) recibe la op con CC en USD por 9500.
- Pago en USD: caja USD del buyer → caja USD del seller. Sin diferencia cambiaria (ambas son USD).
- Sin necesidad de que el seller AR conozca UYU ni el buyer UY conozca ARS.

### 6.4 Tenant AR migrando a UY (caso edge) — NO soportamos

**Decisión durable**: el país del tenant es **inmutable post-signup** desde la UI. Cambiar `tenant.pais` post-hoc rompería:
- Historial de ventas en ARS sin clarificar cuándo cambió el contexto.
- TC defaults persistidos.
- Cajas existentes en ARS quedarían "huérfanas" (ARS no habilitada para UY).
- Red B2B partnerships: el otro lado pensaría que está partnership-eado con AR, ahora es UY.

**Si Lucas necesita resolver un caso real** (tenant que se equivocó al signup): super-admin script manual con backup + audit. Endpoint expuesto sólo a super-admin, audit en `tenant_admin_actions` con action `tenant_pais_change` (creada en migration 20260629100004). NO se expone en UI normal.

---

## 7. Edge cases y decisiones secundarias

### 7.1 Tenant UY con caja en ARS (legado o por error)

Hoy NO existe (no hay tenants UY). Post-feature: si por un bug o data migration un tenant UY termina con una caja en ARS, el dropdown `Ventas.jsx` no la ofrecerá (gated por `getMonedasOperativas('UY')`). La caja sigue existiendo en DB pero queda inaccesible desde la UI. Cleanup manual via super-admin.

**Defensa adicional**: en el POST de venta, el backend chequea que la moneda de la caja seleccionada esté en `getMonedasOperativas(tenantPais)`. Sino, 400 `moneda_caja_no_habilitada`.

### 7.2 USDT cross-país

USDT no tiene TC con USD (1 USDT ≈ 1 USD para el negocio reseller — la diferencia de basis points es contable, no operativa). Helper `toUsd(monto, 'USDT', tc)` devuelve `monto` tal cual. Igual en AR y UY.

### 7.3 Conversión ARS↔UYU directa

NO se soporta. Para ambos hay que pasar por USD:
- AR opera USD/ARS.
- UY opera USD/UYU.
- Red B2B cross-frontera usa USD como anchor (decisión cerrada en doc Red B2B sección 3 #4).

Si en el futuro un tenant pide "vender en ARS a un cliente uruguayo" desde su tenant AR (caso muy edge), se le indica que use USD como intermediario manualmente.

### 7.4 Locale UY ≠ AR para fechas

`toLocaleDateString('es-AR')` y `es-UY` devuelven idéntico para `{day, month, year}`. NO migramos. Si en el futuro un cliente UY reporta una fecha mal formateada (ninguna razón técnica para esperarlo), se evalúa.

### 7.5 Pricing de plan en USD para UY

`plan_prices` queda intacto. La landing muestra USD a todos. Lucas decide cómo gestionar el cobro real (probablemente USDT a wallet, o transferencia SWIFT — fuera del scope de Tecny Portal).

### 7.6 Tenants en `red_b2b_caja_default_id` con moneda local

Hoy un tenant AR tiene caja default cross-tenant ARS (default cuando se firmó la primera partnership). Si una partnership AR↔UY se firma, el seller AR debe cambiar su caja default cross-tenant a USD o USDT (sino el pago propagado del buyer UY en USD no encuentra caja compatible). La UI de `/red-b2b/config` debe mostrar warning: "Tenés partnerships cross-frontera. Sugerimos caja default USD." — sin bloquear (es decisión del operador).

### 7.7 Tests E2E cross-país (Playwright)

F5 agrega 2 flows E2E nuevos:
- **Flow 10**: signup tenant UY → operador UY carga venta UYU → ve TC default 40 → cotizador muestra "USD → UYU".
- **Flow 11**: partnership AR↔UY → seller AR envía op → buyer UY recibe en USD → buyer paga en USD → conciliación 0.

### 7.8 Bot conversacional

El bot multi-tenant (`backend/src/routes/chat.js`) tiene tools que devuelven montos. Hoy formatean en ARS implícito en algunos mensajes ("USD 9500 al TC del día = $13.3M"). Post-feature: cada tool recibe `req.tenantPais` y formatea con la moneda local correcta. Listar tools afectadas en F5 (el bot ya pasa per-tenant context).

### 7.9 Alertas de TC fuera de rango

`alertas_config` (módulo Alertas) tiene una alerta "TC fuera de rango" con thresholds hardcodeados pensando en ARS/USD (e.g. 1200-1600). Para UY los thresholds son distintos (35-45). Los thresholds ya son editables por tenant — no requiere cambio de schema, solo seedear defaults distintos según `tenant.pais` en el signup. Lucas confirma si el seed inicial debe configurarse en F4 o queda para que cada tenant lo configure manual.

---

## 8. Fases de implementación

Cada fase es **mergeable independiente**, deployable a prod. Feature flag `MULTI_PAIS_ENABLED` (default OFF en prod hasta F4 completa) gatea el selector de país en signup — sin la flag, signup queda como hoy (todos AR).

### F1 — Schema + helpers backend (1.5-2 días)

**Entregables**:
- Migration `20260629100001_tenants_pais.js`
- Migration `20260629100002_moneda_check_uyu.js` (con verificación previa de nombres de constraint)
- Migration `20260629100003_tc_defaults_pais.js`
- Migration `20260629100004_tenant_admin_actions_add_pais_change.js`
- `backend/src/lib/pais.js` con helpers (PAISES, getMonedaLocal, getMonedasOperativas, getTcFallback, isMonedaValidaParaPais)
- `backend/src/schemas/_shared.js` con `MonedaEnum` extendida
- Refactor de `backend/src/lib/money.js` `toUsd()` para soportar UYU
- Carga de `pais` en JWT payload (auth.js)
- Middleware expone `req.tenantPais`
- `GET /api/auth/me` incluye `tenant.pais` y `tenant.moneda_local`
- Tests:
  - `tests/migrations-rls-nosuperuser.test.js` ampliado con las 4 migraciones nuevas.
  - `tests/lib/pais.test.js` con 8+ unit tests del helper.
  - `tests/lib/money.test.js` extendido — `toUsd(100, 'UYU', 40)` → 2.5.
  - Test de `/api/auth/me` devuelve `pais`.

**Archivos modificados**:
- `backend/migrations/*` (4 nuevas)
- `backend/src/lib/money.js`
- `backend/src/lib/pais.js` (NUEVO)
- `backend/src/schemas/_shared.js` (NUEVO)
- `backend/src/routes/auth.js`
- `backend/src/routes/signup.js` (signature del JWT)
- `backend/src/middleware/withTenant.js` o equivalente (lectura del JWT)

**Criterio de done**: tests verdes. `pais` está en JWT y `req.tenantPais` funciona. NINGÚN cambio funcional para users existentes (todos siguen siendo AR).

### F2 — Validaciones + endpoint TC default (2-3 días)

**Entregables**:
- Refactor de los 5 schemas en `backend/src/schemas/` (ventas, cajas, egresos, envios, redB2b/pagos) para usar `MonedaEnum` compartido.
- Endpoint `GET /api/config/tc-default` + `PATCH /api/config/tc-default`.
- Refactor de `GET /api/config/last-tc` para parametrizar por país.
- Validación `isMonedaValidaParaPais` en 8 endpoints de escritura (ventas POST/PUT, egresos POST/PUT, envios POST/PUT, cajas POST/PUT, proveedores compra POST, cambios POST).
- Tests:
  - `tests/config-tc-default.test.js` con CRUD + RLS isolation.
  - `tests/ventas.test.js`: agregar caso de tenant AR rechaza moneda UYU (400) + tenant UY rechaza ARS.
  - `tests/config-last-tc.test.js`: caso AR (devuelve ARS), caso UY (devuelve UYU), caso fallback.

**Archivos modificados**:
- `backend/src/schemas/{ventas,cajas,egresos,envios,redB2b/pagos}.js`
- `backend/src/schemas/_shared.js` (extender)
- `backend/src/schemas/config.js` (agregar `tcDefaultSchema`)
- `backend/src/routes/config.js` (refactor last-tc + nuevo tc-default)
- `backend/src/routes/{ventas,egresos,envios,cajas,proveedores,cambios}.js` (8 endpoints — agregar check)
- `backend/src/lib/audit.js` (no requiere cambios — entries normales)

**Criterio de done**: tests verdes. Validación rechaza moneda mal según país. Endpoint tc-default funcional. Backward compat con tenants AR existentes (no rompe nada).

### F3 — Frontend formatters + dropdowns gating (1-1.5 días)

**Entregables**:
- Extender `frontend/src/lib/format.ts`: `Moneda` incluye UYU, `fmtMoney` agrega `'$U'` prefix.
- Extender `frontend/src/lib/money.ts`: `Moneda` + `toUsd` soporta UYU.
- `frontend/src/lib/pais.ts` (NUEVO) con helpers.
- Refactor de ~25 dropdowns hardcoded en 8 archivos (Ventas, Envios, Inventario, RecepcionStock, Sanidad, Tarjetas, Financiera, Conciliacion, Proveedores) para usar `getMonedasOperativas(user?.tenant?.pais)`.
- Banner sutil de país en topbar (flag emoji + tooltip).
- Tests:
  - `tests/format.test.ts` ampliado: `fmtMoney(100, 'UYU')` → '$U100'.
  - `tests/money.test.ts` ampliado: `toUsd(40, 'UYU', 40)` → 1.
  - `tests/pais.test.ts` con 4-6 unit tests.

**Archivos modificados**:
- `frontend/src/lib/{format.ts,money.ts}`
- `frontend/src/lib/pais.ts` (NUEVO)
- `frontend/src/screens/{Ventas,Envios,Inventario,RecepcionStock,Sanidad,Tarjetas,Financiera,Conciliacion,Proveedores}.jsx`
- `frontend/src/components/TopBar.jsx` (o equivalente — flag emoji)

**Criterio de done**: tests verdes. Tenant UY ve `$U` en grillas. Dropdowns UY muestran [UYU, USD, USDT]. Tenant AR sigue igual (no regresiones).

### F4 — Cotizador + signup UY (2-3 días)

**Entregables**:
- Refactor de `frontend/src/screens/Cotizador.jsx`:
  - Lee `user.tenant.pais` para parametrizar headers, labels, mensajes.
  - Default TC viene del backend (lastTc per país).
  - Tab "USD → ARS" pasa a "USD → {monedaLocal}".
  - Copy text usa símbolo + moneda local correctos.
- Nueva tab "TC defaults" en Cotizador con CRUD del default.
- Refactor de `frontend/src/screens/Signup.jsx`:
  - Selector de país (cards radio AR/UY).
  - POST signup envía `pais` en body.
- Backend `signup.js` recibe `pais` y persiste.
- Feature flag `MULTI_PAIS_ENABLED` para gatear el selector de país (defensivo — fácil revertir si hay issue).
- Migration `20260630000001_cross_tenant_pagos_uyu.js` extiende CHECK de moneda_pago.
- Tests:
  - `tests/Signup.test.jsx`: caso default (AR), caso UY.
  - `tests/Cotizador.test.jsx`: render con `tenant.pais='UY'` muestra "USD → UYU" + "$U".
  - `tests/signup.test.js` (backend): signup con `pais='UY'` crea tenant correcto.

**Archivos modificados**:
- `frontend/src/screens/{Cotizador,Signup}.jsx`
- `frontend/src/screens/Cotizador.test.jsx`, `Signup.test.jsx`
- `backend/src/routes/signup.js`
- `backend/src/schemas/signup.js`
- `backend/migrations/20260630000001_cross_tenant_pagos_uyu.js`

**Criterio de done**: tests verdes. Lucas puede crear un tenant UY desde signup, ve cotizador funcional con UYU, edita TC default UY/USD.

### F5 — Red B2B cross-frontera + docs + observabilidad (1-2 días)

**Entregables**:
- Migration `20260630000002_cross_tenant_ops_moneda_local.js`: agregar `total_moneda_local_seller` con backfill.
- Refactor de `backend/src/routes/redB2b/operations.js`: usa `total_moneda_local_seller` además de `total_ars` (compat).
- Refactor de `backend/src/routes/redB2b/pagos.js`: el check de compatibilidad de caja moneda↔moneda_pago se extiende a UYU.
- Refactor del bot (`backend/src/routes/chat.js` + tools) para formatear con moneda local del tenant del request.
- Test E2E flow 10 (Playwright): signup UY + alta venta UYU.
- Test E2E flow 11 (Playwright): partnership AR↔UY + op + pago USD.
- Documentación:
  - `ARCHITECTURE.md` actualizado con sección "Multi-país".
  - `docs/design/red-b2b-cross-tenant.md` actualizado con apéndice cross-frontera.
  - `RUNBOOK.md` agrega procedimiento de "agregar nuevo país" (template).
- Observabilidad:
  - Métrica `tenant_signup_by_pais{pais=...}` en logs estructurados (pino).
  - Log warning si un endpoint recibe `moneda` no habilitada para el país (vía el handler rechazo) — útil para detectar UI bugs.

**Archivos modificados**:
- `backend/migrations/20260630000002_cross_tenant_ops_moneda_local.js`
- `backend/src/routes/redB2b/{operations,pagos}.js`
- `backend/src/routes/chat.js` + tools en `backend/src/lib/bot/`
- `e2e/multi-pais-flow10.spec.ts` (NUEVO)
- `e2e/multi-pais-flow11.spec.ts` (NUEVO)
- `ARCHITECTURE.md`
- `docs/design/red-b2b-cross-tenant.md`
- `RUNBOOK.md`

**Criterio de done**: tests E2E pasan en CI. Doc cross-frontera mergeada. Feature flag activada en prod tras 1 semana de monitoring.

**Total estimado**: 8-12 días. Si urge: F1+F2+F4 son el camino crítico para el cliente UY (≈ 5-7 días). F3 y F5 se pueden cerrar después con el cliente ya operando.

---

## 9. Decisiones secundarias cerradas (Lucas, 2026-06-29)

Las 8 decisiones que habían quedado abiertas al primer draft se cerraron en la review con Lucas el mismo día del doc. Quedan documentadas acá para que F1-F5 las implementen literal sin re-discusión.

1. **Cambio de país post-signup → ✅ Solo super-admin manual**.
   - NO se agrega endpoint `PATCH /api/admin/tenant/:id/pais`. Si llega el caso real, super-admin lo hace via SQL directo + acompañamiento de Lucas.
   - El doc en sección 6.4 ya documentaba esto como "no soportamos" — esta decisión lo confirma definitivamente.

2. **Seed automático de TC default al signup UY → ✅ SÍ seedear**.
   - Cambio respecto al draft inicial (que recomendaba NO seedear). Razón: si queda NULL, el operador UY se encuentra con inputs TC vacíos en su primera venta — mala UX inicial.
   - Al signup de un tenant UY, F1 inserta automáticamente fila en `tc_defaults_pais` con `(UY, UYU/USD, 40, NULL, NULL)` o el último valor seteado por admin global.
   - El operador puede actualizar el TC default en cualquier momento desde Config (decisión 6 abajo).

3. **USDT habilitado en UY → ✅ SÍ**.
   - Confirmado por Lucas el 2026-06-29 tras consulta al cliente UY: "Hay USDT en Uruguay. Lo usan."
   - Enum de monedas operativas UY: `['UYU','USD','USDT']`. Idéntico shape que AR salvo cambio de moneda local.
   - Sin follow-up necesario — F1 lo implementa directo.

4. **Pricing diferencial por país → ✅ NO abrir ahora**.
   - `plan_prices` permanece sin columna `pais`. Tenants UY pagan en USD igual que AR.
   - Si en futuro 3-6 meses se valida demanda de pricing regional, se agrega `plan_prices_pais` como subtabla. Es feature aparte.

5. **Thresholds default alerta "TC fuera de rango" UY → ✅ `25 < TC < 60`**.
   - El rango UYU/USD oscila históricamente entre 30-45. `25 < TC < 60` da margen de seguridad razonable.
   - F1 seedea la alerta en signup UY con esos thresholds. Admin puede ajustar luego desde Config.

6. **Ubicación tab "TC defaults" → ✅ Config (no Cotizador)**.
   - Cambio respecto al draft inicial (que recomendaba en Cotizador). Razón: el Cotizador ya está sobrecargado y TC defaults es feature de admin (config global) no operativa diaria.
   - F4 agrega tab "TC default por país" dentro de Configuración del sistema.

7. **Localización de errores backend por país → ✅ NO**.
   - Spanish neutro funciona en AR y UY. Sobrekill agregar i18n por país solo para esto.
   - F1-F5 dejan todos los mensajes de error como están.

8. **Mencionar Uruguay en landing tecnyapp.com → ✅ SÍ, pero como follow-up post-launch**.
   - NO bloquea este feature. Después de tener 1+ tenant UY real funcionando, actualizamos copy + diseño de landing para mencionar disponibilidad UY.
   - Tracked como tarea aparte; no entra en F1-F5.

---

## 10. Glosario

| Término | Definición |
|---|---|
| **Pais (tenant.pais)** | Atributo del tenant: 'AR' o 'UY'. Determina moneda local habilitada, TC default, símbolo visual. Inmutable post-signup desde UI. |
| **Moneda local** | La moneda fiat del país del tenant. ARS para AR, UYU para UY. Distinta de monedas universales (USD, USDT). |
| **Monedas universales** | USD y USDT. Habilitadas en todos los países. Para reseller B2B son anchors operativos (no depende del país). |
| **TC** | Tipo de cambio. **Por convención del repo**: cuántas unidades de moneda local equivalen a 1 USD. AR: TC ~1400. UY: TC ~40. NO es ratio USD/moneda. |
| **TC default** | Valor del TC que el frontend pre-rellena en formularios (ventas, egresos, cotizador). Lookup en orden: venta reciente del tenant > tabla `tc_defaults` > fallback hardcoded. |
| **Símbolo local** | El símbolo gráfico de la moneda local. AR: `$`. UY: `$U`. USD: `u$s`. USDT: `USDT `. Cementado en `fmtMoney`. |
| **Cross-frontera** | Partnership Red B2B entre tenants de países distintos (AR↔UY). Caso novedoso introducido por este feature. |
| **Anchor USD** | En Red B2B, USD es la moneda de referencia interna de la operación. Sellers AR y UY fijan su TC contra USD; el `total_usd` es la verdad común. |
| **MonedaEnum** | Enum compartido de monedas válidas en el sistema. Hoy `['USD','ARS','USDT']`. Post-feature: `['USD','ARS','USDT','UYU']`. Definido en `backend/src/schemas/_shared.js`. |
| **isMonedaValidaParaPais** | Helper que retorna true si una moneda específica está habilitada para el país de un tenant. Centraliza la matriz país↔moneda. |

---

**Última actualización**: 2026-06-29
**Autor**: design pair Lucas + Claude
**Issue**: #467
