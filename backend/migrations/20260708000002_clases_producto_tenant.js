/**
 * 20260708000002_clases_producto_tenant.js
 *
 * Categorías reales F3.a — CRUD de categorías por tenant.
 *
 * Fase 3 de la serie categorías reales:
 *   - F1 (PR #523, mergeado): enum global de 9 slugs con emoji.
 *   - F2 (PR #524, mergeado): KPI Dashboard con chips por clase.
 *   - F3.a (este PR): CRUD editable por tenant — tabla `clases_producto`
 *     + columna `productos.clase_id` (nullable, la vieja `productos.clase`
 *     se mantiene hasta F3.d cleanup).
 *   - F3.b (próximo): frontend "Categorías" en Inventario + pantalla ABM.
 *   - F3.c (próximo): migrar Dashboard KPI + Import XLSX a usar `clase_id`.
 *   - F3.d (próximo): DROP COLUMN productos.clase + remove helpers legacy.
 *
 * Design doc completo: `docs/design/categorias-crud-tenant-f3.md`.
 *
 * Decisiones tomadas por Lucas (2026-07-08):
 *   - Delete con productos activos: BLOQUEAR (409 → operador reasigna primero).
 *   - Emoji: OPCIONAL (sin picker; input libre nullable).
 *   - Import XLSX sin match: fallback a fila "Sin categoría" del sistema
 *     por tenant (`es_sin_categoria=true`, no borrable ni renombrable).
 *   - Las 9 categorías base son editables por el tenant (seed inicial, no
 *     restricciones). Solo "Sin categoría" es de sistema (protegida).
 *
 * Cambios:
 *   1. Tabla `clases_producto` (multi-tenant con RLS).
 *   2. Unique `(tenant_id, LOWER(nombre)) WHERE deleted_at IS NULL` — evita
 *      duplicados case-insensitive por tenant, permite reusar nombre borrado.
 *   3. Unique parcial `WHERE es_sin_categoria=true` — una fila del sistema
 *      por tenant.
 *   4. Índice `(tenant_id, activa, orden) WHERE deleted_at IS NULL` — para
 *      listados con filtro por activa + orden estable.
 *   5. Habilitar RLS + policy `tenant_isolation` (mismo patrón que
 *      migration 20260615000002).
 *   6. Columna `productos.clase_id UUID NULL` (FK a clases_producto).
 *      La vieja `clase` (VARCHAR con CHECK de 9 slugs) SE MANTIENE.
 *      F3.d hará el DROP cuando todos los consumers migren.
 *   7. Backfill:
 *        - Para cada tenant, insertar 9 filas base (`es_base=true`) con los
 *          slugs actuales + 1 fila "Sin categoría" (`es_sin_categoria=true`).
 *        - Para cada producto, asociar `clase_id` mirando `productos.clase`
 *          legacy + `productos.tenant_id`.
 *
 * Idempotente: se puede re-correr sin efectos por los ON CONFLICT + WHERE
 * clase_id IS NULL. El helper de seed para tenants nuevos vive en
 * `lib/seedClasesProducto.js` — este backfill solo cubre tenants EXISTENTES
 * al momento de correr la migration. Tenants creados después usan el helper.
 *
 * Rollback (down): DROP tabla + DROP columna. Se puede re-aplicar sin problema.
 * NO destructivo para `productos.clase` legacy (queda intacto).
 */

// Enum global F1 → filas base insertadas por tenant.
// Alineado con `backend/src/lib/clasesProducto.js` y `frontend/src/lib/clasesProducto.js`.
// Si acá cambia, actualizar ambos espejos.
const CLASES_BASE = [
  { slug: 'celular_sellado',   nombre: 'Celular Sellado',   emoji: '📲', orden: 10 },
  { slug: 'celular_usado',     nombre: 'Celular Usado',     emoji: '♻️', orden: 20 },
  { slug: 'watch',             nombre: 'Watch',             emoji: '⌚', orden: 30 },
  { slug: 'auriculares',       nombre: 'Auriculares',       emoji: '🎧', orden: 40 },
  { slug: 'consolas',          nombre: 'Consolas',          emoji: '🎮', orden: 50 },
  { slug: 'computadoras',      nombre: 'Computadoras',      emoji: '💻', orden: 60 },
  { slug: 'ipads',             nombre: 'iPads',             emoji: '📱', orden: 70 },
  { slug: 'cargadores',        nombre: 'Cargadores',        emoji: '🔋', orden: 80 },
  { slug: 'accesorios_varios', nombre: 'Accesorios/Varios', emoji: '🛍️', orden: 90 },
];

exports.up = async (pgm) => {
  // ─── 1. Tabla ─────────────────────────────────────────────────────
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS clases_producto (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      nombre            VARCHAR(80) NOT NULL,
      emoji             VARCHAR(8),
      orden             INT NOT NULL DEFAULT 0,
      activa            BOOLEAN NOT NULL DEFAULT true,
      es_base           BOOLEAN NOT NULL DEFAULT false,
      es_sin_categoria  BOOLEAN NOT NULL DEFAULT false,
      slug_legacy       VARCHAR(40),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at        TIMESTAMPTZ,
      CONSTRAINT clases_producto_nombre_no_vacio CHECK (LENGTH(TRIM(nombre)) > 0),
      CONSTRAINT clases_producto_emoji_len CHECK (emoji IS NULL OR LENGTH(emoji) <= 8),
      CONSTRAINT clases_producto_no_delete_sin_categoria
        CHECK (NOT (es_sin_categoria = true AND deleted_at IS NOT NULL))
    );
  `);

  // ─── 2. Índices ──────────────────────────────────────────────────
  // Unique case-insensitive por tenant, ignorando soft-deleted (evita
  // que un delete + create del mismo nombre falle por unique).
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_clases_producto_tenant_nombre
      ON clases_producto (tenant_id, LOWER(nombre))
      WHERE deleted_at IS NULL;
  `);

  // Una sola fila "Sin categoría" por tenant (la del sistema).
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_clases_producto_sin_categoria
      ON clases_producto (tenant_id)
      WHERE es_sin_categoria = true AND deleted_at IS NULL;
  `);

  // Índice para listado con filtro activa + orden (query más común).
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_clases_producto_tenant_activa
      ON clases_producto (tenant_id, activa, orden)
      WHERE deleted_at IS NULL;
  `);

  // ─── 3. RLS ──────────────────────────────────────────────────────
  // Mismo patrón que migration 20260615000002_multitenant_rls. El rol
  // `ipro_app` (usado por la app) tiene RLS enforced. `tecny_admin`
  // (BYPASSRLS) puede operar cross-tenant desde admin.
  pgm.sql(`
    ALTER TABLE clases_producto ENABLE ROW LEVEL SECURITY;
    ALTER TABLE clases_producto FORCE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation ON clases_producto
      USING (tenant_id = current_setting('app.current_tenant', true)::int);
  `);

  // ─── 4. Columna productos.clase_id ───────────────────────────────
  // NULL por defecto. El backfill de abajo la puebla para productos
  // existentes. F3.b/c hará el switch de código para escribir clase_id
  // en cada nuevo producto. F3.d hará el DROP de la columna vieja.
  pgm.sql(`
    ALTER TABLE productos ADD COLUMN IF NOT EXISTS clase_id UUID
      REFERENCES clases_producto(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_productos_clase_id
      ON productos (tenant_id, clase_id)
      WHERE clase_id IS NOT NULL;
  `);

  // ─── 5. Trigger updated_at ───────────────────────────────────────
  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_updated_at_clases_producto()
    RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_clases_producto_updated_at ON clases_producto;
    CREATE TRIGGER trg_clases_producto_updated_at
      BEFORE UPDATE ON clases_producto
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at_clases_producto();
  `);

  // ─── 6. Backfill de tenants existentes ───────────────────────────
  // Por cada tenant activo (deleted_at IS NULL), insertar 9 clases base +
  // 1 "Sin categoría". Idempotente vía ON CONFLICT.
  //
  // Se hace por-tenant con SET LOCAL app.current_tenant para respetar RLS
  // (mismo patrón que otros seed post-signup).
  const clasesJson = JSON.stringify(CLASES_BASE).replace(/'/g, "''");
  pgm.sql(`
    DO $$
    DECLARE
      t_id INT;
      c JSONB;
      clase_row RECORD;
    BEGIN
      FOR t_id IN SELECT id FROM tenants WHERE deleted_at IS NULL LOOP
        -- SET LOCAL para RLS (bypass BYPASSRLS por si acaso — el DO $$
        -- corre como superuser en la migration).
        EXECUTE format('SET LOCAL app.current_tenant = %L', t_id);

        -- Insertar las 9 base + "Sin categoría"
        FOR c IN SELECT jsonb_array_elements('${clasesJson}'::jsonb) LOOP
          INSERT INTO clases_producto (tenant_id, nombre, emoji, orden, es_base, slug_legacy, activa)
          VALUES (
            t_id,
            c->>'nombre',
            c->>'emoji',
            (c->>'orden')::int,
            true,
            c->>'slug',
            true
          )
          ON CONFLICT (tenant_id, LOWER(nombre)) WHERE deleted_at IS NULL DO NOTHING;
        END LOOP;

        -- "Sin categoría" del sistema (para fallback de import XLSX)
        INSERT INTO clases_producto (tenant_id, nombre, orden, es_sin_categoria, activa)
        VALUES (t_id, 'Sin categoría', 999, true, true)
        ON CONFLICT (tenant_id) WHERE es_sin_categoria = true AND deleted_at IS NULL DO NOTHING;
      END LOOP;
    END $$;
  `);

  // ─── 7. Backfill productos.clase_id ──────────────────────────────
  // Para cada producto con clase legacy no-NULL, asociar el clase_id de
  // la fila `es_base` correspondiente del mismo tenant. Idempotente vía
  // WHERE clase_id IS NULL.
  pgm.sql(`
    UPDATE productos p
       SET clase_id = c.id
      FROM clases_producto c
     WHERE c.tenant_id = p.tenant_id
       AND c.es_base = true
       AND c.slug_legacy = p.clase
       AND c.deleted_at IS NULL
       AND p.clase IS NOT NULL
       AND p.clase_id IS NULL;
  `);
};

exports.down = async (pgm) => {
  // Rollback destructivo pero seguro: solo elimina lo que agregamos.
  // Los productos legacy quedan con su `clase` VARCHAR intacta.
  pgm.sql(`
    DROP INDEX IF EXISTS idx_productos_clase_id;
    ALTER TABLE productos DROP COLUMN IF EXISTS clase_id;
    DROP TABLE IF EXISTS clases_producto CASCADE;
    DROP FUNCTION IF EXISTS set_updated_at_clases_producto() CASCADE;
  `);
};
