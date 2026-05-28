/* eslint-disable camelcase */
/**
 * Migración — GIN trigram para columnas con búsqueda ILIKE pendientes
 *
 * Hallazgos de la auditoría ultra (mayo-2026, Performance P1.3 / P1.4):
 *   - `productos.gb` se busca con ILIKE junto a nombre/imei/color (que sí tienen
 *     GIN) → el planner puede degradar a seq scan cuando una columna del OR
 *     no tiene índice. Es una columna corta ("256GB", "1TB"), perfecta para GIN.
 *   - `proyectos.nombre` y `proyectos.objetivo`: el módulo Proyectos hace ILIKE
 *     en ambos, sin índice trigram. El índice existente (btree LOWER) no aplica
 *     a `LIKE '%x%'`.
 *   - `pagos.referencia`: módulo legacy pero activo; también ILIKE sin GIN.
 *
 * Todas usan partial index `WHERE deleted_at IS NULL` para acotar al universo
 * vivo (queries reales filtran por esto).
 *
 * Operación segura: CREATE INDEX CONCURRENTLY no se usa porque node-pg-migrate
 * envuelve la migración en una tx (y CONCURRENTLY requiere no-tx). Estos índices
 * son pequeños y rápidos de crear; el impacto del lock es mínimo.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- productos.gb (string corto: '64', '128GB', '1TB')
    CREATE INDEX IF NOT EXISTS productos_gb_gin
      ON productos USING GIN (gb gin_trgm_ops)
      WHERE deleted_at IS NULL;

    -- proyectos.nombre + proyectos.objetivo (textos cortos del módulo Proyectos)
    CREATE INDEX IF NOT EXISTS proyectos_nombre_gin
      ON proyectos USING GIN (nombre gin_trgm_ops)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS proyectos_objetivo_gin
      ON proyectos USING GIN (objetivo gin_trgm_ops)
      WHERE deleted_at IS NULL;

    -- pagos.referencia (legacy pero ILIKE activo)
    CREATE INDEX IF NOT EXISTS pagos_referencia_gin
      ON pagos USING GIN (referencia gin_trgm_ops)
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS productos_gb_gin;
    DROP INDEX IF EXISTS proyectos_nombre_gin;
    DROP INDEX IF EXISTS proyectos_objetivo_gin;
    DROP INDEX IF EXISTS pagos_referencia_gin;
  `);
};
