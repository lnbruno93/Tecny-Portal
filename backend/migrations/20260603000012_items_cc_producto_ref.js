/* eslint-disable camelcase */
/**
 * Migración — items_movimiento_cc: producto_id (FK) + cantidad
 *
 * Pedido del PO: replicar el patrón del modal de Compra a Proveedor en B2B,
 * pero invertido. Una venta B2B debe REFERENCIAR productos existentes en
 * Inventario y descontar su stock al guardar.
 *
 * Hoy `items_movimiento_cc` guarda sólo texto libre (producto, modelo, color,
 * imei_serial, valor). No hay link al producto real ni cantidad por línea.
 *
 * Cambios:
 *   - `producto_id INTEGER` FK opcional → REFERENCES productos(id) ON DELETE SET NULL.
 *     ON DELETE SET NULL para no perder el histórico si alguien borra un producto
 *     (la línea queda como texto sin referencia, igual que antes).
 *   - `cantidad INTEGER NOT NULL DEFAULT 1` → cuántas unidades de ese producto
 *     se venden en esta línea (necesario para accesorios con stock > 1).
 *   - Index parcial sobre producto_id (solo no-null) para queries como
 *     "qué ventas tocan a este producto".
 *
 * Backward compat: el `valor` legacy se mantiene. Las líneas viejas (sin
 * producto_id) siguen funcionando como texto libre.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE items_movimiento_cc
      ADD COLUMN IF NOT EXISTS producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS cantidad    INTEGER NOT NULL DEFAULT 1
        CHECK (cantidad >= 0);

    CREATE INDEX IF NOT EXISTS idx_items_mov_cc_producto
      ON items_movimiento_cc (producto_id)
      WHERE producto_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_items_mov_cc_producto;
    ALTER TABLE items_movimiento_cc
      DROP COLUMN IF EXISTS producto_id,
      DROP COLUMN IF EXISTS cantidad;
  `);
};
