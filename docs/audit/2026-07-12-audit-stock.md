# Auditoría Stock / Inventario — 2026-07-12

**Fecha**: 2026-07-12
**Auditor**: Claude Opus.
**Alcance**: `backend/src/routes/{inventario,envios,proveedores,usados,shareLinks}.js`, `backend/src/lib/{ventaCore,ventaDesdeEnvio,cancelarVenta,cancelMovimientoCC,inventarioCache}.js`, schemas `{inventario,envios,proveedores,usados,ventas,shareLinks}.js`, migrations relevantes de productos / canjes / clases_producto / share_links, frontend `Inventario.jsx`, `Envios.jsx` (referencial).
**Método**: revisión de código con foco en atomicidad de stock, TOCTOU de soft-delete, cache invalidation cross-módulo, capability gating, share link público y trazabilidad canje ↔ producto.

---

## TL;DR

**Severity**: P0 3 · P1 6 · P2 8 · P3 6.

Top 3 findings destacados:

1. **`PUT /usados/:id`, `PUT /usados/bulk`, `DELETE /usados/:id` sin `requireCapability`** — un vendedor (con `usados.ver`) puede editar precios y borrar equipos del cotizador; solo `POST /usados` está gateado.
2. **`descontarStock` UPDATE final no filtra `deleted_at IS NULL`** — mismo TOCTOU que Red B2B P2-1: entre el SELECT y el UPDATE alguien soft-deletea un producto → el UPDATE lo re-vive con cantidad reducida y estado='vendido' (unitario), rompe el ledger del inventario.
3. **`POST /proveedores/movimientos` y `POST /proveedores/movimientos/bulk` no invalidan `inventarioCache`** — el import XLSX (path principal de alta de stock) deja el cache stale hasta que expira solo (20s). Reproducible cada vez que un tenant importa una planilla.

**Overall health**: El track tiene un piso alto de higiene técnica: el patrón `db.withTenant` es sistemático, el bulk INSERT con UNNEST y los guards de concurrencia (advisory locks por IMEI, `WHERE cantidad >= u.cant` en cuentas.js:704) muestran diseño. La serie F3 dejó el catálogo `clases_producto` bien resuelto (`slug_legacy` como puente compat) y los flows de auto-crear producto por canje / compra están correctamente wired. Sin embargo, la superficie de riesgo se concentra en dos lugares: **(a) cache invalidation** — 3 flows importantes olvidados que producen KPIs stale en el dashboard de Inventario y Capital, y **(b) trazabilidad producto ↔ origen** — los canjes con producto asociado no se limpian al cancelar/editar la venta madre, y la tabla `canjes` no tiene `deleted_at` (hard-delete), lo que rompe el histórico de trazas. El share link público expone un `activo` pero no un `suspended_at`/`paid_until` del tenant — riesgo comercial más que de seguridad.

---

## Findings por severidad

### P0 — Seguridad, atomicidad, cache pipeline principal

#### P0-1 — `PUT /usados/:id`, `PUT /usados/bulk`, `DELETE /usados/:id` sin capability gate

**Files**:
- `backend/src/routes/usados.js:79` (`PUT /bulk`)
- `backend/src/routes/usados.js:116` (`PUT /:id`)
- `backend/src/routes/usados.js:155` (`DELETE /:id`)

**Categoría**: Seguridad (capability enforcement)

El módulo `usados` está gateado a nivel router en `app.js:707` por `usados.ver` (default en vendedor + encargado + lectura, ver `roleDefaults.js:21,43,68`). `POST /usados` está bien: agrega `requireCapability('usados.agregar_equipo')` inline (línea 60), que vendedor/lectura NO tienen. Pero `PUT /bulk`, `PUT /:id` y `DELETE /:id` **no agregan ningún capability check adicional**.

Consecuencia: un vendedor autenticado (con `usados.ver` por default) puede:
- editar el `precio_usd` y `comentarios` de cualquier equipo del catálogo,
- vía `PUT /bulk` reescribir en masa la lista de precios,
- vía `DELETE /:id` soft-deletear un equipo (dejando de aparecer en la app y en el share link).

Escala con el rol "lectura" — que por definición NO debería poder mutar nada — porque también tiene `usados.ver`. Y hoy el catálogo `usados` es la fuente del share link público — un vendedor puede vandalizar el listado externo del tenant.

**Escenario reproducible**:
1. Tenant crea usuario con rol `vendedor` (default caps).
2. Vendedor loguea → JWT con `usados.ver`.
3. Vendedor abre DevTools y ejecuta `fetch('/api/usados/1', { method: 'DELETE', headers: {Authorization: 'Bearer <token>'} })`.
4. Resultado: el equipo desaparece del catálogo (soft-delete) sin audit específico de owner ni notificación.

**Fix propuesto**:
- `PUT /usados/bulk` y `PUT /usados/:id` → `requireCapability('usados.agregar_equipo')` (mismo criterio que el POST, semánticamente "modificar el catálogo").
- `DELETE /usados/:id` → capability propia `usados.eliminar_equipo` (destructivo, más restrictivo). Owner/admin del tenant bypassean.
- Actualizar `roleDefaults.js`: encargado sí, vendedor + lectura no.

**Costo estimado**: 30 min (3 gates + 1 cap nueva + tests).

---

#### P0-2 — `descontarStock` UPDATE final no filtra `deleted_at IS NULL`

**File**: `backend/src/lib/ventaCore.js:76-83`

**Categoría**: Solidez (TOCTOU + soft-delete integrity)

```js
await client.query(
  `UPDATE productos AS p
      SET cantidad = GREATEST(p.cantidad - u.cant, 0),
          estado   = CASE WHEN p.tipo_carga = 'unitario' THEN 'vendido' ELSE p.estado END
     FROM UNNEST($1::int[], $2::int[]) AS u(id, cant)
    WHERE p.id = u.id`,
  [ids, cantidades]
);
```

El SELECT previo (línea 47-54) sí filtra `deleted_at IS NULL`, y hay validación en memoria. Pero el UPDATE — el punto donde la escritura queda persistida — no. Este es exactamente el patrón que la auditoría Red B2B detectó en `crossTenantOps.js:288-303 vs 319-329` (P2-1) y se acordó fixear.

**Escenario reproducible**:
1. Tenant tiene producto unitario `X` con `cantidad=1`, `estado='disponible'`.
2. Usuario A abre modal Nueva Venta con producto X seleccionado.
3. Antes de confirmar, Usuario B (admin) borra el producto X vía `DELETE /productos/:id` → `deleted_at=NOW()`.
4. Usuario A confirma la venta → SELECT filtra por `deleted_at IS NULL` → producto ya no aparece → arroja `err400('Un producto ya no existe en el inventario')`. **Bien, no hay bug si viene por este path**.

Pero considerar el path B: la venta pasa por `POST /ventas` con MUCHOS items. El SELECT lockea todos con FOR UPDATE (línea 46-54). Entre el SELECT y el UPDATE, otro proceso NO puede soft-deletear porque el FOR UPDATE bloquea. Por lo tanto, **el TOCTOU real acá está en `descontarStock` cuando el caller NO usa withTenant + FOR UPDATE atómico como en el path del PUT /ventas**.

En `revertirEfectosVenta` (`cancelarVenta.js:22`) que llama `reponerStock` — hay uno análogo. `reponerStock` en `ventaCore.js:99-105` sí filtra `AND p.deleted_at IS NULL` (correcto por SOL-5 del audit de `cuentas.js:964`). Pero `descontarStock` sigue sin el filtro. Rango de impacto real: la ventana entre el FOR UPDATE del SELECT y el UPDATE es corta pero existente si el UPDATE se ejecuta en una tx separada (no aplicable en este código, pero sí en un refactor futuro), y por consistencia con el paradigma "todo UPDATE explícito filtra por `deleted_at`" del audit Red B2B.

**Fix propuesto**: agregar `AND p.deleted_at IS NULL` al UPDATE de `descontarStock:81` (mismo patrón que `reponerStock:104` y `cuentas.js:975`).

**Costo estimado**: 5 min + verificar que ningún test se rompa asumiendo el comportamiento anterior.

---

#### P0-3 — `POST /proveedores/movimientos` (single y bulk) no invalidan `inventarioCache`

**Files**:
- `backend/src/routes/proveedores.js:451-629` (single, línea 623 hace COMMIT y termina sin `invalidateMetricas`).
- `backend/src/routes/proveedores.js:639-823` (bulk, línea 817 idem).

**Categoría**: Escalabilidad / Excelencia (cache pipeline principal roto)

`inventarioCache.js` explícita en su header (línea 19-25):

> Llamada desde TODOS los flows que modifican productos:
>   · POST/PUT/DELETE /productos
>   · POST /productos/bulk (importación)
>   · POST /productos/bulk-delete-disponibles (vaciado masivo)
>   · POST /movimientos (venta B2B / devolución / entrega)
>   · DELETE /movimientos/:id (revertir venta B2B)
>   · POST/PUT/DELETE /ventas (ventas retail descontan/devuelven stock)

Los flows enumerados están OK (`grep` confirma 12 sitios). PERO faltan tres pipelines críticos:

1. **`POST /proveedores/movimientos`** — el path del alta de una compra crea productos vía `INSERT INTO productos` (línea 584-589). No hay `invalidateMetricas(req.tenantId)` en el bloque post-COMMIT (línea 623). Como este endpoint es el que carga stock nuevo al comprar a proveedor (path histórico + botón "Registrar compra"), el dashboard queda stale al menos 20s.

2. **`POST /proveedores/movimientos/bulk`** — este es el endpoint que llama el import XLSX del frontend (`frontend/src/screens/Inventario.jsx:902` → `proveedoresApi.createMovimientosBulk`). Es EL flow más caliente para carga de stock masivo (100+ productos en un solo import). El COMMIT en línea 817 no invalida cache.

3. **`DELETE /proveedores/movimientos/:id`** — revertir una compra soft-deletea productos (línea 887-893) y revierte caja. Línea 900 hace COMMIT sin `invalidateMetricas`. Los KPIs muestran los productos "vivos" hasta que expire el TTL.

Consecuencia: reproducibilidad garantizada del bug de "stale baseline" que Lucas mismo mencionó como fuente de confusión en junio 2026 (ver header de `inventarioCache.js:12-17`).

**Escenario reproducible**:
1. Tenant abre Inventario. GET `/productos/metricas` cachea el snapshot (`stock_disponible=100`).
2. Tenant importa un XLSX con 50 productos nuevos → POST `/proveedores/movimientos/bulk`.
3. Backend COMMITEA la tx (50 productos vivos en DB).
4. Frontend refresca Inventario. Nuevo GET `/productos/metricas` **devuelve la métrica cacheada (100)** hasta ~20s después.
5. Operador ve "100 unidades disponibles" cuando importó 50 nuevos.

**Fix propuesto**:
- Agregar `invalidateMetricas(req.tenantId)` **fuera** del `try` post-COMMIT en las 3 rutas (patrón idéntico al de `inventario.js:1657`).
- Follow-up long-term: mover la invalidación a un helper de la lib para no depender de que cada nuevo endpoint la recuerde.

**Costo estimado**: 15 min (3 líneas + tests que verifiquen el cache se invalida). El follow-up de helper es otro PR.

---

### P1 — Bugs de trazabilidad / cache secundario / integridad

#### P1-1 — Canje con producto asociado queda huérfano al cancelar venta

**Files**:
- `backend/src/lib/cancelarVenta.js:14-37` (no toca canjes).
- `backend/src/routes/ventas.js:1370` (edit venta hace `DELETE FROM canjes` sin tocar producto asociado).

**Categoría**: Trazabilidad (canje ↔ producto)

Un canje con `agregar_stock=true` crea un producto en Inventario (`ventas.js:464-484`) y guarda el `producto_id` en la fila `canjes` (línea 490). La tabla `canjes` no tiene `deleted_at` (`migrations/20260524000002_ventas.js:142-154`) → es hard-delete + `ON DELETE SET NULL` en producto (SET NULL apunta del canje al producto — no viceversa).

Cuando el operador **cancela la venta** (PUT /ventas/:id con `estado='cancelado'` o DELETE), `revertirEfectosVenta` (`cancelarVenta.js:14-37`) hace 6 pasos:
1. Repone stock de venta_items.
2. Soft-delete `movimientos_cc` de la venta.
3. Revertir caja.
4. Soft-delete comprobantes.
5. Soft-delete venta_comprobantes.
6. Revert tarjeta.

**NO toca canjes. NO toca el producto creado por el canje.**

Consecuencia: el equipo entregado por el cliente en el canje queda vivo en Inventario como `estado='disponible'`, referenciado por la fila `canjes` que sigue apuntando a una venta con `deleted_at` NOT NULL. La agg en `ventas.js:621` filtra por `WHERE ${BASE}` que incluye `v.deleted_at IS NULL` → OK, no distorsiona ganancias. Pero:
- El producto sigue apareciendo en `GET /inventario/usados` como `origen: 'canje'` con `canje_origen.venta_id = X` donde X es una venta cancelada (`inventario.js:717-726`) — UX confusa.
- Semánticamente: si la venta se cancela, el cliente teóricamente recibió su equipo de vuelta. Pero el equipo sigue en el stock del tenant → doble beneficio silencioso.
- Al editar la venta (`ventas.js:1370` hace `DELETE FROM canjes WHERE venta_id = $1`) sin volver a incluir el canje → el producto asociado queda en Inventario pero SIN el canje que lo vinculaba → pierde origen `canje` en `GET /usados` (aparece como `origen: 'manual'`).

**Fix propuesto**: decidir política (con Lucas):
- **Opción A**: cancelar venta ⇒ soft-delete el producto asociado del canje (si su estado='disponible' y no fue vendido). Registrar audit.
- **Opción B**: cancelar venta ⇒ solo alertar en UI + audit "canje con producto vivo pendiente de decisión manual".

Independiente de la decisión, agregar `deleted_at` a la tabla `canjes` para poder soft-deletearlas y preservar histórico. Cambiar los DELETEs de `ventas.js:1370` y el INSERT re-run del PUT por soft-delete + preservar trazabilidad al re-insertar con nuevo `id`.

**Costo estimado**: 4-6h (migration `canjes.deleted_at` + refactor DELETE en 1 sitio + revertirEfectosVenta que toque canjes + tests).

---

#### P1-2 — `POST /envios` no invalida `inventarioCache` cuando crea venta con productos

**Files**:
- `backend/src/routes/envios.js` (ningún `invalidateMetricas` en el archivo).
- `backend/src/lib/ventaDesdeEnvio.js:109` (`descontarStock` sí se llama, pero sin invalidar cache post-COMMIT).

**Categoría**: Escalabilidad (cache pipeline secundario)

`envios.js` NO importa `invalidateMetricas` ni lo llama en ningún endpoint. Los 4 endpoints que tocan stock:
- `POST /` (crea envío + venta auto → descuenta stock).
- `PUT /:id` (edita envío + sincroniza venta → puede descontar/reponer stock).
- `POST /:id/confirmar-entrega` (cambia estado → no toca stock).
- `DELETE /:id` (revert venta → repone stock).

De los 4, 3 tocan stock. Ninguno invalida cache. `crearVentaDesdeEnvio` internamente llama `descontarStock` (línea 109) pero como es una función interna no invalida el cache del caller.

Impacto: idéntico al P0-3 (KPIs stale hasta 20s) pero en el path envíos → venta auto. Menos frecuente (envíos son secundarios al import XLSX) → P1 en lugar de P0.

**Fix propuesto**: agregar `invalidateMetricas(req.tenantId)` post-COMMIT en `POST /envios`, `PUT /envios/:id`, y `DELETE /envios/:id` cuando efectivamente se creó/editó/borró una venta asociada (opcional: siempre invalidar es más simple y no daña — 20s TTL).

**Costo estimado**: 15 min (3 líneas + import + tests).

---

#### P1-3 — `POST /inventario/productos/bulk-delete-disponibles-con-compras` no filtra RLS explícito en SELECT stock

**File**: `backend/src/routes/inventario.js:1456-1465`

**Categoría**: Solidez / Excelencia (defense-in-depth)

```js
const { rows: dispProds } = await client.query(
  `SELECT id, proveedor_movimiento_id
     FROM productos
    WHERE deleted_at IS NULL AND estado = 'disponible'
    ORDER BY id FOR UPDATE`
);
```

No hay `tenant_id = $1` en el WHERE. En prod se filtra por RLS via el `SET LOCAL app.current_tenant`. En tests con super-user o si algún día cambia el rol del pool, esto barre `productos` de TODOS los tenants. La query hermana en `bulk-delete-disponibles` (línea 1381-1386) tiene el mismo hueco.

Contexto: el patrón está documentado en `roleDefaults.js` y `redB2b` — la auditoría anterior enfatizó "nunca confiar solo en RLS, agregar `tenant_id` explícito como defense-in-depth". El diff Red B2B fue justamente esto para bulks. Los deletes bulk son los sitios más caros de equivocarse.

**Escenario de daño hipotético**: un ETL o script admin usa un pool sin `SET LOCAL app.current_tenant` (por bug o refactor) → el bulk-delete borra el disponible de TODOS los tenants.

**Fix propuesto**: agregar `AND tenant_id = $1` al WHERE de los 3 bulks (bulk-delete-disponibles, bulk-delete-disponibles-con-compras, y el SELECT del snapshot de compras impactadas). El tenantId ya se conoce vía `req.tenantId` en el handler.

**Costo estimado**: 20 min (3 queries + tests que forcen scenario cross-tenant).

---

#### P1-4 — Share link público expone tenant suspendido / con paid_until vencido

**File**: `backend/src/routes/shareLinks.js:262-276` (lookup del link).

**Categoría**: Seguridad / negocio

El JOIN al tenant solo filtra `AND t.deleted_at IS NULL`:

```js
FROM share_links sl
JOIN tenants t ON t.id = sl.tenant_id AND t.deleted_at IS NULL
```

Falta:
- `AND t.suspended_at IS NULL` — un tenant suspendido por admin (impago, abuso, dispute) sigue sirviendo su listado público al mundo.
- `AND (t.paid_until IS NULL OR t.paid_until >= CURRENT_DATE)` — un tenant con plan vencido no debería usar el feature share link (que es de plan pago).

Consecuencia: el negocio no puede "cortar" el share link vía suspend/no-pay — el equipo tiene que ir manualmente al panel admin de super-admin y buscar cada `share_links` para bajar `activo=false`. Peor: si el operador NO se da cuenta y el link se comparte por WhatsApp/IG, sigue funcionando.

**Fix propuesto**: extender el WHERE:
```sql
FROM share_links sl
JOIN tenants t ON t.id = sl.tenant_id
              AND t.deleted_at IS NULL
              AND t.suspended_at IS NULL
              AND (t.paid_until IS NULL OR t.paid_until >= CURRENT_DATE AT TIME ZONE tenant_tz_helper(t.pais))
WHERE sl.token = $1
```

Aplicar timezone-aware para `paid_until` (mismo tenant-tz helper que Red B2B P0-2). Si el tenant está suspended/vencido, devolver 410 `tenant_inactivo` (no 404 — más humano para el cliente que lo tenía guardado).

**Costo estimado**: 1-2h (query + helper timezone reutilizado + tests).

---

#### P1-5 — Share link público no filtra `p.oculto = false`

**File**: `backend/src/routes/shareLinks.js:302-319`

**Categoría**: Trazabilidad / UX

El listado público filtra:
```sql
WHERE p.tenant_id = $1
  AND p.deleted_at IS NULL
  AND p.condicion = 'usado'
  AND p.estado = 'disponible'
  [AND p.precio_venta > 0]  -- opcional según mostrar_precio
```

**No filtra `p.oculto = false`**. El campo `oculto` existe justamente para sacar productos de vistas por defecto sin borrarlos (`schemas/inventario.js:73`). Un producto usado disponible que el operador ocultó (por decisión de reserva, defecto, etc.) sigue apareciendo en el listado público.

**Fix propuesto**: agregar `AND p.oculto = false` al WHERE. Consistent con otros listados del frontend (Inventario.jsx default no muestra ocultos).

**Costo estimado**: 5 min + 1 test.

---

#### P1-6 — `canjes.moneda` CHECK constraint no incluye UYU

**File**: `backend/migrations/20260524000002_ventas.js:151`

```sql
moneda TEXT NOT NULL DEFAULT 'USD' CHECK (moneda IN ('USD','ARS')),
```

**Categoría**: Multi-país / solidez

Post-migración multi-país UYU (`_common.js` MonedaEnum acepta USD/ARS/UYU/USDT), el schema Zod de canjes (`ventas.js:56`) usa `MonedaEnum.default('USD')` → un tenant UYU manda `moneda='UYU'` en el canje → el schema Zod lo acepta pero el INSERT rompe con `23514` (check_violation) → error 500 opaco en el usuario.

Adicionalmente, la agg del dashboard convierte UYU en el CASE (`ventas.js:621, 637`) — asume que llegan filas con `moneda='UYU'`. Contradicción.

**Escenario reproducible**:
1. Tenant UY carga venta con canje: `canje.moneda='UYU'`, `valor_toma=15000`.
2. POST /ventas.
3. Backend Zod pasa (aceptó UYU).
4. INSERT INTO canjes rompe con `new row for relation "canjes" violates check constraint "canjes_moneda_check"`.
5. Rollback total de la venta. El operador ve un 500 con mensaje técnico.

**Fix propuesto**: migration `ALTER TABLE canjes DROP CONSTRAINT canjes_moneda_check, ADD CONSTRAINT canjes_moneda_check CHECK (moneda IN ('USD','ARS','UYU'))`. También verificar `USDT` si algún tenant lo usa para canjes (se ve que ventas usa USDT en la agg).

**Costo estimado**: 20 min (migration + verificar no hay data corrupta pre-existente).

---

### P2 — Edge cases medianos

#### P2-1 — `PUT /productos/:id` UPDATE sin `deleted_at IS NULL` (TOCTOU consistente)

**File**: `backend/src/routes/inventario.js:1274`

Mismo patrón que `descontarStock` (P0-2): el SELECT `before[0]` en línea 1189 filtra `deleted_at IS NULL`, pero el UPDATE (línea 1273-1276) no. Ventana pequeña pero existe: si entre el SELECT y el UPDATE otro proceso soft-deletea el producto, el UPDATE lo re-vive con los COALESCE campos actualizados. Sin corrupción de datos crítica pero rompe la semántica de "soft-delete sticky".

**Fix**: `WHERE id = $... AND deleted_at IS NULL`.

**Costo estimado**: 5 min.

---

#### P2-2 — `agregarClaseCompat` hace N+1 selects a `clases_producto`

**File**: `backend/src/routes/inventario.js:1033-1041`

Cada `POST /productos`, `PUT /productos/:id`, y cada canje que crea producto llama `agregarClaseCompat` — un extra SELECT a `clases_producto` por producto solo para hidratar el `clase` sintético en el response. En un bulk esto sería N+1, pero el bulk NO llama `agregarClaseCompat` (`inventario.js:1651` — bulk usa `RETURNING id` sin el compat). El costo es 1 extra SELECT por producto singular — manageable, pero el comentario en línea 1030-1031 lo reconoce: "un extra SELECT por producto — costo aceptable durante la transición".

Como F3 ya cerró (Fase 2c), el `clase` sintético del response no debería ser necesario más — el frontend consume `clase_id` + JOIN inline en GET /productos. Sunset del compat es code cleanup.

**Fix**: sunset `agregarClaseCompat` (remove the helper + call sites). Verificar que ningún consumer (test o frontend) espera el field `clase` en el response.

**Costo estimado**: 1h (grep + remove + verificar tests).

---

#### P2-3 — `envios.js:409` UPDATE soft-delete sin `AND deleted_at IS NULL`

**File**: `backend/src/routes/envios.js:409`

```js
await client.query('UPDATE envios SET deleted_at = NOW() WHERE id = $1', [id]);
```

El SELECT + FOR UPDATE en línea 392 sí valida `deleted_at IS NULL`. Pero el UPDATE final no. Race hipotética entre el FOR UPDATE (que lockea) y el UPDATE (que setea) — mismo TOCTOU que Red B2B P2-1 pero acotada.

**Fix**: agregar `AND deleted_at IS NULL`.

**Costo estimado**: 3 min.

---

#### P2-4 — `envio_items` es hard-delete (sin `deleted_at`)

**Files**:
- `backend/migrations/20260521000001_initial-schema.js:143-151` (tabla sin `deleted_at`).
- `backend/src/routes/envios.js:258` (`DELETE FROM envio_items WHERE envio_id = $1` en PUT).

**Categoría**: Trazabilidad

Cuando el operador edita un envío que ya sincronizó una venta y descontó stock, el PUT hace hard-DELETE de todos los `envio_items` y re-INSERT. No queda audit trail de qué items fueron modificados/removidos — el historial se pierde. Semi-idéntico al problema de `canjes` sin deleted_at pero acotado a envíos.

**Fix propuesto**: migration `ALTER TABLE envio_items ADD COLUMN deleted_at TIMESTAMPTZ`. Cambiar el DELETE por UPDATE + WHERE `deleted_at IS NULL`. Los SELECT existentes agregan `AND deleted_at IS NULL`. El impacto es chico porque las agregaciones de envíos vienen del JSON_AGG en el listado (línea 121-123).

**Costo estimado**: 2-3h (migration + refactor DELETE + tests).

---

#### P2-5 — `ensureBuyerProducto` (path canje) no valida IMEI dup case-insensitive

**File**: `backend/src/routes/ventas.js:389-405`

El check pre-INSERT del canje (línea 389-405) compara `imei = $1` case-sensitive contra un IMEI trimeado del body. Los IMEIs son numéricos por convención, así que en la práctica no hay case, pero el UNIQUE PARCIAL de la DB (`idx_productos_imei_unique`) puede tener normalización distinta (ej. escientific notation ya arreglada en migration `20260707000004`).

Además: el check filtra `estado = 'disponible'` — un canje con IMEI de un producto EN TECNICO no detecta el dup pre-INSERT y rompe con el UNIQUE (409 opaco). El flow POST /productos tiene el mismo hueco (línea 1083-1091). Consistencia deseable.

**Fix**: unificar en un helper `checkImeiDuplicado(client, imei)` con la misma lógica que el UNIQUE PARCIAL de DB. Reusar en canje, POST /productos, POST /movimientos, POST /movimientos/bulk.

**Costo estimado**: 1h (helper + 4 call sites + tests).

---

#### P2-6 — `productoEnBulk` en `bulkProductoSchema` acepta `estado='vendido'`

**File**: `backend/src/schemas/inventario.js:51, 105`

`baseProducto.estado` acepta 4 valores. El bulk POST hereda esto → un cliente malicioso puede importar productos DIRECTAMENTE con `estado='vendido'` bypass del flow normal (compra → venta → stock decrementado). Consecuencia: inconsistencia contable (vendido sin venta asociada, `venta_items.producto_id` sin match).

**Fix**: en el bulk (import XLSX), forzar `estado='disponible'` como default y rechazar cualquier otro valor. Similar en POST single.

**Costo estimado**: 15 min (refine en schema + 1 test).

---

#### P2-7 — `catalogo_usados.precio_usd` acepta 0 en POST/PUT

**File**: `backend/src/schemas/usados.js:7,19`

```js
precio_usd: z.number({ coerce: true }).nonnegative(),
```

Un equipo con `precio_usd=0` en el catálogo cotizador es inútil operativamente. Análogo al P1-1 de Red B2B (`precio_usd = 0` en items de operación). No provoca corrupción pero ensucia el catálogo.

**Fix**: `precio_usd: z.number({ coerce: true }).positive()`. Idem para `bulkUpdateUsadosSchema`.

**Costo estimado**: 5 min.

---

#### P2-8 — `share_link_views` insert cross-tenant sin control de tenant activo

**File**: `backend/src/routes/shareLinks.js:340-346`

El insert de vistas del share link corre en `adminQuery` (BYPASSRLS) sin ninguna validación de que el tenant siga activo. Un scraper puede bombardear un token válido de un tenant suspendido y llenar `share_link_views` con IPs hashada.

Combinado con P1-4 (link_activo no chequea suspended), este es el vector de DoS del share link: un tenant borrado del portal pero con link cacheado en Google puede seguir generando writes contra la DB.

**Fix**: si el fix de P1-4 se aplica (JOIN filtra suspended), el flow ni llega al INSERT en share_link_views. Alternativa: agregar al fire-and-forget del INSERT un `WHERE EXISTS (SELECT 1 FROM tenants WHERE id = $ AND suspended_at IS NULL)`.

**Costo estimado**: cubierto en P1-4 fix.

---

### P3 — Cosmética / telemetría / follow-ups

- **P3-1**: `descontarStock` usa `GREATEST(p.cantidad - u.cant, 0)` — clampeo silencioso a 0. El SELECT previo valida cantidad, pero si por race llega negativo silenciosamente, no logueamos. Preferir `p.cantidad - u.cant` sin clamp + guard `WHERE p.cantidad >= u.cant` como en `cuentas.js:704` + retornar rowCount para detectar mismatch. `ventaCore.js:78`.

- **P3-2**: `SET LOCAL app.current_tenant = ${Number(tenantId)}` en 6+ sitios (interpolación en lugar de `$1`). Idéntico al P3-6 del audit Red B2B. `inventario.js:119, 1347, 1429, 1582`, `proveedores.js:180, 221, 318`, etc.

- **P3-3**: `GET /inventario/productos/proveedores` (`inventario.js:312-327`) hace `DISTINCT TRIM(proveedor)` sin cap — un tenant con muchos proveedores puede devolver miles de strings. Comentario dice "≤cientos en cualquier escenario realista" — pero un tenant B2B grande podría cruzar el umbral. Agregar `LIMIT 500` defensivo.

- **P3-4**: `queryUsadosSchema` (`inventario.js:696-698`) acepta `solo_canjes=true` y `solo_manual=true` simultáneamente → el WHERE produce contradicción SQL (`cj.id IS NOT NULL AND cj.id IS NULL`) → siempre retorna vacío. Zod `.refine()` para rechazar la combinación (o al menos warning en el response).

- **P3-5**: `agregarClaseCompat` (`inventario.js:1033`) muta el objeto row en lugar de retornar una copia. Efecto secundario oculto — el caller del audit ve el objeto ya modificado. Refactor a return-value pura.

- **P3-6**: `getShareLinkStats` (`shareLinks.js:80-98`) — el WHERE filtra `visto_en >= NOW() - INTERVAL '30 days'` y ambos COUNT usan el mismo WHERE. Los dos count no son distintos entre sí (el count del WHERE ya es "últimos 30 días" y el FILTER duplica). Simplificar. Y agregar `AND share_link_id IN (SELECT id FROM share_links WHERE tenant_id = $)` como cross-check defensivo si el `link.id` viniera bajo error.

---

## Buenas prácticas verificadas

1. **RLS sistemático**: TODAS las tablas de inventario tienen `ENABLE + FORCE ROW LEVEL SECURITY` con policy `tenant_isolation`. Verificado en `migrations/20260615000002_multitenant_rls.js:70-98`.
2. **`db.withTenant` idiomático** en 100% de los handlers del track — `SET LOCAL app.current_tenant` dentro del `BEGIN`, tx wraps automáticos.
3. **Bulk INSERT con UNNEST** en 3 hot paths (import productos `inventario.js:1637-1644`, bulk items compra `proveedores.js:541-560`, envio_items `envios.js:43-64`) — 1 round-trip por N filas.
4. **Guard `cantidad >= u.cant`** en `cuentas.js:704` (B2B) elimina TOCTOU sin FOR UPDATE previo. Excelente pattern — la venta rechaza 409 si otra tx drenó el stock, no 500 opaco.
5. **Advisory lock por IMEI** en `proveedores.js:505-506, 697-698` (`pg_advisory_xact_lock(hashtext($1))`) con hashes ordenados para evitar deadlocks.
6. **UNIQUE PARCIAL** `idx_productos_imei_unique WHERE deleted_at IS NULL AND estado='disponible'` (mig `20260701000003`) — permite que un IMEI reingrese vía canje sin colisionar.
7. **Response shaping F5b** — todos los GETs de inventario redactan `costo`/`costo_moneda` si el user no tiene `inventario.ver_costos` (`inventario.js:623-626, 763-790, 940-944`). Post-fix del BLOCKER P1 2026-07-05 en historial.
8. **Cache TTL cross-instance** — `inventarioCache.js` usa Redis (P-04 Fase 3.3) → invalidaciones propagan a las 2 réplicas Railway.
9. **Gate `inventario` cross-módulo** en `proveedores.js:468-473, 682-686` — una compra que crea stock exige capability `inventario.ver` del user, no basta con `proveedores.trabajar`.
10. **Guard contra envíos en curso** en el bulk-delete disponibles (`inventario.js:1360-1378`) — bloquea con 409 si hay envíos Pendiente/En camino referenciando productos.
11. **`agregarClaseCompat` hidrata slug** para compat post-F3.d-3 → transición limpia sin romper clientes viejos.
12. **Share link admin** tiene los 3 caps correctamente enforced (GET `inventario.ver`, PATCH + rotate `inventario.editar`, `shareLinks.js:113, 134, 182`).
13. **Rate limit dedicado** para bulks (bulkLimiter 20/15min, compraMovimientoLimiter 30/15min) — evita hedging de scripts accidentales.
14. **Audit lote** en bulk imports (`inventario.js:1651, proveedores.js:596`) — 1 audit entry con `ids: [...]` en vez de N entries que inflarían audit_logs.
15. **Share link público** tiene rate limit 60/min por IP, cache HTTP 60s, y IP hash con salt env — defense-in-depth razonable.

---

## Preguntas abiertas (para decisión de Lucas)

1. **Canjes hard-delete → soft-delete**: agregar `deleted_at` a `canjes` cambia semántica de la agg del dashboard (`ventas.js:621`) y de todas las lecturas. ¿Va bien migrar canjes a la política del resto del portal? Impacto: 1 migration + 4 sitios de código.

2. **Cancelación de venta con canje**: ¿el producto del canje se auto-soft-delete (opción A) o se queda vivo con audit warning (opción B)? Requiere definición semántica antes de fixear P1-1.

3. **Share link con tenant vencido**: ¿410 `tenant_inactivo` con mensaje "Este comercio ya no está activo" (visible al cliente) o 404 anónimo? El 410 es más honesto pero puede afectar reputación del tenant en el WhatsApp del cliente.

4. **`usados.eliminar_equipo` como cap nueva**: ¿la agregamos ahora o reutilizamos `usados.agregar_equipo` para simplicidad? Preferencia técnica: separar (los DELETE son destructivos y merecen granularidad).

5. **Estado 'vendido' en bulk import**: ¿algún tenant carga histórico de ventas anteriores importando productos ya vendidos? Si sí, el fix de P2-6 rompería el flow. Si no, es un endurecimiento razonable.

6. **Filtro `p.oculto=false` en share link**: hoy funciona como "vitrina". Un producto oculto por defect/reserva no aparece. ¿Es el comportamiento deseado o el operador confía que "oculto" no afecta al share link?

---

## Plan de acción sugerido

**Sprint 1 — P0 críticos** (~1.5 días, 3 PRs)

- **PR A** (~30 min): fix P0-1 — 3 capability gates en usados PUT/DELETE + cap nueva `usados.eliminar_equipo` + `roleDefaults.js`.
- **PR B** (~15 min): fix P0-2 — `AND p.deleted_at IS NULL` en `descontarStock` UPDATE.
- **PR C** (~30 min): fix P0-3 — `invalidateMetricas` en 3 rutas de proveedores (single, bulk, delete). Reusable helper para follow-up.

**Sprint 2 — P1 trazabilidad + producto** (~2-3 días, 3 PRs)

- **PR D** (~2h): fix P1-2 + P1-3 — invalidateMetricas en envíos (3 sitios) + `AND tenant_id` explícito en bulks de inventario.
- **PR E** (~3h): fix P1-4 + P1-5 + P2-8 — share link filtra tenant suspended/paid_until + oculto + tenant-tz aware. Rechaza views a tenants inactivos.
- **PR F** (~2h): fix P1-6 — migration CHECK constraint UYU en canjes + agregar 'UYU' al enum.

**Sprint 3 — P1 canjes-huerfano + P2 batch** (~2-3 días, 2 PRs)

- **PR G** (~4-6h): fix P1-1 — migration `canjes.deleted_at` + refactor DELETE en `ventas.js` a soft-delete + `revertirEfectosVenta` toca canjes + tests. **Requiere decisión #2 antes**.
- **PR H** (~3h): batch P2-1 + P2-3 + P2-4 + P2-6 + P2-7 — TOCTOU deleted_at (2 sitios), envio_items soft-delete migration, endurecer bulk import estado, precio_usd positive.

**Sprint 4 — P3 higiene** (~1 día, 1 PR)

- **PR I**: batch P2-2 + P3-2 + P3-3 + P3-4 + P3-5 + P3-6 — sunset agregarClaseCompat, SET LOCAL con $1, LIMIT en /proveedores endpoint, refine query usados, cleanup stats query.

**Total estimado**: ~7-9 días de trabajo distribuidos en 9 PRs (P0 en primera semana).

---

**Archivos principales de referencia**:
- `backend/src/routes/{inventario,envios,proveedores,usados,shareLinks}.js`
- `backend/src/lib/{ventaCore,ventaDesdeEnvio,cancelarVenta,inventarioCache}.js`
- `backend/src/schemas/{inventario,ventas,usados,proveedores,shareLinks}.js`
- Migrations: `20260521000001_initial-schema.js` (envio_items), `20260524000002_ventas.js` (canjes), `20260711100000_share_links_usados.js`, `20260701000003_productos_imei_unique_disponible.js`.

Auditoría completa. 23 findings totales, 22 archivos revisados.
