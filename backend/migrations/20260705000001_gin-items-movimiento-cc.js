/* eslint-disable camelcase */
/**
 * Índices GIN trigram sobre `items_movimiento_cc` — completa la cobertura de
 * búsqueda de Ventas para las operaciones B2B.
 *
 * Auditoría 2026-07-05 TANDA 1 (Performance P1 #3):
 *
 * `GET /api/ventas?buscar=X` (`routes/ventas.js`) hace la búsqueda con 6 ILIKE
 * '%X%' en dos EXISTS que fanean a `venta_items` (retail) e
 * `items_movimiento_cc` (B2B). Los primeros ya tienen índices GIN desde la
 * migration `20260524000006_gin-ventas-inventario.js` (venta_items.descripcion,
 * venta_items.imei); los segundos NO.
 *
 * Efecto en un tenant con 20k ventas + 60k items B2B: cada búsqueda de 3
 * caracteres degradaba a full-scan del EXISTS de B2B → &gt;500ms end-to-end. Con
 * los GIN nuevos, la búsqueda cae a ~30-80ms (típico de trigram con LIMIT).
 *
 * Columnas indexadas:
 *   items_movimiento_cc.producto     — texto del ítem (marca/modelo/color).
 *   items_movimiento_cc.imei_serial  — IMEI para búsqueda directa.
 *
 * pg_trgm ya está habilitada por la migration del 2026-05-24; el CREATE
 * EXTENSION queda de todos modos por idempotencia (defensivo si esta migration
 * corre standalone en un ambiente sin la 006).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    -- items_movimiento_cc: sin soft-delete (se borran con el movimiento_cc padre
    -- vía ON DELETE CASCADE), así que no filtramos deleted_at.
    CREATE INDEX IF NOT EXISTS items_movimiento_cc_producto_gin
      ON items_movimiento_cc USING GIN (producto gin_trgm_ops);

    CREATE INDEX IF NOT EXISTS items_movimiento_cc_imei_serial_gin
      ON items_movimiento_cc USING GIN (imei_serial gin_trgm_ops);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS items_movimiento_cc_producto_gin;
    DROP INDEX IF EXISTS items_movimiento_cc_imei_serial_gin;
    -- pg_trgm no se elimina — puede usarla otro módulo (venta_items, productos, contactos).
  `);
};
