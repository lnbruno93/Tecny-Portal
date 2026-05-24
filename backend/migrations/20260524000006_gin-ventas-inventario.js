/* eslint-disable camelcase */
/**
 * Migración 006 — Índices GIN trigram para las búsquedas ILIKE de Inventario y Ventas.
 *
 * Sin estos índices, cada búsqueda con ILIKE '%texto%' hace un seq scan completo.
 * Con pg_trgm + GIN, PostgreSQL usa el índice incluso con patrones %infijo%.
 * Mismo patrón que la migración 007 (envíos/comprobantes).
 *
 * Columnas de búsqueda:
 *   productos    — nombre, imei, color (GET /inventario/productos?buscar=)
 *   ventas       — order_id, cliente_nombre (GET /ventas?buscar=)
 *   venta_items  — descripcion, imei (subquery EXISTS del buscar de ventas)
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    -- Productos (solo filas activas)
    CREATE INDEX IF NOT EXISTS productos_nombre_gin ON productos USING GIN (nombre gin_trgm_ops) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS productos_imei_gin   ON productos USING GIN (imei   gin_trgm_ops) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS productos_color_gin  ON productos USING GIN (color  gin_trgm_ops) WHERE deleted_at IS NULL;

    -- Ventas (solo filas activas)
    CREATE INDEX IF NOT EXISTS ventas_order_id_gin       ON ventas USING GIN (order_id       gin_trgm_ops) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS ventas_cliente_nombre_gin ON ventas USING GIN (cliente_nombre gin_trgm_ops) WHERE deleted_at IS NULL;

    -- Ítems de venta (sin soft-delete; se borran con la venta)
    CREATE INDEX IF NOT EXISTS venta_items_descripcion_gin ON venta_items USING GIN (descripcion gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS venta_items_imei_gin        ON venta_items USING GIN (imei        gin_trgm_ops);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS productos_nombre_gin;
    DROP INDEX IF EXISTS productos_imei_gin;
    DROP INDEX IF EXISTS productos_color_gin;
    DROP INDEX IF EXISTS ventas_order_id_gin;
    DROP INDEX IF EXISTS ventas_cliente_nombre_gin;
    DROP INDEX IF EXISTS venta_items_descripcion_gin;
    DROP INDEX IF EXISTS venta_items_imei_gin;
    -- pg_trgm no se elimina (puede usarla otro módulo).
  `);
};
