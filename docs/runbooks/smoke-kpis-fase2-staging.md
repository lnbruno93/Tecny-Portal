# Smoke test staging — KPIs Fase 2 (post-F3)

**PRs cubiertos:** #538 (Fase 2a backend `inv_por_clase[]`) + #539 (Fase 2b frontend Inventario/Capital).

**Objetivo:** validar en staging con un tenant real que el rediseño de KPIs post-F3 funciona end-to-end antes de dar por cerrada la serie y planear Fase 2c (sunset legacy). Ejecutable en ~10 min.

**Cuándo correrlo:**
- Después de que main tenga #538 + #539 mergeados.
- Después de que el auto-sync main → staging haya corrido (workflow `sync-main-to-staging.yml` en verde).
- Idealmente con **un tenant que tenga al menos 3 categorías con stock disponible** — así se ve el breakdown real, no solo el fallback de "Sin categoría".

**Cuándo NO correrlo:**
- Antes del sync a staging (obvio).
- Sobre `ipro_portal` (base de prod). Este runbook es para `ipro_staging`.

## Prerrequisitos

- [ ] `main` tiene el merge de #538 (SHA `e73e73e` o posterior) y #539 (SHA `a1e4aaf` o posterior). Verificá con `git log --oneline origin/main | head -5`.
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

## Sección 5 — Regresión rápida

**Objetivo:** confirmar que Fase 2 no rompió nada del flujo normal.

- [ ] **Crear producto** (`POST /productos` desde el UI): funciona, aparece en la grilla, incrementa el count de la card KPI apropiada, y aparece en el modal detalle.
- [ ] **Editar producto** (`PUT`): cambio de categoría (`clase_id`) se refleja en el modal detalle al re-abrir.
- [ ] **Import XLSX**: sube un archivo con categorías conocidas + una desconocida. Verificá que:
  - [ ] Las conocidas mapean a la clase correcta.
  - [ ] La desconocida cae en "Sin categoría".
  - [ ] El modal detalle muestra la fila "Sin categoría" post-import.
- [ ] **Cache invalidation**: después de crear/editar/importar, las métricas se refrescan sin recargar la página (`invalidateMetricas` funciona).
- [ ] **Categorías CRUD** (F3.b): abrir modal "Categorías" desde el header, agregar una categoría nueva, cerrar. Volver a abrir el modal detalle KPI → la nueva categoría aparece (aunque con count 0 → oculta hasta que le asignes producto).

## Sección 6 — Post-check

- [ ] No hay errores JS en la consola del navegador durante todo el flujo.
- [ ] No hay 500s en logs del backend staging: `railway logs --service tecny-portal-backend-staging | grep -iE "error|500"` (o el dashboard de Railway).
- [ ] El endpoint `/metricas` responde en <300ms para un tenant con ~500 productos (verificar en Network tab). Si >1s, revisar el plan de la query CTE — puede necesitar índice en `productos(tenant_id, deleted_at, estado, clase_id)`.

## Si algo falla

- **Card 3 muestra `0` o `—` con user admin** → `inv_por_clase` no llegó del backend. Verificar Sección 1. Si el shape está bien pero el card renderiza mal, es bug frontend en Inventario.jsx.
- **Modal muestra "Sin categorías con stock disponible" con datos reales** → el filtro `count > 0 || usd > 0` cortó todo. Chequear si el backend está devolviendo strings en vez de numbers (fetcher hace cast — puede haber regresión).
- **Capital muestra $0 en Stock valorizado** → falla el fallback. Ver logs del console — puede que `inv.inv_por_clase` no sea array. Verificar backend.
- **Redact caps roto (vendedor ve montos)** → **BLOQUEANTE**. Rollback inmediato. Bug de seguridad.

## Cierre

- [ ] Todas las secciones 1-6 en verde.
- [ ] Screenshot del `/inventario` con las 3 cards + modal abierto para el changelog.
- [ ] Actualizá el PR #538 y #539 con un comment: **"Staging smoke OK — $(date)"**.
- [ ] Marcá task #26 en el backlog como completed.
- [ ] Si querés dar el go a **Fase 2c** (sunset legacy), esperá 1-2 semanas post-deploy prod para que cualquier cache viejo de frontend expire.
