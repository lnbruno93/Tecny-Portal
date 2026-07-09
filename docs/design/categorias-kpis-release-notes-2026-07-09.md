# Release notes — Categorías reales F3 + KPIs Fase 2

**Fecha de cierre:** 2026-07-09.
**Alcance:** 11 PRs en 6 semanas (F1 → F3.d-3 → KPIs Fase 2a-2b → Dashboard Ventas rediseño). Toda la serie está mergeada y auto-sync a staging en verde.
**Falta:** Fase 2c (drop legacy) planificada para 1-2 semanas post-deploy prod.

## TL;DR

Migramos el módulo de Inventario de un **enum global fijo de 9 clases** a un **catálogo editable por tenant** (tabla `clases_producto`) + rediseñamos los KPI cards de **Inventario, Capital y Dashboard de Ventas** para que consuman ese catálogo real en vez de 2 buckets simplificados.

**Antes:**
- 9 categorías hardcoded globales (`celular_sellado`, `celular_usado`, `watch`, ...) — no personalizables.
- KPI cards de Inventario mostraban `Inversión equipos` (2 slugs) vs. `Inversión accesorios` (7 slugs) — colapsando toda la data en 2 buckets arbitrarios.
- Card "Unidades vendidas" del Dashboard de Ventas: chips inline con emoji + nombre + count. Se desbalanceaba en 3 líneas cuando el tenant vendía en 8+ categorías del rango.
- Frontend + backend acoplados al enum via helper `lib/clasesProducto.js` en 2 lados.

**Después:**
- Tabla `clases_producto` por tenant, CRUD editable desde modal en el header de Inventario. Cada tenant define sus categorías, con emoji, orden, activa/inactiva.
- **Inventario KPI cards**: 3 fijos (En técnico / Stock disponible / **Total valorizado USD**) + botón `Ver detalle por categoría →` que abre modal con breakdown granular.
- **Dashboard Ventas card "Unidades vendidas"**: total agregado + top categoría al vuelo + botón `Ver detalle` → modal con ranking por count DESC + porcentaje relativo por fila. Card compacto y balanceado con los otros 3 de la fila.
- Columna `productos.clase` VARCHAR **dropeada** — clasificación exclusiva vía FK `productos.clase_id → clases_producto.id`.
- Helpers `lib/clasesProducto.js` (backend + frontend) **eliminados**.

## Cronología de PRs

| PR | Fase | Qué mergeó |
|----|------|-----------|
| #523 | **F1** | Enum global `CLASES_PRODUCTO` (9 clases fijas) |
| #524 | **F2** | Chips por clase en KPI Dashboard de Ventas |
| #528 | **F3.a** | Tabla `clases_producto` + seed + endpoint `GET /clases` |
| #529 | **F3.b** | Modal CRUD "Gestionar categorías" (frontend) |
| #530 | **F3.c-1** | Form Inventario usa `clase_id` UUID + derive bidireccional |
| #532 | **F3.c-2 PR-1** | Tabs filtro Inventario → `clase_id` |
| #533 | **F3.c-2 PR-2** | Dashboard KPI `unidades_por_clase` shape array |
| #534 | **F3.c-2 PR-3** | Import XLSX resuelve por nombre + fallback "Sin categoría" |
| #535 | **F3.d-1** | Cleanup fallbacks F1 hardcoded (frontend) |
| #536 | **F3.d-2** | Backend consumers de lectura → JOIN |
| #537 | **F3.d-3** | **DROP COLUMN** productos.clase + eliminación total del enum |
| #538 | **KPIs 2a** | `/metricas` aditivo con `inv_por_clase[]` |
| #539 | **KPIs 2b** | Frontend Inventario + Capital consumen `inv_por_clase[]` |
| #541 | **Dashboard Ventas** | Card "Unidades vendidas" → resumen + modal (Opción C) |

## Cambios de shape API

### `GET /api/inventario/productos/metricas` — response

**Agregado (aditivo, no rompe compat):**
```json
{
  "inv_por_clase": [
    {
      "clase_id": "uuid|null",
      "nombre": "Celular Sellado",
      "emoji": "📲",
      "es_base": true,
      "es_sin_categoria": false,
      "slug_legacy": "celular_sellado",
      "count": 22,
      "usd": 18500,
      "ars": 0
    },
    ...
  ]
}
```

**Preservado (deprecated, sunset en Fase 2c):**
- `inv_equipos_usd`, `inv_equipos_ars`, `equipos_count`
- `inv_accesorios_usd`, `inv_accesorios_ars`, `accesorios_count`

**Ordenamiento:** `orden ASC → USD DESC → nombre ASC`. Fila "Sin categoría" siempre al final.

**Redact caps (`inventario.ver_costos`):** sin la capability, `usd` y `ars` de cada fila del array se nullifican. `count` sigue visible — un vendedor puede saber CUÁNTOS equipos hay por categoría, no CUÁNTA plata representan.

### Otros endpoints tocados

- `GET /api/inventario/productos` — expone `cp.slug_legacy AS clase` via LEFT JOIN. Filtro `?clase=<slug>` sigue soportado como compat legacy (query resuelto vía EXISTS).
- `POST/PUT /api/inventario/productos` — body puede traer `clase` (deprecated) o `clase_id`. El schema acepta ambos; el handler valida contra `clases_producto` del tenant.
- `POST /api/ventas` con canje `agregar_stock=true` — resuelve slug→UUID contra el catálogo por tenant antes del INSERT.
- `GET /api/inventario/desglose` — filtro `?clase=<slug>` legacy soportado, canónico `?clase_id=UUID`.

## Cambios de DB (migrations)

- `20260708000002_clases_producto_tenant.js` — crea tabla + seed 9 base + Sin categoría por tenant.
- `20260708000003_productos_clase_id.js` — agrega columna `clase_id UUID NULL FK`.
- `20260709000001_drop_productos_clase_legacy.js` — **DROP** de `productos.clase` VARCHAR + CHECK + NOT NULL. Reversible via backfill JOIN.

## Cambios UX

### Inventario — cards KPI
- **Antes:** 4 cards fijos (En técnico / Stock / Inversión equipos / Inversión accesorios).
- **Después:** 3 cards (En técnico / Stock / **Total valorizado**) + botón `Ver detalle por categoría →`.
- El botón abre `InventarioPorCategoriaModal` con la lista granular: emoji, nombre, count, valorizado USD por categoría.

### Inventario — tabs filtro
- **Antes:** 9 tabs hardcoded (Celular Sellado, Celular Usado, etc.).
- **Después:** N tabs dinámicos según el catálogo del tenant + tabs fijos (Todos, En técnico, Usados) + colecciones legacy.
- El botón "Categorías" en el header abre el CRUD editable (F3.b).

### Capital
- **Antes:** Stock valorizado sumaba `inv_equipos + inv_accesorios + en_tecnico`.
- **Después:** Suma sobre `inv_por_clase[]` + `en_tecnico`. Fallback a legacy si el array no llega (compat con rolling deploy).

### Dashboard de Ventas — card "Unidades vendidas" (#541)
- **Antes:** chips inline con emoji + nombre + count por categoría vendida en el rango. Con 8+ categorías el card ocupaba 3 líneas vs. 1 línea de los otros 3 KPI cards de la fila → desbalance visual.
- **Después:** card compacto con **total agregado + label "en N categorías" + top categoría (emoji + count) + botón `Ver detalle →`**. El detalle vive en el modal `VentasPorCategoriaModal`: filas ordenadas por count DESC con porcentaje relativo por fila + footer con total agregado + `N cat.`
- **Consistente con Inventario:** mismo patrón "resumen + botón → modal" que introdujimos en Fase 2b. El usuario aprende el patrón una vez y aplica en 3 vistas (Inventario, Capital, Dashboard).
- **Fallback binario preservado:** si `unidades_por_clase` viene `undefined` / `[]` / object legacy F2, el card muestra `📱 celulares · 🎧 accesorios` sin crashear. Cubre backends viejos y rangos sin ventas.

## Deuda técnica plantada (Fase 2c)

Cuando #538 + #539 estén verificados en prod por ≥1 semana:

1. `GET /metricas` — drop de los 6 campos legacy del response.
2. `Capital.jsx` — remover el fallback `n(inv.inv_equipos_*) + n(inv.inv_accesorios_*)`.
3. Query `METRICAS_SQL` en `lib/inventarioCache.js` — simplificar (remover los FILTERs por `slug_legacy IN EQUIPOS_CLASES`).
4. Tests — actualizar `inventario.test.js` y `response-shaping-caps.test.js` que verifican legacy fields.

**Estimado:** ~150 líneas de deleción neta. 1 PR chico.

## Compat legacy también preservada (sunset separado)

Cosas que dejamos aceptadas como deprecated para no romper URLs / integraciones viejas:
- `?clase=<slug>` en `GET /productos` y `GET /desglose` (query).
- `body.clase` en `POST/PUT /productos` (body).

**Sunset planeado:** cuando validemos que ninguna URL/bookmark/integración lo use en telemetría. Riesgo bajo (deprecated silencioso).

## Métricas

| Categoría | # |
|-----------|---|
| PRs mergeados | 14 (F1 + F2 + F3.a→d-3 + KPIs 2a-2b + Dashboard Ventas) |
| Backend tests | 2292 pass, 4 skipped preexistentes |
| Frontend tests | 756 pass |
| Migrations | 3 |
| Archivos deleteados | 2 (`lib/clasesProducto.js` backend + frontend) |
| Componentes nuevos | 3 (`CategoriasProductoModal`, `InventarioPorCategoriaModal`, `VentasPorCategoriaModal`) |

## Referencias

- Design doc: `docs/design/categorias-crud-tenant-f3.md`
- Smoke checklist staging: `docs/runbooks/smoke-kpis-fase2-staging.md`
- Historia consolidada: `~/.claude/projects/-Users-lucasbruno-iPro-Web/memory/state_2026-07-08.md` (sección "categorías reales").
