# Audit Financiero 2026-07-25

## Contexto

Segunda auditoría TOTAL cross-track del portal, focalizada en el track **Financiero** (post-audit 2026-07-12 que cerró 14 findings). Alcance revisado: rutas `cajas.js`, `cuentas.js`, `tarjetas.js`, `egresos.js`, `cambios.js`, `comprobantes.js`, `pagos.js`, `cajaTransferencias.js`, `ventas.js` (parte financiera), `sanidad.js`; libs `cajaLedger.js`, `cajasCache.js`, `money.js`, `saldoCC.js`, `saldoProveedor.js`, `financiera.js`, `tarjetas.js`, `tarjetasSaldo.js`, `comisionesMetodos.js`, `dashboardMensual.js`, `ventaSync.js`, `ventaCore.js`, `cancelMovimientoCC.js`, `alertas.js`, `comprobantePdf.js`, `comprobanteEmail.js`; schemas correspondientes; y screens `Cajas.jsx`, `CuentasCC.jsx` (parcial). Excluye findings ya cerrados en `docs/audit/2026-07-12-*` y en el ciclo del 2026-07-25 (cache invalidation audit, refactor SET LOCAL, PR #878 signo ganancia_neta).

**TL;DR**: sistema en muy buen estado post-audit anterior (12 sprints, 72% closure). Encontré **1 P0**, **6 P1**, **6 P2** y **5 P3** — la mayoría son follow-ups de rollout multi-país incompleto (patrones no propagados) o gaps de contract tests. No hay filtraciones cross-tenant financieras ni bugs de atomicidad.

## Findings

### P0 — Críticos

#### P0-1 — `syncVentaVuelto` persiste `monto_usd = 0` en cajas ARS/UYU (ledger cross-moneda roto)

**File**: `backend/src/lib/ventaSync.js:126-142`
**Categoría**: Solidez (KPI corrupto silencioso)

`syncVentaVuelto` postea el egreso del vuelto a caja con `tc: null` **hardcodeado**. Cuando `vuelto_moneda` es local (ARS/UYU), esto hace que dentro de `postCajaMovimiento` (`cajaLedger.js:82`) el `monto_usd = toUsd(monto, 'UYU', null) = 0`. El `caja_movimientos.monto` nativo queda correcto (saldo de la caja OK), pero **`monto_usd` persiste como 0**.

Impacto:
- El ledger global `/api/cajas/movimientos` (línea 414-416) suma `monto_usd` para totales — todos los vueltos ARS/UYU quedan invisibles en el KPI "egresos USD" del ledger cross-moneda.
- El dashboard mensual usa `caja_movimientos.monto_usd` indirectamente vía `snapshotCajas`. El saldo nativo de la caja está OK pero el reporting cross-moneda pierde estos egresos.
- El comment en `syncVentaVuelto:135` dice "tc: null" pero la `venta.vuelto_tc` ya se persiste en la tabla `ventas` (agregada en 2026-07-14 para el mismo bug) — está disponible en el `venta` que recibe el helper. **Simplemente NO lo lee**.

**Escenario reproducible**:
1. Tenant UY vende un iPhone a $USD 1000 (item con moneda='USD').
2. Cliente paga UYU 42000 en efectivo (caja UYU). Vuelto UYU 2000 en la misma caja UYU (moneda='UYU', tc=40).
3. `ventas.vuelto_tc=40` se persiste correcto. `calcularTotales` descuenta el vuelto del USD (2000/40=50 USD) → `ganancia_usd` es correcta.
4. `syncVentaVuelto` postea egreso de UYU 2000 a la caja UYU con `tc: null` → `caja_movimientos.monto_usd = 0` (en vez de 50).
5. El "egresos USD" del ledger `/api/cajas/movimientos` subestima en USD 50 por cada venta con vuelto local.

**Fix propuesto**: leer `venta.vuelto_tc` en `syncVentaVuelto` y pasarlo al `postCajaMovimiento`. Es 1 línea:
```js
tc: venta.vuelto_tc ?? null,
```

Además: agregar contract test estático en el mismo pattern del cache invalidation contracts que asegura que `syncVentaVuelto` pasa `venta.vuelto_tc` (no `null` hardcoded).

**Costo estimado**: 30 min (fix + test + backfill opcional para vueltos historicos si Lucas quiere consolidar).

---

### P1 — Importantes

#### P1-1 — Frontend Cajas.jsx: input TC en ajuste manual solo aparece para caja ARS (UY roto)

**File**: `frontend/src/screens/Cajas.jsx:551, 556, 1065`
**Categoría**: UX crítica multi-país (backend rechaza sin explicación en UI)

En el modal "Ajuste manual de caja", el input TC condiciona su render con `cajaSel.moneda === 'ARS'`. Un tenant UY con caja UYU **NO ve el input TC**, pero el backend (`routes/cajas.js:497`) rechaza el request con `requiereTc(moneda)` porque UYU también lo requiere.

Impacto: el operador de UY hace clic en "Agregar" ajuste → backend responde 400 "Para una caja en UYU se requiere el tipo de cambio (tc)" → el operador ve el toast pero el form no tiene input para completar. Confusión total; solo se resuelve reeducando al operador o mirando código.

**Fix propuesto**:
1. Cambiar la condición del input a `requiereTc(cajaSel.moneda)` (importar de `_common.js` o replicar la lista `['ARS', 'UYU']`).
2. Cambiar la validación del submit (línea 551) al mismo pattern.
3. Cambiar el ternario del payload (línea 556) a `requiereTc(cajaSel.moneda)`.
4. Actualizar el mensaje "Para una caja en ARS..." a "Para una caja en `${moneda}` ingresá el TC".

**Costo estimado**: 20 min. Encontré esto en la revisión frontend — probablemente hay más lugares con el mismo pattern (grep `moneda === 'ARS'` en Cajas.jsx, Cambios.jsx, Egresos.jsx frontend).

---

#### P1-2 — Cobranza masiva sin `assertMonedaValidaParaPais` (multi-país incompleto)

**File**: `backend/src/routes/cuentas.js:1251-1400`
**Categoría**: Seguridad multi-país (no bloquea cross-country pero rompe invariante)

El endpoint `POST /cobranzas-masivas` no valida que cada `cobranzas[i].moneda` sea válida para el país del tenant. Todos los otros endpoints financieros que reciben moneda del body lo hacen:
- `routes/cajas.js:264` (POST /cajas) ✓
- `routes/cuentas.js:550` (POST /movimientos individual) ✓
- `routes/egresos.js:302` (POST /egresos) ✓
- `routes/ventas.js:1322-1330` (POST /ventas) ✓
- `routes/cambios.js` — sin validación (P1-3 abajo)
- `routes/tarjetas.js` — sin validación (menor porque la moneda de la tarjeta la fija la caja, no el body)

Impacto real hoy: bajo, porque tener una caja UYU en tenant AR requiere que la caja haya sido creada en violación de la matriz (imposible por `cajas.js:264`). Pero el gap es **estructural** — si un tenant se migra de país o si en el futuro se relaja la validación de caja, la cobranza masiva quedaría como el único vector.

**Fix propuesto**: agregar `assertMonedaValidaParaPais(c.moneda, req.tenantPais, 'cobranzas[].moneda')` en el loop pre-INSERT (después del pre-validation de clientes/cajas, línea ~1283). Idem un check al `cobranzaItemSchema.moneda` que refleje el error de forma temprana.

**Costo estimado**: 30 min (fix + test).

---

#### P1-3 — `routes/cambios.js` sin `assertMonedaValidaParaPais` en `POST /movimientos`

**File**: `backend/src/routes/cambios.js:209-323`
**Categoría**: Seguridad multi-país

Mismo gap que P1-2. `POST /cambios/movimientos` no importa ni llama `assertMonedaValidaParaPais`. Los 8 tipos válidos (entrega_ars/uyu/usd_por_ars/usd_por_uyu/recibo_ars/uyu/usd/usd_uy) implícitamente asumen moneda por tipo, pero **el tenant AR podría enviar `entrega_uyu`** (que requiere caja UYU). Como su tenant AR no tiene cajas UYU (validado al alta), el `postCajaMovimiento` rebota con 400 ("moneda del pago no coincide con la caja"). Pero es un error opaco — el operador no entiende por qué.

**Fix propuesto**: derivar la moneda del pago desde `tipo` (tabla de mapeo — ya existe implicitamente en `conceptoMap`) y validarla con `assertMonedaValidaParaPais(monedaImplicita, req.tenantPais, 'tipo')`. Devuelve error contextualizado antes de tocar la caja.

**Costo estimado**: 30 min.

---

#### P1-4 — `syncFinancieraComprobante` primer `SELECT` sin `ORDER BY` (indeterminismo silencioso)

**File**: `backend/src/lib/financiera.js:19-24`
**Categoría**: Solidez (invariante contable)

```sql
SELECT vp.monto FROM venta_pagos vp
  JOIN metodos_pago mp ON mp.id = vp.metodo_pago_id
 WHERE vp.venta_id = $1 AND mp.es_financiera = true AND mp.deleted_at IS NULL
 LIMIT 1
```

Sin `ORDER BY`. La segunda query del mismo helper (línea 30-34) sí ordena por `id`. Si por bug del sync/edit una venta tiene 2 pagos con caja financiera (edge case pero posible con edit doble), la elección del `monto` para el comprobante es indeterminística — puede cambiar entre ediciones o entre réplicas de Postgres.

Ya estaba flageado en el audit anterior como P2-5, no se cerró en el cierre (backlog "P2 residual"). El fix es agregar `ORDER BY vp.id LIMIT 1` — consistente con las otras queries del archivo (`comisionesMetodos.js:92`, `financiera.js:59`, `financiera.js:34`).

**Fix propuesto**: agregar `ORDER BY vp.id` a la query. Además: agregar UNIQUE parcial `WHERE es_financiera=true AND deleted_at IS NULL` sobre `venta_pagos(venta_id)` para hacer el invariante enforceable en DB.

**Costo estimado**: 30 min + migration.

---

#### P1-5 — `postCajaMovimientoFinanciera` con `tc: null` hardcodeado (multi-país + USDT)

**File**: `backend/src/lib/financiera.js:210-264`
**Categoría**: Solidez (multi-país)

El helper `postCajaMovimientoFinanciera` (líneas 210-264) postea a la caja `es_financiera=true` con `tc: null` hardcodeado. Comment en línea 239-256 documenta que es DEBT — cuando el primer tenant configure Financiera en caja UYU o USDT con TC≠1, el `monto_usd` = `toUsd(monto, 'UYU', null) = 0` y el reporting cross-moneda queda subestimado.

Este debt ya estaba flageado en audit anterior como P2-1. Como parte del Sprint 5 se intentó fix pero se rollbackeo por dependencia con el caller (bloqueado por el signature del refactor). Sigue abierto.

**Fix propuesto**: refactor de la signature del helper para aceptar `tc` explícito. Callers principales: `routes/comprobantes.js:201` (auto), `routes/comprobantes.js:255` (manual), `routes/pagos.js:139` (egreso pago). Cada caller resuelve el TC contextualmente:
- Auto: TC del `venta_pagos.tc` que originó el comprobante.
- Manual: TC del `req.body` o TC default país como fallback.
- Pago: TC del pago si convertir_usd, sino null (caja ARS → tc=null es correcto).

**Costo estimado**: 3h (refactor + tests). Aceptable posponer hasta que aparezca el primer tenant UY con Financiera en producción (no hay hoy).

---

#### P1-6 — Cobranza masiva sin Idempotency-Key (doble-click duplica lote entero)

**File**: `backend/src/routes/cuentas.js:1251`
**Categoría**: Solidez (idempotency gap)

El POST `/cobranzas-masivas` no implementa el Pattern G (Idempotency-Key). El endpoint sí tiene `cobranzaLimiter` (10/15min/user) que evita spam, pero un doble-click al submit en el modal de cobranza masiva puede persistir el lote 2× consecutivo:
- 2× N movimientos_cc creados con IDs distintos
- 2× N ingresos a caja_movimientos
- 2× audit logs `_bulk` (con `ids: [...]` distintos)

Los 5 endpoints Financiero cerrados en Sprint 4 fueron: ventas, cuentas/movimientos individual, proveedores/movimientos, tarjetas/liquidaciones, cambios/movimientos. La cobranza masiva se dejó afuera (probablemente por tener rate-limiter propio).

**Fix propuesto**: mismo pattern G — agregar `client_generated_id` a `movimientos_cc` (columna ya existe), extender el schema para aceptar `Idempotency-Key` header, y usar el helper `findExistingByIdempotencyKey` para replay. Complicación: la cobranza masiva son N movimientos, la key debe cubrir el LOTE ENTERO (no cada mov). Diseño: usar la key como `client_generated_id` del **primer** mov creado, y el replay devuelve toda la lista con `SELECT * WHERE created_at BETWEEN mov1.created_at AND +1s` (frágil) o mejor: agregar tabla `cobranzas_masivas_lotes(id, tenant_id, client_generated_id, movimientos_ids[])` como "lote header".

**Costo estimado**: 3h (migration + backend + frontend + test). Alta prioridad porque Tek Haus reporta lotes de 100+ cobranzas — un doble-click ahí es P0 en su contabilidad.

---

### P2 — Higiene / Edge cases

#### P2-1 — `cajaTransferencias.js` define `grupoMoneda` inline (drift del canónico)

**File**: `backend/src/routes/cajaTransferencias.js:109`
**Categoría**: DRY / consistencia

```js
const grupo = (m) => (m === 'ARS' ? 'ARS' : m === 'UYU' ? 'UYU' : 'USD');
```

Copia local del `grupoMoneda` canónico de `cajaLedger.js:19-23`. El comportamiento es equivalente (3 grupos correctos) pero es drift a mantener sincronizado. Ya se removió versiones locales en `pagos.js`/`tarjetas.js` en Sprint 10 del audit anterior — este archivo se perdió.

**Fix propuesto**: `const { grupoMoneda } = require('../lib/cajaLedger');` + eliminar la local. 5 min.

---

#### P2-2 — Cache `invalidateCajas` faltante en 4 rutas que crean `caja_movimientos`

**File**: `backend/src/routes/pagos.js`, `comprobantes.js`, `cambios.js`, `cajaTransferencias.js`, `tarjetas.js`
**Categoría**: Cache staleness (UX degradada, no bug de datos)

Ningún de los siguientes handlers invalidan `getCajasList` (TTL 15s):
- `POST /pagos` (crea 1 ingreso + 1 egreso caja FV)
- `DELETE /pagos/:id`
- `POST /comprobantes` (ingreso caja FV)
- `POST /comprobantes/manuales` (ingreso caja FV)
- `PATCH /comprobantes/manuales/:id` (reverse + repost en caja FV)
- `DELETE /comprobantes/:id`
- `POST /cambios/movimientos` (ingreso/egreso según tipo)
- `DELETE /cambios/movimientos/:id`
- `POST /caja-transferencias` (2 movimientos)
- `DELETE /caja-transferencias/:id`
- `POST /tarjetas/cobros-iniciales`
- `POST /tarjetas/liquidaciones` (2 movimientos)
- `POST /tarjetas/liquidaciones-multiples` (N×2 movimientos)
- `PATCH /tarjetas/movimientos/:id`
- `DELETE /tarjetas/movimientos/:id`

Impacto: dashboard de saldos de cajas stale hasta 15s post-mutation. Poca fricción real (el user típicamente no consulta el dashboard el instante después de operar), pero **el contract test `cache-invalidation-contracts.test.js` NO cubre estos casos**. Silbato de que si el TTL cambia a 5min por perf, el gap se vuelve visible.

**Fix propuesto**:
1. Agregar `invalidateCajas(req.tenantId)` fire-and-forget post-COMMIT en cada handler mencionado.
2. Extender `cache-invalidation-contracts.test.js` con nuevas reglas que verifiquen que estos archivos importan `cajasCache` y llaman `invalidateCajas`.

**Costo estimado**: 2h (fixes + contract tests + regresión).

---

#### P2-3 — `snapshotCajas` "última venta con TC" sin filtro por moneda (edge case cross-moneda)

**File**: `backend/src/lib/dashboardMensual.js:242-247`
**Categoría**: Edge case KPI

El TC de referencia para convertir cajas ARS→USD se elige como "última venta con `tc_venta IS NOT NULL`", sin distinguir la moneda dominante de la venta. Si un tenant UY (que opera casi todo en UYU con tc≈40) tuvo una venta ARS aislada meses atrás (tc≈1400), y hoy su caja ARS tiene saldo, el `capital_usd_equivalente` convertiría la caja ARS con tc=40 (última venta UY) en vez de tc=1400 — inflaría 35×.

Probabilidad real: baja hoy. Todos los tenants son single-country. Pero el bug **se activa** cuando un tenant AR migra a UY (o viceversa) o tiene un cliente cross-country legacy.

**Fix propuesto**: cambiar la query para tomar "última venta CON items ARS" (JOIN venta_items):
```sql
SELECT v.tc_venta FROM ventas v
  JOIN venta_items vi ON vi.venta_id = v.id
 WHERE v.tc_venta IS NOT NULL AND v.fecha <= $1 AND v.deleted_at IS NULL
   AND vi.moneda = 'ARS'
 ORDER BY v.fecha DESC, v.id DESC LIMIT 1
```

Idem para UYU (parametrizar). O más limpio: SIEMPRE usar `getTcDefaultPais(exec, 'AR')` para la conversión ARS→USD (mismo criterio ya adoptado para UYU en 2026-07-05). Consistencia.

**Costo estimado**: 1h.

---

#### P2-4 — `validarTc` en ventas NO cubre canjes en moneda local

**File**: `backend/src/routes/ventas.js:119-136`
**Categoría**: Edge case validación

`validarTc` chequea items + pagos para exigir `tc_venta > 0` cuando hay moneda local. NO chequea canjes:

```js
function validarTc(items, pagos, tcVenta) {
  // items.moneda === 'ARS' | 'UYU' → exige tc
  // pagos.moneda === 'ARS' | 'UYU' → exige tc
  // canjes → NO chequea
}
```

Un canje con `valor_toma: 500000, moneda: 'ARS'` sin `tc_venta > 0` pasa la validación. Después, en el PDF (`comprobantePdf.js:151-159 sumCanjesUsd`), se calcula `500000 / 0 = Infinity` (si tc_venta=0) o `500000 / 1 = 500000` como si fuera USD (fallback `?? 0` en el reduce). El total_cobrado del PDF queda mal.

Ya un canje sin producto vinculado suma al total_cobrado del comprobante pero no al `total_usd` de la venta (que solo mira items). Si el operador carga un canje ARS por accidente sin tc, el PDF muestra un total_cobrado absurdo.

**Fix propuesto**: extender `validarTc` para chequear `canjes[].moneda`:
```js
if ((canjes || []).some(c => c.moneda === 'ARS' || c.moneda === 'UYU') && !tcOk) {
  throw err400('Indicá el tipo de cambio (TC) de la venta para canjes en moneda local.');
}
```

**Costo estimado**: 15 min + test.

---

#### P2-5 — `updateMovimientoSchema` (tarjetas) sin `.max()` en `monto` y `monto_bruto`

**File**: `backend/src/schemas/tarjetas.js:42-44`
**Categoría**: Defensive limits

```js
monto_bruto:  z.coerce.number().positive('...').optional(),
monto:        z.coerce.number().positive('...').optional(),
```

Sin `.max()`. Un `monto: 1e18` rompe `NUMERIC(14,2)` de Postgres con "value overflows numeric format" → 500 crudo al frontend (Sentry P2, mismo patrón ya cerrado en `cajaSchema` con `NUMERIC_14_2_MAX = 999_999_999_999.99` — audit anterior 2026-07-05).

El schema del `createLiquidacionSchema:15` tampoco tiene max. Ni `createCobroInicialSchema:28`.

**Fix propuesto**: usar el mismo `NUMERIC_14_2_MAX` (exportar de `_common.js` para reusar) en los 4 campos.

**Costo estimado**: 15 min + test.

---

#### P2-6 — `cambio_movimientos` con `tc: 1e15` inflaría la deuda local silenciosamente

**File**: `backend/src/schemas/cambios.js:53`
**Categoría**: Defensive limits

```js
tc: z.coerce.number().positive().optional().nullable(),
```

Sin `.max()`. Un `entrega_usd_por_ars` con `monto_usd=1000` y `tc=1e15` calcula `local = 1000 × 1e15 = 1e18` → OVERFLOW numeric. Mismo pattern que P2-5.

**Fix propuesto**: agregar `.max(1e6)` (mismo tope que ya adoptó `updateMovimientoSchema` en tarjetas post-audit anterior P2-3). Aplica a `entrega_ars`, `entrega_uyu` también (dividen por tc, pero un tc absurdo no explota — solo hace la conversión ridícula).

**Costo estimado**: 10 min.

---

### P3 — Opcional / mejoras

#### P3-1 — `SET LOCAL app.current_tenant = ${req.tenantId}` con interpolación en 30+ sitios de rutas Financiero

**File**: `routes/cajas.js`, `cuentas.js`, `tarjetas.js`, `egresos.js`, `cambios.js`, `comprobantes.js`, `pagos.js`, `ventas.js`, `cajaTransferencias.js`
**Categoría**: Convención

Aún hay 30+ sitios en las rutas Financiero con el pattern `SET LOCAL app.current_tenant = ${req.tenantId}` (interpolación de template literal). El middleware valida `Number.isInteger(req.tenantId)` cross-cutting (Sprint 12 audit anterior P3-1) → sin riesgo real de SQL injection. Pero el refactor Sprint 06-25 migró **rutas admin y redB2b** (29 sitios) al pattern `set_config('app.current_tenant', $1::text, true)` con bind param. Las rutas Financiero quedaron con la interpolación.

Impacto: cero riesgo. Diferencia estilística. Nuevo dev puede confundirse. El anti-regression check (`scripts/security/backend-anti-regression-check.mjs`) tiene baseline de 30 usages allow-listados.

**Fix propuesto**: migrar batch a `set_config('app.current_tenant', $1::text, true)` con `[req.tenantId.toString()]` como parameter. Reducir baseline a 0. Puramente cosmético — no urgente.

**Costo estimado**: 2h batch replace + verificación tests + update baseline.

---

#### P3-2 — `alertas.js:evalCajaNegativa` no expone `link` deep-linkeable

**File**: `backend/src/lib/alertas.js:53-59`
**Categoría**: UX

```js
link: '/cajas',
```

Cuando el usuario hace clic en una alerta "Caja X en negativo", cae al listado sin filtro. Podría ir directo al ledger de la caja específica: `/cajas?open=${r.id}` (mismo pattern que Cmd+K usa).

**Costo estimado**: 10 min (frontend también tiene que soportar el deep-link).

---

#### P3-3 — Tests contract cache invalidation NO cubren rutas Financiero secundarias

**File**: `backend/tests/cache-invalidation-contracts.test.js`
**Categoría**: Test coverage

Los `CONTRACTS` cubren `cuentas.js`, `superAdmin.js`, `ventas.js`, `egresos.js` — pero NO `pagos.js`, `comprobantes.js`, `cambios.js`, `cajaTransferencias.js`, `tarjetas.js`. Como es static analysis, un rule nuevo cuesta 10 líneas. Ver P2-2 para el fix concreto — el contract test debería agregarse en paralelo al fix.

---

#### P3-4 — `sumComisionesMetodosUsd` fallback silente para filas con `venta_pago_id = NULL`

**File**: `backend/src/lib/comisionesMetodos.js:66-82`
**Categoría**: Observability

El comment en línea 63-65 dice "Fallback para filas históricas con venta_pago_id IS NULL (backfill no logró match unívoco por duplicados) → NO se cuentan. Es más conservador que double-counting; el impacto real es < 0.1% de ventas."

El fallback es silente. Un usuario que audite `comision_total_metodos` de una venta antigua con `venta_pago_id=NULL` va a ver la comisión de tarjeta como si fuera $0 (subestima). Ni un log ni un warning.

**Fix propuesto**: al detectar `venta_pago_id IS NULL` en el WITH `tarjeta`, emitir un `logger.warn` una vez por venta con contexto para triage.

**Costo estimado**: 15 min.

---

#### P3-5 — `cajaTransferencias.js` DELETE sin `FOR UPDATE` de la fila

**File**: `backend/src/routes/cajaTransferencias.js:231-236`
**Categoría**: Race condition edge

El UPDATE + RETURNING actúa como lock implícito por row, pero es sutil. Otros DELETE del track (ventas, cuentas, egresos) hacen `SELECT ... FOR UPDATE` antes del UPDATE para lockear determinísticamente.

Impacto: cero práctico. Si 2 users borran la misma transferencia concurrente, el 2do falla su `reverseCajaMovimientos` (los movs ya están soft-deleted), no hay corrupción. Estilístico.

**Fix propuesto**: agregar `SELECT ... FOR UPDATE` antes del UPDATE. Consistencia.

**Costo estimado**: 5 min.

---

## Cross-track hooks

- **Cache invalidation** (P2-2): tocca contract tests que ya viven en `cache-invalidation-contracts.test.js`. Coordinar con track Plataforma para no duplicar reglas.
- **Frontend multi-país** (P1-1): el bug UYU-sin-TC probablemente se repite en `Egresos.jsx`, `Cambios.jsx`, `CuentasCC.jsx`, `Tarjetas.jsx`. Grep `moneda === 'ARS'` en frontend/src/screens para encontrar todos los sitios. Coordinar con track Externa/UX.
- **Auditoría cross-track de `SET LOCAL` interpolación** (P3-1): 30+ sitios en rutas Financiero + rutas de otros tracks (probablemente Auth, Stock). Consolidar en un mini-sprint de higiene único.
- **Sanitización de PDF** (`comprobantePdf.js:sanitizeForPdf`): reutilizable en otros PDFs (nota de venta B2B, listado de equipos usados). Coordinar con track Externa.
- **Idempotency-Key en cobranza masiva** (P1-6): tocca schema Zod + migration + frontend. Podría replicarse el pattern para otros endpoints "bulk" del track Stock (bulk import, bulk clases, etc.).

## Métricas del track

- **N findings totales**: 18
- **Distribución**: P0×1 · P1×6 · P2×6 · P3×5
- **Files revisados**: 30 (rutas 10 + libs 14 + schemas 5 + frontend Cajas.jsx)
- **Files sin findings**: `saldoCC.js`, `saldoProveedor.js`, `tarjetasSaldo.js`, `cancelMovimientoCC.js`, `ventaCore.js`, `sanidad.js`, `comprobanteEmail.js`, `alertas.js` (con excepción de P3-2 cosmético).

**Buenas prácticas verificadas (confirman salud del track post-audit anterior)**:
1. `SALDO_CASE` canónico usado consistentemente (incluye los 2 nuevos tipos `pago_a_cliente` + `entrega_dinero` de 2026-07-17).
2. `SALDO_CASE_M` de proveedores consolidado (task #150 cerró el drift dashboardMensual).
3. Pattern G Idempotency-Key en 5/6 endpoints Financiero (falta cobranza masiva — P1-6).
4. Multi-país F1-F5 con `assertMonedaValidaParaPais` en 5/8 rutas escritas (faltan cambios, tarjetas, cobranza masiva — P1-2/3).
5. `postCajaMovimiento` valida grupo moneda + no-negativo con FOR UPDATE, race-safe.
6. `reverseCajaMovimientos` con validación de saldo POST-reverse + lock ordenado.
7. Cache invalidation en mutations principales (venta/egreso/cobranza masiva), gaps documentados en P2-2.
8. Vuelto feature end-to-end con `vuelto_tc` para conversión de ganancia_usd — pero el egreso a caja NO usa el TC (P0-1).
9. Comprobante PDF backend con `sanitizeForPdf` + fix Tek Haus (canjes en total_cobrado).
10. Snapshot inmutable de `comision_pct_snapshot` en `venta_pagos` (D-01) sigue verificado.

**Comparación con audit 2026-07-12**: se cerraron 14 findings Financiero (100% P0, 100% P1 salvo P1-5 cerrado en Sprint 9 con FK explícito, 7/9 P2 cerrados, algunos P3 diferidos por retornos decrecientes). Este audit encuentra 6 P1 nuevos que son mayormente **follow-ups de patrones no propagados a nuevos endpoints** (idempotency en cobranza masiva, moneda país-aware en cambios/cobranza, TC del vuelto en caja) + **1 P0 real** (P0-1 vuelto sin TC). El sistema sigue sólido — no hay bugs de atomicidad, RLS, ni cross-tenant en el track.
