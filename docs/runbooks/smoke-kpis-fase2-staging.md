# Smoke test staging — KPIs Fase 2 (post-F3) + Dashboard Ventas

**PRs cubiertos:** #538 (Fase 2a backend `inv_por_clase[]`) + #539 (Fase 2b frontend Inventario/Capital) + #541 (rediseño Dashboard Ventas, Opción C).

**Objetivo:** validar en staging con un tenant real que el rediseño de KPIs post-F3 funciona end-to-end antes de dar por cerrada la serie y planear Fase 2c (sunset legacy). Ejecutable en ~12 min.

**Cuándo correrlo:**
- Después de que main tenga #538 + #539 + #541 mergeados.
- Después de que el auto-sync main → staging haya corrido (workflow `sync-main-to-staging.yml` en verde).
- Idealmente con **un tenant que tenga al menos 3 categorías con stock disponible + al menos 2 ventas de categorías distintas en el rango** — así se ve el breakdown real, no solo el fallback binario.

**Cuándo NO correrlo:**
- Antes del sync a staging (obvio).
- Sobre `ipro_portal` (base de prod). Este runbook es para `ipro_staging`.

## Prerrequisitos

- [ ] `main` tiene el merge de #538 (SHA `e73e73e` o posterior), #539 (SHA `a1e4aaf` o posterior) y #541 (SHA `3b7fb46` o posterior). Verificá con `git log --oneline origin/main | head -5`.
- [ ] Workflow `Sync main → staging` en verde para el último commit de main: `gh run list --workflow=sync-main-to-staging.yml --limit 1`.
- [ ] Backend staging responde `/health` con `{status:"ok"}` (ver `docs/STAGING.md`).
- [ ] Frontend staging carga el login.
- [ ] Credenciales de un tenant con **≥3 clases_producto activas** y **≥5 productos disponibles distribuidos en varias categorías**. Si no existe, seedeá un tenant demo con `POST /api/inventario/productos/bulk` antes de arrancar.

## Sección 1 — Backend `/metricas` shape

**Objetivo:** confirmar que Fase 2a está desplegada correctamente.

- [ ] `GET /api/inventario/productos/metricas` con `Authorization: Bearer <token del admin>` devuelve HTTP 200.
- [ ] El response tiene `inv_por_clase` como array (no null, no undefined).
- [ ] Cada fila del array tiene las 9 keys: `clase_id`, `nombre`, `emoji`, `es_base`, `es_sin_categoria`, `slug_legacy`, `count`, `usd`, `ars`.
- [ ] `count`, `usd`, `ars` son números (no strings — verificar `typeof`).
- [ ] Los buckets legacy (`inv_equipos_usd`, `inv_accesorios_usd`, `equipos_count`, `accesorios_count`) siguen presentes y con valores numéricos.
- [ ] **Coherencia:** `SUM(inv_por_clase[].usd)` ≈ `inv_equipos_usd + inv_accesorios_usd` (± centavos por redondeo).
- [ ] El orden respeta `orden ASC → USD DESC → nombre ASC`.

**Redact caps** (con un user vendedor sin `inventario.ver_costos`):
- [ ] Cada fila tiene `usd: null` y `ars: null`.
- [ ] `count` sigue siendo número (no redactado).
- [ ] `nombre`, `emoji`, `slug_legacy` intactos (metadata pública).

## Sección 2 — Frontend Inventario: cards KPI

**Objetivo:** confirmar que la nueva grilla de 3 cards renderiza y que el card "Total valorizado" suma correcto.

- [ ] Abrir `/inventario` en el navegador. Sobre el header, hay **3 cards** (no 4):
  1. **En técnico** — count amarillo, USD abajo (o `—` si sin ver_costos)
  2. **Stock disponible** — total unidades en verde, "unidades" abajo
  3. **Total valorizado** — USD grande, "N categorías con stock" abajo
- [ ] El monto del card 3 matchea `SUM(inv_por_clase[].usd)` de la Sección 1.
- [ ] El subtítulo "N categorías con stock" cuenta correctamente las filas con `count > 0` OR `usd > 0`.
- [ ] Si el user es vendedor (sin ver_costos), el card 3 muestra `—` en vez del monto.

**Mobile check** (redimensionar ventana <880px o abrir desde iPhone/SE emulado en devtools):
- [ ] Las 3 cards se apilan a 2 columnas (grid heredado del `.kpi-grid` breakpoint).
- [ ] Nada se corta ni se exprime a <70px de ancho.

## Sección 3 — Frontend Inventario: modal detalle

**Objetivo:** confirmar que el nuevo `InventarioPorCategoriaModal` abre, renderiza el breakdown y cierra bien.

- [ ] Debajo de las 3 cards hay un botón **`Ver detalle por categoría →`**.
- [ ] Está **deshabilitado** mientras las métricas cargan (spinner o skeleton en cards) y **habilitado** cuando llegan.
- [ ] Click abre modal con overlay oscuro.
- [ ] Título: **"Inversión por categoría"**.
- [ ] Lista: una fila por categoría con `count > 0` OR `valorizado > 0`.
  - [ ] Cada fila: emoji (o `📦` si `es_sin_categoria`, o `·` fallback) + nombre + "N u" + "USD X".
  - [ ] Filas con `count=0` y `valorizado=0` **NO aparecen** (filtro de ruido visual).
  - [ ] Si hay productos con `clase_id NULL` (huérfanos), aparece fila **"Sin categoría"** con badge "sin categoría" en gris al final.
- [ ] Footer con línea **`∑ Total`** que muestra:
  - [ ] ΣUnidades = suma de counts de las filas visibles.
  - [ ] ΣUSD = suma de usd de las filas visibles.
- [ ] Si hay filas con `ars > 0`, línea adicional debajo: `+ ARS X en costos locales`.
- [ ] **Cerrar el modal:**
  - [ ] Tecla `Esc` cierra.
  - [ ] Click en overlay (afuera del modal) cierra.
  - [ ] Click en botón X del header cierra.
  - [ ] Click en botón `Cerrar` del footer cierra.
- [ ] **Focus trap:** mientras el modal está abierto, `Tab` no escapa afuera.
- [ ] **Scroll lock:** el fondo (grilla de Inventario) no scrollea mientras el modal está abierto.

**Redact caps (con vendedor sin ver_costos):**
- [ ] Filas siguen renderizando: emoji, nombre, count.
- [ ] Columna USD muestra `—` en cada fila.
- [ ] **Footer `∑ Total` NO aparece** (oculto porque todo `usd` es null).
- [ ] Línea `+ ARS X` tampoco.

## Sección 4 — Frontend Capital: patrimonio

**Objetivo:** confirmar que "Stock valorizado" en el patrimonio suma desde `inv_por_clase[]` sin regresiones vs. la vista pre-Fase 2b.

- [ ] Abrir `/capital` (o el nombre exacto del screen, ver sidebar).
- [ ] En "Composición del patrimonio", card **"Stock valorizado"** con montos ARS + USD.
- [ ] Los montos matchean `SUM(inv_por_clase[].ars) + en_tecnico_ars` (local) y `SUM(inv_por_clase[].usd) + en_tecnico_usd` (USD).
- [ ] Los totales `Patrimonio · ARS` y `Patrimonio · USD` incluyen el stock valorizado correctamente.

**Redact caps (vendedor sin ver_costos)** — vendedor típicamente no ve Capital, pero si el tenant le dio acceso:
- [ ] El card "Stock valorizado" cae al fallback legacy (`inv_equipos_* + inv_accesorios_* + en_tecnico_*`) — igual arroja el mismo total.

## Sección 5 — Frontend Dashboard Ventas: card Unidades vendidas

**Objetivo:** confirmar que el rediseño Opción C del card KPI "Unidades vendidas" (#541) renderiza correctamente y que el modal detalle funciona.

**Contexto:** el card antes mostraba chips inline con emoji + nombre + count. Con 8+ categorías vendidas se desbalanceaba vs. los otros 3 cards de la fila. Ahora: total + top categoría + botón que abre modal con ranking completo.

### 5.1 Card compacto (shape ARRAY)

Con un tenant que tenga ≥3 categorías con ventas en el rango:

- [ ] Abrir `/ventas` (o el screen que renderiza el Dashboard).
- [ ] Card **"Unidades vendidas"** en la fila de 4 KPIs superior muestra:
  1. Total agregado (número grande, monoespaciado).
  2. Label muted **"en N categorías"** (donde N = filas con `n > 0`).
  3. Línea muted **"Top: {emoji} {nombre} {n}"** — la categoría con más ventas del rango.
  4. Botón **`Ver detalle →`** (btn-sm).
- [ ] El total agregado matchea `SUM(unidades_por_clase[].n)`.
- [ ] El top es la fila con `n` más alto (verificar contra el response del backend).
- [ ] El card queda **balanceado en altura con los otros 3** de la fila (Ganancia neta / Costos / Inversión canjes) — ~90px c/u.

### 5.2 Modal detalle (`VentasPorCategoriaModal`)

- [ ] Click en `Ver detalle →` abre modal con overlay oscuro.
- [ ] Título: **"Unidades vendidas por categoría"**.
- [ ] Lista: una fila por categoría con `n > 0`, ordenada por count DESC (más vendidas arriba).
  - [ ] Cada fila: emoji (o `·` si null) + nombre + porcentaje relativo (`n/total`, 1 decimal) + count con sufijo "u".
  - [ ] Filas con `n = 0` **NO aparecen**.
- [ ] Footer con línea **`∑ Total`** que muestra:
  - [ ] ΣUnidades = suma de counts de las filas visibles.
  - [ ] Label **"N cat."** (donde N = filas visibles).
- [ ] **Cerrar el modal:**
  - [ ] Tecla `Esc` cierra.
  - [ ] Click en overlay cierra.
  - [ ] Click en botón X del header cierra.
  - [ ] Click en botón `Cerrar` del footer cierra.
- [ ] **Focus trap:** mientras el modal está abierto, `Tab` no escapa afuera.
- [ ] **Scroll lock:** el fondo (Dashboard) no scrollea mientras el modal está abierto.

### 5.3 Fallback binario (shape vacío / undefined)

Con un rango de fechas SIN ventas (ej: mañana futuro), o simulando un backend viejo:

- [ ] El card "Unidades vendidas" muestra `📱 0 · 🎧 0` (fallback binario pre-F2).
- [ ] **NO aparece** el botón `Ver detalle →`.
- [ ] NO hay crash — el card renderiza normal.

### 5.4 Redact caps

**Nota:** el shape `unidades_por_clase[]` NO tiene datos sensibles (solo counts + metadata pública). No hay redact específico en este endpoint. Los otros cards KPI del Dashboard (Ganancia neta, Costos) sí tienen redact vía `ventas.ver_ganancias` — no cambia con #541.

## Sección 6 — Regresión rápida

**Objetivo:** confirmar que Fase 2 no rompió nada del flujo normal.

- [ ] **Crear producto** (`POST /productos` desde el UI): funciona, aparece en la grilla, incrementa el count de la card KPI apropiada, y aparece en el modal detalle.
- [ ] **Editar producto** (`PUT`): cambio de categoría (`clase_id`) se refleja en el modal detalle al re-abrir.
- [ ] **Import XLSX**: sube un archivo con categorías conocidas + una desconocida. Verificá que:
  - [ ] Las conocidas mapean a la clase correcta.
  - [ ] La desconocida cae en "Sin categoría".
  - [ ] El modal detalle muestra la fila "Sin categoría" post-import.
- [ ] **Registrar una venta** con al menos 2 items de categorías distintas → verificar que:
  - [ ] El card Dashboard "Unidades vendidas" se actualiza (refrescar el rango si tiene cache).
  - [ ] El modal detalle muestra las categorías del venta con sus counts.
- [ ] **Cache invalidation**: después de crear/editar/importar, las métricas se refrescan sin recargar la página (`invalidateMetricas` funciona).
- [ ] **Categorías CRUD** (F3.b): abrir modal "Categorías" desde el header, agregar una categoría nueva, cerrar. Volver a abrir el modal detalle KPI → la nueva categoría aparece (aunque con count 0 → oculta hasta que le asignes producto).

## Sección 7 — Post-check

- [ ] No hay errores JS en la consola del navegador durante todo el flujo.
- [ ] No hay 500s en logs del backend staging: `railway logs --service tecny-portal-backend-staging | grep -iE "error|500"` (o el dashboard de Railway).
- [ ] El endpoint `/metricas` responde en <300ms para un tenant con ~500 productos (verificar en Network tab). Si >1s, revisar el plan de la query CTE — puede necesitar índice en `productos(tenant_id, deleted_at, estado, clase_id)`.

## Si algo falla

**Inventario (Secciones 2-3):**
- **Card 3 muestra `0` o `—` con user admin** → `inv_por_clase` no llegó del backend. Verificar Sección 1. Si el shape está bien pero el card renderiza mal, es bug frontend en Inventario.jsx.
- **Modal muestra "Sin categorías con stock disponible" con datos reales** → el filtro `count > 0 || usd > 0` cortó todo. Chequear si el backend está devolviendo strings en vez de numbers (fetcher hace cast — puede haber regresión).
- **Redact caps roto en Inventario (vendedor ve montos)** → **BLOQUEANTE**. Rollback inmediato. Bug de seguridad.

**Capital (Sección 4):**
- **Capital muestra $0 en Stock valorizado** → falla el fallback. Ver logs del console — puede que `inv.inv_por_clase` no sea array. Verificar backend.

**Dashboard Ventas (Sección 5):**
- **Card "Unidades vendidas" muestra el bucket binario `📱 0 · 🎧 0` con ventas reales en el rango** → el shape `unidades_por_clase` viene undefined o vacío del backend. Verificar `GET /api/ventas/dashboard` con curl. Si el backend devuelve el array pero el frontend cae al fallback, es bug de detección en Dashboard.jsx.
- **Modal detalle muestra "Sin ventas por categoría en el rango" con ventas reales** → el filtro `n > 0` cortó todo. Verificar shape del array (el backend puede estar devolviendo `n` como string en vez de number).
- **Botón `Ver detalle` no aparece** → el shape `unidades_por_clase` no es array de longitud > 0. Consistente con el fallback.

## Cierre

- [ ] Todas las secciones 1-7 en verde.
- [ ] Screenshot del `/inventario` con las 3 cards + modal abierto para el changelog.
- [ ] Screenshot del `/ventas` (Dashboard) con el card "Unidades vendidas" resumido + modal detalle abierto.
- [ ] Actualizá los PRs #538, #539 y #541 con un comment: **"Staging smoke OK — $(date)"**.
- [ ] Marcá task #26 en el backlog como completed.
- [ ] Si querés dar el go a **Fase 2c** (sunset legacy), esperá 1-2 semanas post-deploy prod para que cualquier cache viejo de frontend expire.
