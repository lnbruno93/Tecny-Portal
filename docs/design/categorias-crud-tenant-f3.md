# Categorías reales F3 — CRUD por tenant

**Estado:** diseño aprobado por Lucas (2026-07-08). Implementación pendiente en 4 fases.

## Contexto

Al 2026-07-08 el enum `productos.clase` tiene **9 categorías fijas globales** (F1 mergeada PR #523):
`celular_sellado, celular_usado, watch, auriculares, consolas, computadoras, ipads, cargadores, accesorios_varios`.

F2 (PR #524, mergeada) agregó chips por clase en el KPI del Dashboard de Ventas.

**Necesidad:** cada tenant tiene un negocio distinto — algunos venden fundas, repuestos, servicios técnicos, camisetas, etc. Las 9 categorías fijas no cubren la diversidad. Además, el operador quiere renombrar / cambiar emoji / reordenar según su preferencia.

## Decisión de diseño

**Opción elegida:** tabla `clases_producto` por tenant, con **CRUD full editable**.

Descartadas:
- Enum fijo (F1 actual) — no permite personalización
- Enum base + activar/desactivar por tenant — no permite categorías nuevas
- Enum base + tags libres — dos ejes de categorización complejizan la UX

## Decisiones específicas (aprobadas por Lucas)

| Decisión | Elegida | Razonamiento |
|---|---|---|
| **Delete con productos activos** | Bloquear | Seguro, sin pérdida de datos. Operador reasigna primero. |
| **Emoji** | Opcional | Sin fricción — si no ponen emoji, se renderiza solo el nombre. Evita picker complejo. |
| **Import XLSX sin match** | Fallback a "Sin categoría" | Fila de sistema `es_sin_categoria=true` por tenant. Operador reclasifica manualmente. Sin sorpresas ni basura. |
| **9 base editables** | Sí, todo editable | Coherente con "cada tenant define las suyas". Las 9 son seed inicial, no restricciones. |

## Modelo de datos

```sql
-- Tabla nueva: categorías por tenant
CREATE TABLE clases_producto (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nombre VARCHAR(80) NOT NULL,
  emoji VARCHAR(8),
  orden INT NOT NULL DEFAULT 0,
  activa BOOLEAN NOT NULL DEFAULT true,
  es_base BOOLEAN NOT NULL DEFAULT false,       -- seed inicial (para reporting admin)
  es_sin_categoria BOOLEAN NOT NULL DEFAULT false,  -- fallback del import XLSX
  slug_legacy VARCHAR(40),                       -- backfill: link al enum viejo
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  CHECK (LENGTH(TRIM(nombre)) > 0),
  CHECK (emoji IS NULL OR LENGTH(emoji) <= 8)
);

-- Unique de nombre por tenant (case-insensitive, ignorando soft-deleted)
CREATE UNIQUE INDEX uq_clases_tenant_nombre
  ON clases_producto (tenant_id, LOWER(nombre))
  WHERE deleted_at IS NULL;

-- Un solo "sin categoría" por tenant
CREATE UNIQUE INDEX uq_clases_sin_categoria
  ON clases_producto (tenant_id)
  WHERE es_sin_categoria = true AND deleted_at IS NULL;

CREATE INDEX idx_clases_tenant_activa
  ON clases_producto (tenant_id, activa, orden)
  WHERE deleted_at IS NULL;

-- RLS
ALTER TABLE clases_producto ENABLE ROW LEVEL SECURITY;
CREATE POLICY clases_tenant_isolation ON clases_producto
  USING (tenant_id = current_setting('app.current_tenant')::uuid);

-- Nueva FK en productos
ALTER TABLE productos
  ADD COLUMN clase_id UUID REFERENCES clases_producto(id);

-- La columna `productos.clase` legacy se mantiene hasta F3.d (cleanup final).
```

## Endpoints

**Base:** `/api/inventario/clases` (dentro del recurso Inventario). Permisos: capability `inventario` para lectura, `inventario_config` para escritura (crear si no existe).

| Verbo | Ruta | Body | Response | Notas |
|---|---|---|---|---|
| GET | `/clases` | — | `[{id, nombre, emoji, orden, activa, es_base, es_sin_categoria, count_productos}]` | Ordenado por `orden ASC, nombre ASC`. Incluye `count_productos` (con `deleted_at IS NULL`) para el UI de delete. |
| POST | `/clases` | `{nombre, emoji?, activa?}` | `{id, nombre, ...}` | Rechaza duplicado (case-insensitive). `emoji` opcional, `activa=true` default. |
| PUT | `/clases/:id` | `{nombre?, emoji?, activa?, orden?}` | `{id, nombre, ...}` | Bloquear editar `es_sin_categoria` (fila de sistema). |
| DELETE | `/clases/:id` | — | `204` o `409` | Si tiene productos activos → 409 con `{error: 'HAS_PRODUCTOS', count_productos}`. Si es `es_sin_categoria` → 409 (no borrable). |
| POST | `/clases/reorder` | `[{id, orden}, ...]` | `204` | Batch update transaccional. |

## UI

**Pantalla nueva:** "Categorías" — tab en el módulo Inventario (o modal desde Configuración de Inventario).

Componentes:
- **Lista drag&drop** — reordenar arrastrando (guarda `orden` al soltar).
- **Botón "Agregar categoría"** — modal con:
  - Nombre (required, max 80 chars, unique)
  - Emoji (opcional, input libre para pegar emoji del teclado del sistema)
  - Toggle Activa (default ON)
- **Edit inline** (o modal) — mismo form.
- **Delete** — botón basura con confirmación:
  - Si `count_productos > 0`: alerta "No se puede borrar porque tiene X productos. Reasignalos primero." + link a la grilla filtrada.
  - Si `es_sin_categoria`: botón deshabilitado con tooltip "Categoría del sistema, no borrable."
  - Si OK: soft-delete + refresh.
- **Preview de chip** — al lado del nombre mostrar cómo se ve el chip (`{emoji} {nombre}`).

## Seed / backfill

**Al crear tenant nuevo** (en signup / admin manual):
1. Insertar 9 filas base (`es_base=true`) con los slugs actuales.
2. Insertar 1 fila especial `es_sin_categoria=true` con nombre "Sin categoría" (sin emoji).

**Backfill de tenants existentes** (una migration):
1. Para cada tenant, insertar 9 filas base + 1 "Sin categoría" (con los slugs actuales del enum).
2. Para cada producto: `UPDATE productos SET clase_id = c.id FROM clases_producto c WHERE c.tenant_id = productos.tenant_id AND c.slug_legacy = productos.clase`.

Migration idempotente (poder correr múltiples veces).

## Migración de consumers

**Consumers de `productos.clase` hoy:**
1. `backend/src/routes/inventario.js` — validación en alta/edición
2. `backend/src/routes/ventas.js` — F2 KPI dashboard (`unidades_por_clase`)
3. `backend/src/lib/inventarioCache.js` — buckets legacy (equipos vs accesorios)
4. `backend/src/lib/importStock.js` — `resolveClaseXlsx` con aliases
5. `frontend/src/screens/Inventario.jsx` — dropdown + tabs + grilla
6. `frontend/src/screens/ventas/Dashboard.jsx` — chips F2

Cada uno migra en su fase (ver plan abajo).

## Import XLSX (F3.c)

- Match del XLSX por `nombre` (case-insensitive, trim) contra `clases_producto` del tenant.
- Aliases legacy (`airpod → auriculares`, `watch → watch`, etc.) → si el label del XLSX matchea un alias, resolver al slug legacy y buscar por `slug_legacy` en `clases_producto`.
- Si no matchea nada → asignar a la fila `es_sin_categoria=true` del tenant.
- Log de reporting post-import: "X productos importados, Y quedaron en Sin categoría".

## Dashboard F2 (F3.c)

**Cambio en response:**
- Antes (F2): `unidades_por_clase: { "watch": 3, "cargadores": 12 }` (map por slug)
- Después (F3): `unidades_por_clase: [{ clase_id, nombre, emoji, n }, ...]` (array ordenado desc)

**Frontend:** ya no necesita `CLASES_LABELS` hardcoded — usa `nombre` + `emoji` del backend directamente.

**Fallback:** si el backend devuelve el shape viejo (deploy incompleto), el frontend detecta con `Array.isArray()` y renderiza acorde.

## Plan en 4 fases (4 PRs independientes)

### F3.a — Backend: modelo + endpoints + backfill

**Alcance:**
- Migration: `clases_producto` + índices + RLS + policy
- Migration: `productos.clase_id UUID NULL`
- Migration: backfill (9 base + Sin categoría por tenant, asociar productos)
- Endpoints CRUD `/api/inventario/clases`
- Hook en creación de tenant nuevo (seed 9 base + Sin categoría)
- Tests unitarios + integration
- **NO tocar frontend todavía. Mantener `productos.clase` legacy y todos sus consumers funcionando.**

**Riesgo:** bajo. Solo aditivo. Rollback = drop tabla + drop columna.

### F3.b — Frontend: pantalla Categorías + Inventario

**Alcance:**
- Pantalla "Categorías" en Inventario tab.
- Componente drag&drop.
- Modal alta/edición.
- Delete guard con `count_productos`.
- Dropdown de alta/edición de producto → usa `clase_id` (opcional: doble-escribir a `clase` legacy durante transición).
- Grilla y tabs de filtro → derivan de `clases_producto`.
- Tests RTL.

**Riesgo:** medio. UI grande + coordinación con backend.

### F3.c — Migrar consumers restantes

**Alcance:**
- Dashboard F2 KPI: query con `clase_id` + JOIN. Response en array shape nuevo.
- Frontend Dashboard: renderiza array shape con fallback al viejo.
- Import XLSX: match por nombre + fallback Sin categoría.
- `inventarioCache.js`: buckets legacy → derivar de `clase_id` (o desactivar si ya no se usa).
- Tests E2E + unit actualizados.

**Riesgo:** bajo. Consumers puntuales, un cambio a la vez.

### F3.d — Cleanup del enum legacy

**Alcance:**
- Verificar que no queda ningún consumer leyendo `productos.clase`.
- Migration: `DROP COLUMN productos.clase`.
- Remover `backend/src/lib/clasesProducto.js` y `frontend/src/lib/clasesProducto.js` (o dejar helper de fallback defensivo).
- Remover backfill scripts one-shot.

**Riesgo:** bajo si F3.b y F3.c bien mergeados.

## Riesgos y mitigaciones

- **Backfill de tenants con muchos productos:** el UPDATE puede ser lento. Mitigar con índice `productos.clase` + transacción por batches (o correr durante ventana de bajo tráfico).
- **Doble fuente de verdad durante F3.b:** productos tienen `clase` y `clase_id`. Puede haber drift. Mitigar con trigger sincronizador o convención: escribir `clase_id`, leer de donde esté disponible.
- **Cache inventario:** `inventarioCache.js` puede tener buckets estáticos por slug. Chequear que no rompa al desactivarse.
- **Multi-tenant cross-tenant admin reporting:** en el back office admin no hay una noción común de categoría entre tenants. Reportar por `es_base + slug_legacy` (útil para "cuántos watches se vendieron cross-tenant este mes"). Documentar limitación.

## Próximos pasos

Después del merge de F3.a puede seguir F3.b sin dependencias externas. F3.c y F3.d dependen del despliegue completo de F3.b.

Design candidato para trabajarse con **Claude Fable 5** — decisión arquitectural con múltiples ramificaciones (multi-tenant, RLS, backfill, migración progresiva).
