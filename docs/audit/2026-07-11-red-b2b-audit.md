# Auditoría Red B2B — Consistencia cross-tenant + suma cero

**Fecha**: 2026-07-11
**Auditor**: Claude Opus (asistido por 3 sub-agentes de análisis en paralelo).
**Alcance**: `backend/src/routes/redB2b/*`, `backend/src/lib/{crossTenantOps,crossTenantPagos,partnership,redB2bEmail}.js`, `backend/src/schemas/redB2b.js`, migrations relacionadas, frontend `RedB2B*` (referencial).
**Método**: revisión de código con foco en atomicidad, RLS bypass, invariantes contables, race conditions y sanidad numérica.

---

## TL;DR

El feature está **bien pensado y bien defendido**. La atomicidad de las tres operaciones core (crear operación, registrar pago, devolución) es rigurosa; la suma cero de dinero y stock se cumple por diseño; hay muchos fixes fechados (SEG-1, SEG-2, COR-1/2/3, PR-B B1/H2/H3, BLOCKER UYU multi-país) que muestran que el equipo ya trató este flujo con seriedad.

**Sin embargo**, hay **3 issues P0 reales** que rompen invariantes cross-tenant o de fecha:

1. **Contaminación cross-tenant en `ensureSellerClienteCc` / `ensureBuyerProveedor`** — un cliente_cc o proveedor con el mismo nombre en otro tenant puede quedar linkeado a la operación B2B. Impacto: saldos B2B mezclados con retail.
2. **Timezone en `paid_until`** — comparación contra UTC deja tenants "expirados" 3h del día siguiente en AR.
3. **`getActivePartnershipById` no filtra `status='active'`** — hoy cubre por detrás `validateOperationPrecondition`, pero es una trampa esperando romperse.

Además, **5 P1** (precio 0 aceptable, tolerancia del cliente en total_usd, devolución sin idempotency, notas no propagadas, hueco en conciliación con `entrega_mercaderia`) y varios P2/P3.

---

## Findings por severidad

### P0 — Impacto contable / cross-tenant real

#### P0-1 — Contaminación cross-tenant en helpers `ensureXxx`

**Files**:
- `backend/src/lib/crossTenantPagos.js:180-186` (`ensureSellerClienteCc`)
- `backend/src/lib/crossTenantPagos.js:208-214` (`ensureBuyerProveedor`)
- Similar riesgo en `backend/src/lib/crossTenantOps.js:263-282, 448-467`

**Problema**: El SELECT lookup por nombre **no filtra `tenant_id`**. Como el pool es `tecny_admin` (BYPASSRLS), el `SET LOCAL app.current_tenant` **no protege** — es solo para policies de RLS.

**Escenario de daño**:
1. Tenant B ("Foo Corp") se hace partner de Tenant A.
2. Tenant A tiene un `cliente_cc` legacy "Foo Corp" desde antes (cliente retail sin relación con Red B2B).
3. `ensureSellerClienteCc(client, sellerA, buyerB)` hace `SELECT ... WHERE LOWER(nombre) = 'foo corp'` sin filtro tenant → devuelve el `cliente_cc.id` del **otro tenant** (o si es del propio A pero de contexto retail, lo mezcla).
4. INSERT en `movimientos_cc` con ese `cliente_cc_id` cruzado → los reportes del cliente CC retail muestran deuda/pago fantasma de Red B2B.

**Impacto**: mezcla contable seria. Puede afectar a cualquier tenant en producción con colisión de nombres.

**Fix**:
1. Agregar `AND tenant_id = $N` al SELECT lookup en ambos helpers.
2. Pasar `tenantId` como parámetro explícito (hoy usa el del contexto SET LOCAL).
3. Agregar `UNIQUE (tenant_id, LOWER(nombre)) WHERE deleted_at IS NULL` en `clientes_cc` y `proveedores` como blindaje.
4. Verificar `crossTenantOps.js:263-282, 448-467` (auto-create en POST /operations) — mismo patrón, mismo riesgo.

**Costo estimado**: ~1 día (backend + migration + tests). PR mediano.

---

#### P0-2 — `paid_until` comparado contra "hoy" en UTC

**File**: `backend/src/lib/crossTenantOps.js:84`

```js
const today = new Date(new Date().toISOString().slice(0, 10));
```

`new Date().toISOString()` fuerza UTC. Un tenant en AR (UTC-3) que pagó hasta `2026-07-10` va a ser rebotado como `expired` desde las 21:00 hora AR del 10 hasta las 00:00 del 11 (3 horas de bloqueo).

**Impacto**: incidentes recurrentes al final del día. El cliente que pagó hasta hoy no puede operar. Feo, incidencia repetible.

**Fix**: comparar `paid_until >= CURRENT_DATE` en SQL con `AT TIME ZONE 'America/Argentina/Buenos_Aires'` (o UYU según tenant.pais). Alternativa mínima: extender el rango 24h (`paid_until >= today - 1`).

**Costo estimado**: ~2h. Fix chico.

---

#### P0-3 — `getActivePartnershipById` no filtra por status

**File**: `backend/src/lib/partnership.js:68-76`

El helper se llama "Active" pero el SELECT **no tiene** `AND status = 'active'`. Hoy `validateOperationPrecondition` (`crossTenantOps.js:55`) rebota con `partnership_not_active` cuando el status no matchea. En la práctica cubre el hueco.

**Riesgo real**: si mañana alguien agrega un feature con `status='paused'` o similar y olvida chequear en `validateOperationPrecondition`, este helper deja pasar cualquier partnership. Costo del error futuro: alto (permite operar con partnership no-active).

**Fix**: renombrar a `getPartnershipByIdForTenant` (semántica real) **O** agregar `AND status = 'active'` al WHERE del helper.

**Costo estimado**: 30 minutos. Fix trivial.

---

### P1 — Bugs de contabilidad / DoS / integridad

#### P1-1 — `precio_usd` acepta `0`

**File**: `backend/src/schemas/redB2b.js:52` — `precio_usd: z.coerce.number().nonnegative()`

Un item con `precio_usd = 0` y `cantidad = N` pasa la validación. El seller pierde N unidades de stock sin CC contrapartida por ese line item.

**Impacto**: la suma cero de total_usd sigue cuadrando (porque otros items compensan), pero los line items internos están desbalanceados. Detección post-hoc dificil.

**Fix**: `precio_usd: z.coerce.number().positive()`.

**Costo estimado**: 5 minutos + regenerar tests que usaran precio 0.

---

#### P1-2 — Sanity check `sum(items) ≈ total_usd ±0.01` explotable

**File**: `backend/src/routes/redB2b/operations.js:189-199`

Server acepta el `total_usd` del cliente si cumple `|sum(items) - total_usd| < 0.01`. Un cliente malicioso puede enviar `total_usd = round2(sumUsd) - 0.005` → la deuda del buyer se reduce en 1 centavo por operación (acumulable).

**Impacto**: 1 centavo por op → indetectable a mano. En 10K operaciones, 100 USD que el seller nunca cobra.

**Fix**: ignorar `body.total_usd` completamente y usar `round2(sumUsd)` como source of truth para el INSERT en `cross_tenant_operations`, `movimientos_cc` y `proveedor_movimientos`. Idem `total_ars`.

**Costo estimado**: ~1h (backend + tests).

---

#### P1-3 — `POST /operations/:id/devolucion` sin Idempotency-Key

**File**: `backend/src/routes/redB2b/pagos.js:833+`

El endpoint no acepta `Idempotency-Key`. Doble-click desde el UI (o retry de red) genera 2 devoluciones si la primera no llega al 100%. La validación H3 (`totalUsdDev ≤ maxDevolvibleUsd`) cubre el caso del 100%, pero permite duplicidad parcial.

**Escenario**: buyer devuelve 5 de 10 unidades. Doble-click → devuelve otras 5 en la 2da request. Stock del seller queda +10, del buyer −10, pero el buyer solo intentó devolver 5.

**Fix**: replicar el mecanismo del POST /pagos:
1. Column `client_generated_id UUID` en `cross_tenant_operations` (parent_op_id IS NOT NULL).
2. UNIQUE index parcial `WHERE parent_op_id IS NOT NULL AND client_generated_id IS NOT NULL`.
3. Early check + 409 `idempotency_conflict` estable.

**Costo estimado**: ~4h (migration + backend + frontend + tests).

---

#### P1-4 — `notas` no se propaga al otro lado

**Files**: `backend/src/routes/redB2b/pagos.js:453-463, 466-479`

En ambas rutas de propagación seller↔buyer, los args pasados a `registerBuyerPago` / `registerSellerCobro` **no incluyen** `notas: body.notas`. Resultado: el receptor ve `notas = null` en su lado, el caller ve la nota que escribió.

**Impacto**: audit inconsistente, UX confusa ("¿por qué el otro lado no ve mi nota?").

**Fix**: agregar `notas: body.notas` a los dos args de propagación.

**Costo estimado**: 10 minutos.

---

#### P1-5 — Conciliación no cubre `entrega_mercaderia`

**File**: `backend/src/routes/redB2b/conciliation.js:164`

El CASE de suma de `movimientos_cc` mapea `compra` +, `pago`/`parte_de_pago` −, `devolucion` −, pero **no incluye** `entrega_mercaderia` (que sí existe en el CHECK de `movimientos_cc`). Cross-tenant no lo genera hoy, pero un operador que edite a mano un mov_cc cross-tenant a `entrega_mercaderia` deja el saldo del seller inflado silenciosamente.

**Impacto**: hueco silencioso. Solo se dispara si hay edición manual, pero no lo detecta la conciliación.

**Fix**: agregar `entrega_mercaderia` al CASE con signo negativo. O bloquear edición manual de mov_cc cross-tenant (flag por FK).

**Costo estimado**: 30 minutos.

---

### P2 — Edge cases raros

- **P2-1**: TOCTOU en `productos.deleted_at` (SELECT filtra, UPDATE no) — `crossTenantOps.js:288-303 vs 319-329`.
- **P2-2**: `monto_ars` persistido para USD con `tc_pago=1000` legacy queda inflado (histórico de tests) — `pagos.js:502-507`.
- **P2-3**: Idempotency-key sin re-check de estado en replay (op cancelada tras el hecho) — `pagos.js:201-227`.
- **P2-4**: Nomenclatura confusa en `saldos_bilaterales` con comentario del propio autor "wait — debeAAseguntenantB is what?" — `conciliation.js:292`.
- **P2-5**: Race en `stock_insufficient` reporta stock pre-tx (confuso pero no crítico) — `crossTenantOps.js:331-345`.

### P3 — Mejorar (cosmético/telemetría)

- **P3-1**: Tolerancia TC de 1 UYU rechaza drift legítimo en pagos grandes UYU → `max(1.0, expected * 0.001)`.
- **P3-2**: `Number(pagadoUsd.toFixed(2))` en vez de `round2()` (inconsistencia estilística) — `operations.js:790`.
- **P3-3**: `SUM(...)` sin `COALESCE(..., 0)` en algunos lugares — `pagos.js:652-655, 767-777`, `conciliation.js:137-138`.
- **P3-4**: `INSERT...SELECT ORDER BY ... RETURNING` con orden asumido (no garantizado por spec pgsql) — `crossTenantOps.js:154-172`.
- **P3-5**: Descripción de mov_cc no incluye USD en ruta USD → dificulta conciliación cruzada.
- **P3-6**: `SET LOCAL app.current_tenant = ${Number(tenantId)}` con interpolación (mejor `$1`) — 15+ sitios.
- **P3-7**: `errorMessage()` definida después de usarse (hoist funciona pero legibilidad) — `operations.js:426, 1084`.
- **P3-8**: `total_ars` sin control cliente — arbitrario persistido como historial.
- **P3-9**: Cambios.jsx hardcodea "ARS" para UYU tenants (deuda técnica ya documentada) — `crossTenantPagos.js:298-301`.
- **P3-10**: `findOrCreateBuyerProducto` singular @deprecated PR-D #463 — código muerto, borrar.

---

## Buenas prácticas verificadas

1. **Atomicidad rigurosa** en los 3 endpoints core: `BEGIN/COMMIT/ROLLBACK` bien anidados, try/catch/rollback en catch externo, errores tenant-específicos hacen rollback antes de retornar.
2. **Fire-and-forget POST-COMMIT correcto**: emails y `invalidateMetricas` se disparan con `setImmediate` DESPUÉS del await del adminQuery → si el flow rollbackea, no puede llegar el email.
3. **SET LOCAL sistemático** + inline WHERE `tenant_id` defensivo en la mayoría de escrituras.
4. **Idempotency layered**: SELECT early + UNIQUE index parcial + FOR UPDATE serializa. Comentado con contexto.
5. **Suma cero de dinero**: `monto_usd` calculado UNA VEZ y propagado idéntico a seller y buyer helpers. `total_usd` del handler alimenta ambos INSERTs.
6. **Suma cero de stock**: decremento atómico con guard `WHERE cantidad >= u.cant` + `rowCount` check → race-safe sin `FOR UPDATE`. Ordenado por `pid ASC` para evitar deadlocks.
7. **Devolución H3** (`max devolvible = pagado − ya devuelto`) implementada correctamente.
8. **Audit trail** con SAVEPOINT + swallow migration-pending (`23514`/`42703`) — tolera CHECK constraints desactualizados sin romper la venta.
9. **BLOCKERs multi-país UYU** todos fixeados (6 sitios verificados).
10. **SEG-1, SEG-2, COR-1, COR-2, COR-3** todos fixeados y documentados con fecha.
11. **PR-B B1/H2/H3** aplicados (cajas resueltas ANTES, cancel con pagos previos, devolución maxeada).
12. **Test coverage**: 162 tests entre 7 archivos — comprehensive.

---

## Preguntas abiertas (para decisión)

1. **Timezone tenant-aware**: ¿existe `tenants.timezone` o siempre UTC? Multi-país UYU está en prod, ¿se usa hoy para operaciones o siempre UTC? — clave para fix P0-2.
2. **`linked_tenant_id` en `clientes_cc` / `proveedores`**: ¿está agendado para F5 o es solo aspiracional? — clave para fix P0-1.
3. **Multi-partnership entre mismos tenants**: ¿el schema lo permite? Si sí, `ensureSellerClienteCc` matchea por `nombre` y devuelve el primero → colisión no cubierta.
4. **UX del "saldo a favor" post-devolución**: sin reembolso automático, ¿cómo se consume el saldo hacia el próximo pedido? Hoy es "documental" hasta que Lucas lo aplique manualmente.
5. **TTL del idempotency-key**: ¿limpiarlo tras N días? En la práctica el frontend genera un UUID nuevo por modal open — riesgo bajo, pero worth anotar.

---

## Plan de acción propuesto

**Sprint 1 — P0 críticos** (~2 días de trabajo, 3 PRs):

- **PR A** (~1 día): fix P0-1 (contaminación cross-tenant en helpers ensure). Migration para agregar UNIQUE `(tenant_id, LOWER(nombre))` + filtro tenant_id en helpers + tests.
- **PR B** (~2h): fix P0-2 (timezone paid_until). Depende de decisión sobre `tenants.timezone`.
- **PR C** (~30 min): fix P0-3 (getActivePartnershipById filtro status).

**Sprint 2 — P1 importantes** (~2 días, 2 PRs):

- **PR D** (~1h): fix P1-1 + P1-2 + P1-4 + P1-5 (schema precio, server-computed total, notas propagation, entrega_mercaderia). Todos backend chico + tests.
- **PR E** (~4h): fix P1-3 (Idempotency-Key en devolucion). Migration + backend + frontend + tests.

**Sprint 3 — P2/P3 batch** (~1 día, 1 PR):

- **PR F**: batch de mejoras (COALESCE, notas descripción, código muerto, tolerancia TC UYU, TOCTOU deleted_at, replay warn).

**Total estimado**: ~5 días de trabajo distribuidos en 6 PRs.

---

**Archivos principales de referencia**:
- `backend/src/routes/redB2b/{operations,pagos,partnerships,conciliation}.js`
- `backend/src/lib/{crossTenantOps,crossTenantPagos,partnership}.js`
- `backend/src/schemas/redB2b.js`
- Migrations: `20260627000001_red_b2b_partnerships.js` + subsecuentes.
