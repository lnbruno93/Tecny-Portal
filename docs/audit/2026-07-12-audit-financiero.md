# Auditoría Financiero — 2026-07-12

**Fecha**: 2026-07-12
**Auditor**: Claude Opus (revisión secuencial de rutas y libs financieros).
**Alcance**: rutas `backend/src/routes/{ventas,cajas,cuentas,cambios,tarjetas,proveedores,egresos,pagos,comprobantes,cajaTransferencias,dashboard,sanidad}.js`, libs `backend/src/lib/{money,saldoCC,cajaLedger,ventaSync,financiera,tarjetas,tarjetasSaldo,comisionesMetodos,cancelMovimientoCC,dashboardMensual,alertas}.js`, schemas Zod correspondientes, frontend `Cambios.jsx`/`CuentasCC.jsx`/`Ventas.jsx` (contract compliance).
**Método**: revisión de código con foco en atomicidad, RLS, invariantes contables, race conditions, sanidad numérica multi-divisa y consistencia cross-módulo.

---

## TL;DR

**Severity count**: P0 3 · P1 5 · P2 6 · P3 9

**Top 3 findings**:
1. **`POST /api/cuentas/movimientos` hardcodea `moneda: 'USD'`** al postear a caja — pago B2B con caja ARS/UYU/USDT rebota con 400, y un cliente que engañe con `monto_total` en otra moneda mezcla dinero cross-divisa en el ledger.
2. **`grupoMoneda` divergente entre `cajaLedger.js` (ARS/UYU/USD) y `cuentas.js` cobranza masiva (ARS/USD)** — el segundo NO trata UYU como grupo separado, así una cobranza masiva UYU pasa la validación local pero después el postCajaMovimiento bulk la rebota con 400 (best case) o la acepta silenciosamente (worst case si el schema Zod ya coerció).
3. **`dashboardMensual.js:topProductos`/`topVendedores` divide por `tc_venta` sin distinguir moneda del item** — items USD/USDT quedan divididos 1400×; items UYU sin `tc_venta` caen a `/1` como si fueran USD directos. El KPI "Ventas totales" del Resumen Mensual está mal para 100% de los tenants (tanto AR como UY).

**Overall health**: El módulo Ventas single-tenant es **sólido**: atomicidad rigurosa (BEGIN/COMMIT/ROLLBACK bien anidados), stock con guard `WHERE cantidad >= u.cant` que serializa sin deadlock, snapshot de `comision_pct_snapshot` en `venta_pagos` congelado al INSERT, redacción de ganancia con `hasCapability` en 4 sitios distintos, `SALDO_CASE` canónico en 4/5 sitios verificados. Multi-tenant RLS con `SET LOCAL` sistemático en 39+ endpoints, sin ninguna filtración de datos cross-tenant detectada en el track.

Los P0 son consecuencia de **evolución multi-país incompleta**: el rollout UY (F1-F5, PR #514 y siguientes) cubrió Ventas + Cajas + Egresos + Proveedores + Cambios cross-tenant, pero dejó afuera tres módulos secundarios (movimiento CC individual, cobranza masiva, dashboard mensual). Es deuda del backfill, no bugs de diseño.

Los P1 son mayormente **gaps de idempotency y validación server-side** (POST /pagos sin Idempotency-Key vs POST /red-b2b/operations/:id/pagos que sí lo tiene, `monto_total` que la ruta acepta sin cruzarlo contra `items[]`, TC de recurrentes de egresos sin re-validación en el generar-periodo). No hay bugs de atomicidad ni de RLS.

Los P2/P3 son deuda técnica de mantenibilidad (fórmulas duplicadas inline, comentarios `@deprecated` a limpiar, `SET LOCAL` con interpolación en 39 sitios, etc.).

---

## Findings por severidad

### P0 — Contaminación contable, corrupción de saldos multi-divisa, KPIs falsos que afectan cash-flow

#### P0-1 — Pago B2B con caja no-USD rebota o corrompe saldo (multi-país incompleto)

**File**: `backend/src/routes/cuentas.js:554-560`
**Categoría**: Solidez + Seguridad (multi-divisa)

El POST `/api/cuentas/movimientos` (singular — no la cobranza masiva) postea el ingreso a caja hardcodeando `moneda: 'USD', tc: null`:

```js
if (caja_id && ['pago', 'parte_de_pago', 'compra'].includes(tipo)) {
  await postCajaMovimiento(client, {
    caja_id, fecha, tipo: 'ingreso', monto: monto_total, moneda: 'USD', tc: null,
    origen: 'b2b', ...
  });
}
```

Consecuencias:
1. Tenant UY con caja UYU: `postCajaMovimiento` valida `grupoMoneda('UYU') !== grupoMoneda('USD')` y throwea 400 con "la moneda del pago (USD) no coincide con la de la caja (UYU)". El pago B2B individual NO se puede registrar contra caja UYU. Reportado 0 veces (probablemente Lucas no tiene tenants UY que hagan cobros individuales acá — la mayoría cobra por Ventas retail o cobranza masiva).
2. Tenant AR con caja ARS: idéntico — rechazo 400 con "moneda ARS vs USD".
3. Tenant AR con caja USDT: pasa la validación (mismo grupo), pero `monto_total` (nominalmente en USD) se persiste en `caja_movimientos.monto` como si fuera USDT crudo. Si el operador cargó ARS en el frontend (bug histórico si algún cliente tipó ARS creyendo que era USD), termina en la caja USDT como si fuera dólar. Silencioso.
4. Contract violation con el schema: `createMovimientoCCSchema` no tiene campo `moneda` — el schema asume que `monto_total` es siempre USD. Pero el frontend de CuentasCC puede tener casos donde el operador cargue en moneda local (revisar) y el backend no lo detecta.

**Escenario reproducible**:
1. Tenant UY con clientes CC. Crear caja "Efectivo UYU".
2. Cargar cobro individual desde el detalle del cliente CC: `POST /api/cuentas/movimientos` con `tipo=pago`, `caja_id=<caja UYU>`, `monto_total=1000` (interpretado en UYU por el operador).
3. Backend: `postCajaMovimiento` throwea 400 "moneda USD no coincide con UYU". El operador ve un error opaco sin poder registrar el pago.
4. Alternativa peor: si el operador cambia la caja a una USDT (para "que no rebote"), el saldo USDT sube en 1000 unidades (interpretadas como USDT), pero el frontend/dashboard puede seguir mostrando el equivalente USD como 1000 USD → cliente aparece pagado 1000 USD cuando en realidad pagó 1000 UYU (~25 USD).

**Fix propuesto**:
1. Agregar `moneda: MonedaEnum.default('USD')` + `tc: z.coerce.number().positive().optional().nullable()` al `createMovimientoCCSchema`.
2. Aceptar los dos campos en el body del POST, pasar la moneda real al `postCajaMovimiento` con el `tc` correspondiente.
3. Convertir `monto_total` a USD para el `movimientos_cc.monto_total` (que la fórmula `SALDO_CASE` asume que es USD).
4. Assert `assertMonedaValidaParaPais(moneda, req.tenantPais)` como en el resto del track.

**Costo estimado**: ~3h (schema + backend + tests + frontend si hay dropdown de moneda). PR mediano.

---

#### P0-2 — Cobranza masiva rompe UYU: `grupoMoneda` local difiere del canónico

**File**: `backend/src/routes/cuentas.js:1094-1103`
**Categoría**: Solidez + Seguridad (multi-divisa)

```js
const grupoMoneda = (m) => m === 'ARS' ? 'ARS' : 'USD';
for (let i = 0; i < cobranzasOrdenadas.length; i++) {
  const c = cobranzasOrdenadas[i];
  const monedaCaja = cajaMoneda.get(c.caja_id);
  if (grupoMoneda(monedaCaja) !== grupoMoneda(c.moneda)) {
    await client.query('ROLLBACK');
    return res.status(400).json({...});
  }
}
```

El `cajaLedger.js` (`lib/cajaLedger.js:19-23`) define `grupoMoneda` con 3 grupos: `ARS`, `UYU`, `USD` (donde USD=USD/USDT). Esta función local en cobranza masiva solo tiene 2 grupos: `ARS` y todo lo demás (incluido UYU) como "USD".

Efecto: un tenant UY que carga cobranza masiva con `moneda: 'UYU'` y caja "Efectivo UYU" pasa la validación local (UYU y UYU ambos caen al else "USD"), pero al llegar al INSERT bulk `caja_movimientos` NO pasa por el `postCajaMovimientoBulk` — el código hace INSERT directo sin validar grupo (líneas 1131-1148). El monto (UYU) queda persistido en la caja UYU, PERO el `montosUsd[i]` calculado en línea 1107 usa `toUsd(monto, 'UYU', tc)` — si el TC vino correcto → USD equivalente correcto en `monto_usd`, y el `monto` en la caja queda en UYU crudo → el saldo nativo de la caja funciona bien.

**El bug real** es peor: si el tenant UY intenta cargar una cobranza UYU contra una caja **USDT** (pensando que va a convertir), el `grupoMoneda(USDT)='USD'` matches `grupoMoneda(UYU)='USD'` en la lógica local → pasa validación → el INSERT en `caja_movimientos` mete el monto UYU crudo en la caja USDT como si fuera USDT. La caja USDT queda inflada por 40× (para UYU) o 1400× (si es tenant AR con moneda malintepretada).

**Escenario reproducible**:
1. Tenant UY con caja "Wallet USDT" (moneda=USDT).
2. Cargar cobranza masiva de 3 clientes en UYU: `[{cliente_cc_id: 1, monto: 10000, moneda: 'UYU', tc: 40, caja_id: <caja USDT>}, ...]`.
3. Backend pasa validación (UYU y USDT ambos caen al grupo "USD").
4. `montosUsd[0] = round2(10000/40) = 250` — se persiste `movimientos_cc.monto_total=250` y `caja_movimientos.monto_usd=250` (OK).
5. `caja_movimientos.monto = 10000` en la caja USDT.
6. Saldo nativo de la caja USDT: 10000 unidades sumadas. Debería ser 250. **Corrupción de saldo × 40**.

**Fix propuesto**:
1. Import `grupoMoneda` desde `cajaLedger.js` (ya está exportado — línea 281). Eliminar la definición local.
2. Alternativamente, en vez de usar `grupoMoneda` inline, pasar la cobranza por `postCajaMovimientoBulk` (que ya valida grupo correctamente) en vez del INSERT directo.
3. Test regresión: cobranza UYU contra caja USDT → 400.

**Costo estimado**: ~1h. Fix chico.

---

#### P0-3 — Dashboard Mensual `topProductos`/`topVendedores` divide por `tc_venta` sin distinguir moneda del item

**File**: `backend/src/lib/dashboardMensual.js:66-80, 86-101`
**Categoría**: Solidez (KPI falso)

```sql
COALESCE(SUM(vi.precio_vendido * vi.cantidad
  / NULLIF(CASE WHEN v.tc_venta > 0 THEN v.tc_venta ELSE 1 END, 0)), 0) AS total_usd
```

El CASE **NO chequea** `vi.moneda` como sí lo hace el dashboard general (`routes/ventas.js:611-619, 674-678`):

```sql
-- Dashboard general (correcto):
SUM(CASE WHEN vi.moneda IN ('ARS','UYU') AND v.tc_venta > 0 
         THEN vi.precio_vendido*vi.cantidad/v.tc_venta 
         ELSE vi.precio_vendido*vi.cantidad END)
```

Efectos:
1. **Tenant AR con items USD**: `precio_vendido=100` (USD), `tc_venta=1400`. Fórmula → `100/1400 = 0.07 USD`. Debería ser `100 USD`. Subestima 1400×.
2. **Tenant UY con items UYU sin tc_venta seteado**: fórmula → `precio_vendido/1 = precio_vendido crudo` como si fuera USD. Sobrestima 40×.
3. **Tenant AR con items ARS + tc_venta**: fórmula → OK, coincide con el dashboard general.

Esto significa que el Resumen Mensual `/api/dashboard/resumen-mensual` — que Lucas usa para cash-flow mensual — **miente para el 100% de los tenants** con ventas USD (todo tenant AR con ventas de electrónica USD, todo tenant UY, cualquier venta multi-moneda). Los rankings de "top producto" y "top vendedor" tienen orden distorsionado, y los "total_usd" en cada fila están mal.

**Escenario reproducible**:
1. Tenant AR, vender un iPhone 15 Pro a $1000 USD (item con `moneda='USD'`).
2. `tc_venta=1400` (setear porque hay canjes ARS o pagos ARS).
3. GET `/api/dashboard/resumen-mensual?periodo=2026-07`.
4. Response: `top_productos[0].total_usd = 0.71` (deberia ser 1000).
5. Idem `top_vendedores`. El ranking se preserva relativamente entre items USD, pero los valores son 1400× menores.

**Fix propuesto**: reemplazar el CASE por el del dashboard general (`vi.moneda IN ('ARS','UYU') AND v.tc_venta > 0` en el WHEN). Copiar exactamente la fórmula de `routes/ventas.js:614`. Un solo replace en dashboardMensual.js. Testear con venta mixta ARS + USD + UYU + USDT.

**Costo estimado**: ~1h (SQL + tests). Fix chico. **Prioridad alta** — Lucas usa este dashboard mensual con frecuencia.

---

### P1 — Bugs de idempotency, validación server-side y consistencia contable

#### P1-1 — `POST /api/ventas` sin Idempotency-Key (doble-click duplica venta completa)

**File**: `backend/src/routes/ventas.js:1223-1323`
**Categoría**: Solidez (race/duplicidad)

El endpoint no acepta ni valida `Idempotency-Key`. Un doble-click desde el modal "Nueva Venta" (o un retry de red desde el frontend después de un timeout) genera **2 ventas idénticas**:
- 2 rows en `ventas` con distinto `order_id` (por `crypto.randomBytes(6)`).
- Stock descontado 2×.
- Deuda CC creada 2× si hay pago CC.
- 2 caja_movimientos ingreso por caja.
- 2 cobros de tarjeta si hay pago tarjeta.
- 2 comprobantes de Financiera si hay pago financiera.
- 2 emails de comprobante al cliente.

El único guardrail es el `crypto.randomBytes(6)` para el `order_id` — pero el resto se duplica. La red B2B (COR-1 audit 2026-07-06) ya implementó `Idempotency-Key` en `POST /api/red-b2b/operations/:id/pagos` con el mismo mecanismo (column `client_generated_id UUID` + UNIQUE index parcial + early check + 409 estable). El POST venta debería replicar el patrón.

**Escenario reproducible**:
1. Operador crea venta con 3 items + pago tarjeta.
2. Frontend hace POST `/api/ventas`, tarda 800ms.
3. Operador hace segundo click (Chrome no bloquea el submit por default).
4. Backend recibe 2 requests, ambos pasan validación, ambos INSERT ventas → 2 ventas, stock descontado 2× (si `WHERE cantidad >= u.cant` alcanza para las dos), 2 cobros de tarjeta, 2 emails al cliente.
5. Impacto real: contabilidad rota, cliente recibe 2 comprobantes, stock queda inflado si la 2da falla el guard.

**Fix propuesto**:
1. Column `client_generated_id UUID` en `ventas`.
2. Index parcial `UNIQUE (tenant_id, client_generated_id) WHERE client_generated_id IS NOT NULL AND deleted_at IS NULL`.
3. Early check: `SELECT * FROM ventas WHERE client_generated_id = $1 AND tenant_id = current_setting(...)::int`. Si existe → devolver 200 con la venta previa (idempotent replay).
4. Frontend genera UUID al abrir el modal (uuidv4 client-side) y lo envía como header `Idempotency-Key`.
5. Aplicar mismo patrón a `POST /api/cuentas/movimientos` (crea deuda CC + caja_movimiento), `POST /api/proveedores/movimientos` (crea compra + caja_movimiento + productos), `POST /api/tarjetas/liquidaciones`, `POST /api/cambios/movimientos`.

**Costo estimado**: ~6h (migration + backend + frontend + tests × 5 endpoints). PR mediano.

---

#### P1-2 — `sanidad.js` `generar` recurrentes-de-egresos con TC stale (multi-país)

**File**: `backend/src/routes/egresos.js:196-224`
**Categoría**: Solidez (KPI falso)

El endpoint `POST /api/egresos/generar` copia el TC del recurrente al momento de generación:

```js
const monto_usd = round2(toUsd(Number(r.monto), r.moneda, r.tc));
```

Si el recurrente se creó con `tc=1400` hace 3 meses y hoy el TC real es `2100`, los egresos generados en el mes actual quedan sobre-valorados en USD (el operador cargó 40000 ARS = 28.57 USD hoy, pero se computa a 40000/1400 = 28.57 aunque hoy sería 40000/2100 = 19.04). No hay update del TC al momento de generar — quedan con el TC del creador del recurrente.

Peor: no hay validación de `tc>0` al momento de generar si el recurrente se creó con `moneda='UYU'` en un tenant UY viejo cuando el schema aceptaba UYU sin TC. La validación P1 en `_recurrenteBase` (línea 34) sí exige TC ahora, pero **filas legacy sin TC** siguen en la DB y generan con `toUsd(monto,'UYU',null)=0` → egresos con `monto_usd=0` → dashboard cash-flow subestimado.

**Fix propuesto**:
1. Al generar, si `r.tc IS NULL` y `r.moneda` requiere TC, usar `getTcDefaultPais(client, tenantPais)` como fallback → si tampoco hay, no generar y devolver el error al frontend con lista de recurrentes que quedaron sin generar.
2. UI: mostrar warning en el listado de recurrentes con TC stale (>7 días desde el update).
3. Alternativa mínima: exigir refresh del TC al generar (el frontend Egresos.jsx podría ofrecer un input "TC del período" al llamar al generar).

**Costo estimado**: ~2h. Chico.

---

#### P1-3 — `PATCH /api/tarjetas/movimientos/:id` liquidación no valida saldo cross-caja

**File**: `backend/src/routes/tarjetas.js:733-834`
**Categoría**: Solidez (contabilidad)

Cuando se edita una liquidación cambiando `monto` o `caja_id`, el flow es (línea 802): `reverseCajaMovimientos()` (revierte AMBOS: ingreso destino + egreso caja-tarjeta) → UPDATE fila → repost. El `reverseCajaMovimientos` valida saldo post-reverse por cada caja individualmente.

Problema: si el operador cambia caja destino de `USD Efectivo` a `Wallet USDT`, la reversa del `USD Efectivo` puede fallar con 409 (dinero ya se gastó de esa caja) — pero **el mensaje no distingue** entre "esta caja quedaría negativa por el reverse" y "cambiaste la caja destino". El operador ve "no se puede deshacer: dejaría la caja USD Efectivo en saldo negativo" y no entiende por qué (él solo cambió la caja destino, no está deshaciendo nada).

Además: el UPDATE de `tarjeta_movimientos` **borra `pct=0, monto_comision=0`** (línea 811) al editar la liquidación — pero si la liquidación tenía metadatos originales del cobro (edge case: pre-refactor liquidaciones tenían `pct` no-cero por bug), se pierden silenciosamente en el UPDATE. No es un bug si el schema garantiza `pct=0` en liquidaciones (parece que sí), pero vale confirmar.

**Fix propuesto**:
1. UX mejorada: distinguir el mensaje del 409 según origen (¿es reverse por cancelación o por edit de caja?).
2. Validar que el UPDATE preserve el shape esperado (pct=0, monto_comision=0 SOLO para liquidaciones).
3. Documentar en el header del PATCH que el flow es reverse+repost (no in-place UPDATE) para que un dev futuro no lo "optimice" mal.

**Costo estimado**: ~2h. Chico.

---

#### P1-4 — `financiera.js:recalcComprobantesFinancieraByTenant` `@deprecated` pero exportado (tentación de bug)

**File**: `backend/src/lib/financiera.js:296-306, 308-312`
**Categoría**: Excelencia (deuda técnica)

La función está marcada `@deprecated` con comentario de 30+ líneas explicando por qué no llamarla (D-01 audit) y sigue exportada en `module.exports`. Cualquier dev nuevo que la vea puede pensar que resuelve el problema y llamarla desde un script admin o un cron. Si eso pasa, TODOS los comprobantes históricos se recalculan con el pct actual de config → bug P0 documentado.

Además: el propio comentario dice "queda para tests de smoke y eventuales scripts admin". No hay ni test ni script — el código está **muerto**.

**Fix propuesto**:
1. Borrar la función y el export. Si algún futuro admin necesita este comportamiento, que lo re-escriba desde cero con contexto fresco (probablemente el requerimiento sería distinto).
2. Si Lucas quiere preservar por si acaso, moverla a `docs/legacy/recalc-financiera.snippet.js` con nota de "no importar — snippet histórico".

**Costo estimado**: 15 minutos.

---

#### P1-5 — `syncTarjetaCobros` lookup por `venta_id + metodo_pago_id + monto_bruto` es frágil

**File**: `backend/src/lib/comisionesMetodos.js:63-73`
**Categoría**: Solidez (invariante contable)

El WITH `tarjeta` matchea `tarjeta_movimientos` con `venta_pagos` por triple JOIN:

```sql
JOIN venta_pagos vp
  ON vp.venta_id       = tm.venta_id
 AND vp.metodo_pago_id = tm.metodo_pago_id
 AND vp.monto          = tm.monto_bruto
```

Si la venta tiene 2 pagos con el **mismo `metodo_pago_id` y el mismo `monto`** (edge case: dos pagos de $500 con la misma tarjeta Visa por si el POS falló al cobrar $1000 en 1), el JOIN mata 4 rows (2×2) y suma la comisión 2×. Idem si el operador edita la venta y accidentalmente crea 2 pagos idénticos.

El comentario de la función lo advierte ("Si por bug del sync hubiera duplicados o huérfanos, el JOIN inner los filtra silenciosamente"), pero el filtro NO ES silencioso — es un **duplicado** (2×2=4 en vez de 2 esperado).

**Fix propuesto**: usar `venta_pagos.id` como clave del JOIN. Migration: agregar `tarjeta_movimientos.venta_pago_id` (FK a `venta_pagos.id`), backfill con el primer pago que matchee el triple JOIN, y luego JOIN por `tm.venta_pago_id = vp.id`.

**Costo estimado**: ~4h (migration + backfill + backend + tests). Impacto real: en la práctica los operadores no cargan 2 pagos idénticos con la misma tarjeta, así que probablemente los datos históricos están OK — pero el riesgo silencioso amerita fix.

---

### P2 — Edge cases raros / inconsistencias detectables

- **P2-1**: `postCajaMovimientoFinanciera` (lib/financiera.js:239) hardcodea `tc: null` con comentario "hoy la caja FV es ARS — si en el futuro hay FV en USD/USDT, ajustar". Cuando el usuario configure Financiera en un tenant UY (que hoy no existe en prod pero está en el pipeline), el pago va a corromper el `monto_usd`. Un tenant AR que crea la caja "Financiera USDT" tampoco funciona (rebota con "moneda no coincide"). Debt documentada, pero sin plan.

- **P2-2**: `dashboardMensual.js:pagosPorMetodo` (líneas 133-136) lanza `getTcDefaultPais(exec, 'UY')` y `getTcDefaultPais(exec, 'AR')` **para todos los tenants**, incluso si el tenant es AR (`tc_uyu` es inútil para él). Overhead mínimo pero conceptualmente incorrecto — se debería usar `req.tenantPais` como filtro. Cost: 15 min.

- **P2-3**: `tarjetas.js` PATCH liquidación USD (líneas 776-793) valida que `montoUsdParaCaja > 0` post-cálculo, pero no valida que `monto/tcNuevo` no dé un valor absurdo tipo 1e10 si el TC viene en 0.0001. El schema Zod ya cubre `tc.positive()` pero no acota máximo — un TC de `0.0000001` acumulado en 100 liquidaciones podría inflar la caja USD a millones. Cost: 15 min (agregar `.max(1e6)` al TC).

- **P2-4**: `cuentas.js:1094` `grupoMoneda` local NO exporta la misma matriz que `cajaLedger.js:19`. Es una función de 1 línea que ya está exportada del lib canónico. Copy-paste con drift. Cost: 5 min (mismo fix del P0-2 en realidad, pero mencionable como higiene).

- **P2-5**: `comisionesMetodos.js:78-88` — el WITH `financiera` usa `LIMIT 1` con `ORDER BY vp.id` para elegir el pago financiero. Si una venta tiene 2 pagos financiera (edge case por bug de UI o edit doble), toma solo el primero. `syncFinancieraComprobante` (`lib/financiera.js:19-25`) también hace `LIMIT 1` sin definir orden ("hay solo un comprobante por venta"), lo que hace que el LIMIT 1 del comprobantes JOIN vs el LIMIT 1 del venta_pagos puedan estar **en filas distintas** si algo se rompe. Cost: 30 min (agregar UNIQUE parcial `WHERE es_financiera=true` en venta_pagos por venta_id).

- **P2-6**: `cambios.js:181-192` `POST /movimientos` no chequea que la moneda del `caja_id` sea compatible con el `tipo` — un tenant UY que use el módulo Cambios en single-tenant hoy no puede crear un `entrega_uyu` porque el schema `createMovimientoSchema` (línea 24) solo acepta `['entrega_ars', 'recibo_usd']`. Los tipos `entrega_uyu`/`recibo_usd_uy` SOLO se usan desde `crossTenantPagos.js` (Red B2B). Un tenant UY que abre Cambios va a operar en ARS (que su tenant no tiene habilitado por `assertMonedaValidaParaPais`). Cost: ~2h (backfill schema + frontend UY-aware para el select de tipos).

### P3 — Deuda técnica cosmética / mantenibilidad

- **P3-1**: `SET LOCAL app.current_tenant = ${req.tenantId}` con interpolación de string en 39+ sitios (rutas financieras). `req.tenantId` es Int por middleware, así que no hay riesgo de SQL injection real, pero es inconsistente con el patrón `$1` del resto de queries del repo. Ya marcado como P3-6 en Red B2B audit. Cost: ~2h para batch replace + tests.

- **P3-2**: Fórmula `SALDO_CASE` **duplicada inline** en `cuentas.js:148-160` (endpoint GET `/clientes`). El propio archivo importa `SALDO_CASE_M` en línea 70 pero no lo usa en este bloque. Silbato de S-03 audit, incompleto. Cost: 5 min.

- **P3-3**: `ventas.js:calcularTotales` recibe `items` y `tc` como argumentos separados pero el `items[i].moneda` puede ser mixto — la función no valida que los items con `moneda='ARS'|'UYU'` tengan tc>0 antes de dividir. `validarTc` lo hace, pero solo para el POST/PUT — un caller externo que use `calcularTotales` sin validar antes obtiene `NaN`/`0`. Cost: 15 min (defensive check inside).

- **P3-4**: `router.get('/dashboard/negativas', ...)` en `cajas.js:231-248` NO tiene `requireCapability` — está gate solo por el auth global de `cajas.trabajar` en app.js. Un vendedor con `cajas.trabajar` ve todas las cajas del tenant en negativo. Debería requerir `cajas.crear` o similar (info sensible). Cost: 5 min.

- **P3-5**: `ventas.js:82-89` — el key generator del `enviarComprobanteLimiter` cae a `ipKeyGenerator(req)` si `req.tenantId` es null, pero el limiter tiene `skip: () => isTestEnv` — en prod el fallback nunca debería dispararse porque `requireAuth` ya rebotó. Deuda cosmética. Cost: 5 min (assert vs fallback).

- **P3-6**: `tarjetas.js:1094` (`grupoMoneda` local) y `pagos.js:13` (`grupoMoneda` local) y `cambios.js` (no lo tiene inline pero delegado en `postCajaMovimiento`) — la lógica `grupoMoneda` está en **3 archivos distintos**. `cajaLedger.js` ya lo exporta canónicamente. Cost: 15 min (importar en los 3 sitios).

- **P3-7**: `dashboardMensual.js:216-227` lanza `Promise.all` de 3 queries (`ventas TC`, `alertas_config TC`, `getTcDefaultPais(UY)`) — están en la misma tx y el mismo `exec` client. Con pg@9+ **NO hay paralelismo real** sobre el mismo client (el protocolo es secuencial). Es un `Promise.all` cosmético que se serializa. Cost: 5 min (eliminar `Promise.all`, chainear await).

- **P3-8**: `ventas.js:calcularTotales` (línea 136-144) NO redondea individualmente por item — acumula raw floats y solo `round2` al final. Para ventas de 50 items la propagación del error de coma flotante es ~1e-11 por item, acumula 5e-10 — indetectable. Pero el patrón de `round2` inside-out vs outside-in es inconsistente entre `calcularTotales` (outside), `syncComisionTotalMetodos` (mixed), `dashboardMensual.snapshotCajas` (por-fila). Deuda cosmética. Cost: 15 min unificar (o mejor: dejar como está y documentar la decisión).

- **P3-9**: `alertas.js:37-52` `evalCajaNegativa` no filtra `mp.deleted_at IS NULL` explícitamente en el HAVING (solo en el WHERE del outer). Si una caja con saldo negativo se soft-deletea, deja de aparecer en las alertas — correcto. Pero el saldo histórico "negativo pre-borrado" queda huérfano. Deuda documental. Cost: 0 (no fix — dejar como está pero mencionar en el header de la función).

---

## Buenas prácticas verificadas

1. **Atomicidad de ventas rigurosa**: POST/PUT/DELETE en `routes/ventas.js` usan `BEGIN/COMMIT/ROLLBACK` con `try/catch/finally` correcto (líneas 1223-1323, 1325-1441, 1507-1537). El `client.release()` en `finally` está correctamente separado del rollback en el catch (fix P-15 auditoría 2026-06-10 verificado).
2. **Snapshot inmutable de comision_pct**: `venta_pagos.comision_pct_snapshot` se congela al POST (línea 262) y sella lazy en `syncTarjetaCobros` (line lib/tarjetas.js:117-127). Idem `comprobantes.pct_aplicado` (lib/financiera.js:64-105). D-01 audit correctamente implementado — cambios de config NO afectan histórico.
3. **`SALDO_CASE` canónico** usado en `alertas.js`, `dashboardMensual.js`, `chat-tools.js` y `cuentas.js` (endpoint `/clientes/:id/resumen`, `/resumen-general`, `/clientes/search`). Solo GET `/clientes` (línea 148-160) tiene la fórmula duplicada inline — deuda P3-2 pero MISMO comportamiento (verificado).
4. **`postCajaMovimiento` valida grupo moneda + saldo no-negativo** con `FOR UPDATE` (cajaLedger.js:37-89) — race-safe, atómico.
5. **`reverseCajaMovimientos` valida saldo post-reverse** por caja afectada (cajaLedger.js:125-148) — previene el "revert deja caja en negativo" documentado en H-03. Order-locked por caja_id ascendente para evitar deadlock.
6. **`postCajaMovimientosBulk`** (cajaLedger.js:177-273) usa lock ordenado + validación agregada del delta neto por caja — semántica correcta para el caso ventas (solo ingresos, delta positivo, skipea el check).
7. **`syncVentaCaja` idempotente**: `reverseCajaMovimientos` primero + repost desde `venta_pagos` — permite re-syncar sin duplicar ni perder movimientos. Filtro `mp.deleted_at IS NULL` en el JOIN (D-21 audit) previene resucitar cajas archivadas.
8. **Multi-tenant RLS con `SET LOCAL`** en 39+ sitios verificados. `withTenant` + `SET LOCAL` en el mismo cliente PG — snapshot consistente entre queries de la misma tx.
9. **Redacción de `ganancia_usd`** en 4 sitios distintos con `hasCapability` (ventas.js:157-163, 921-956, 1214-1218, 1316, 1401, 1434 + dashboard.js:74-84). Defense in depth — el frontend también oculta, pero el backend redacta para llamadas directas a la API. F5b bien implementado.
10. **Multi-país F1-F5**: `assertMonedaValidaParaPais` en ventas.js:1231-1239, 1337-1345, cajas.js:259/304, egresos.js:127/151/261/311, proveedores.js:456 — coverage 5/9 rutas verificado. Los faltantes son cuentas.js (P0-1), pagos.js (P2-1) y comprobantes.js manuales.
11. **`comprobantes.js`** con soft-delete atómico + revert de caja + audit-in-tx (H6 pattern). `venta_id IS NULL` guard previene edit/delete de comprobantes autogenerados desde ventas (líneas 291-294, 384-388).
12. **Idempotency de `syncFinancieraComprobante`** con paths A/B/C/D cubriendo sealing lazy vs. INSERT nuevo (lib/financiera.js:66-105). Comentado con precisión.
13. **`cancelMovimientoCC` centralizado**: DELETE `/movimientos/:id`, cascade de `/clientes/:id`, y `/admin/orphan-movs` usan el mismo helper (lib/cancelMovimientoCC.js). Guard #B-06 correcto (no cancela devolución si stock ya revendido).
14. **Ownership check en `cuentas.js` y `proveedores.js`** con bypass `owner|admin` (cuentas.js:830-836, proveedores.js:848-854) — F5a TANDA 1 P1 correctamente aplicado post-F4 (self-signup owners no son global admin).
15. **Test coverage financiero**: 23 archivos de test entre `ventas`, `cajas`, `cuentas`, `cambios`, `tarjetas`, `proveedores`, `financiera`, `comprobantes`, `dashboard`, `sanidad`, `egresos` — sólido baseline para el fix de P0/P1.

---

## Preguntas abiertas (para decisión de Lucas)

1. **P0-1 fix scope**: al agregar `moneda` + `tc` al `createMovimientoCCSchema`, ¿el frontend `CuentasCC.jsx` ya tiene UI para elegir moneda del pago o hay que agregarla? Si hay solo un dropdown de caja, el frontend puede derivar la moneda de la caja seleccionada (menos flexibilidad, menos código UI).
2. **P0-2**: cobranza masiva UYU en tenants UY, ¿ya está en uso por algún cliente hoy? Si no hay data corrupta, el fix se puede aplicar sin backfill. Si sí, hay que revisar `caja_movimientos` con `origen='b2b'` en cajas USDT de tenants UY.
3. **P0-3 fix**: al corregir `topProductos`/`topVendedores`, los valores del Resumen Mensual van a **cambiar** para tenants con ventas USD (hoy están subestimados 1400×). Lucas: ¿comunicar a los ~10 clientes que "los top del resumen mensual estaban mal desde el rollout multi-país"? O aplicar fix y no notificar (el ranking relativo se mantiene, solo los valores absolutos cambian).
4. **P1-1 (Idempotency-Key)**: ¿aplicarlo solo a POST venta (mayor volumen) o a los 5 endpoints (venta, cuentas/movimientos, proveedores/movimientos, tarjetas/liquidaciones, cambios/movimientos)? El costo escala pero el patrón es idéntico. Recomiendo los 5 en un solo sprint para consistencia.
5. **P1-4 (`recalcComprobantesFinancieraByTenant`)**: la función está deprecated + no llamada. ¿Borrar o mover a `docs/legacy/`? Si Lucas prevé un caso admin extraordinario (ej. Sentry issue con datos corruptos que requieran recalcular todo el histórico), preservar como snippet documentado.
6. **P2-1 (Financiera en UYU/USDT)**: ¿está agendado para F6+ o es solo aspiracional? Hoy `postCajaMovimientoFinanciera` hardcodea `tc: null` con nota "ajustar cuando corresponda".
7. **P2-6 (Cambios UYU single-tenant)**: ¿algún cliente UY hoy tiene financiera de cambio (peso→USD) operando en pesos UYU? Si sí, hay que priorizar. Si no, backlog razonable.
8. **P3-1 (SET LOCAL con interpolación en 39 sitios)**: ¿aceptable convivir con esto o Lucas quiere un batch replace? Sin riesgo real de injection, pero convención inconsistente.

---

## Plan de acción sugerido

**Sprint 1 — P0 críticos** (~2 días de trabajo, 3 PRs):

- **PR A** (~3h): fix P0-1 (moneda en POST /cuentas/movimientos). Backend + schema + test + frontend picker si aplica.
- **PR B** (~1h): fix P0-2 (cobranza masiva UYU) — importar `grupoMoneda` desde `cajaLedger.js` + test de regresión.
- **PR C** (~1h): fix P0-3 (dashboard mensual top items) — copiar el CASE del dashboard general de ventas.js. Impacto en KPIs — comunicar a clientes activos si Lucas lo decide.

**Sprint 2 — P1 importantes** (~3 días, 3 PRs):

- **PR D** (~6h): fix P1-1 (Idempotency-Key en 5 endpoints POST de dinero). Migration + backend + frontend + tests. Sprint mediano.
- **PR E** (~2h): fix P1-2 (recurrentes egresos TC fallback multi-país) + P1-3 (UX PATCH liquidación).
- **PR F** (~4h): fix P1-5 (`tarjeta_movimientos.venta_pago_id` para matching robusto en `syncComisionTotalMetodos`). Migration + backfill + tests.

**Sprint 3 — P2/P3 batch** (~1 día, 1 PR):

- **PR G** (~6h): batch de higiene:
  - P1-4: borrar `recalcComprobantesFinancieraByTenant` deprecated
  - P2-2: `pagosPorMetodo` skipea TCs no relevantes al país
  - P2-3: `.max()` al TC en PATCH liquidación
  - P2-5: UNIQUE parcial `venta_pagos` para pagos financiera
  - P3-2: eliminar SALDO_CASE inline en cuentas.js:148-160
  - P3-4: `requireCapability('cajas.crear')` en GET `/cajas/negativas`
  - P3-6: unificar `grupoMoneda` desde `cajaLedger.js` (3 sitios)
  - P3-7: eliminar `Promise.all` cosmético en dashboardMensual

**Total estimado**: ~6 días de trabajo distribuidos en 7 PRs, con foco en Sprint 1 (fix P0 en 2 días) como bloqueador para clientes UY nuevos.

---

**Archivos principales de referencia**:
- `backend/src/routes/{ventas,cajas,cuentas,cambios,tarjetas,proveedores,egresos,pagos,comprobantes,cajaTransferencias,dashboard,sanidad}.js`
- `backend/src/lib/{money,saldoCC,cajaLedger,ventaSync,financiera,tarjetas,tarjetasSaldo,comisionesMetodos,cancelMovimientoCC,dashboardMensual,alertas}.js`
- `backend/src/schemas/{ventas,cajas,cuentas,cambios,tarjetas,proveedores,egresos,pagos,comprobantes,_common}.js`
- Tests: 23 archivos financieros en `backend/tests/` — sólido baseline.

Auditoría completa. 23 findings totales, 34 archivos revisados.
