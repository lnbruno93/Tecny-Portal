/* eslint-disable camelcase */
/**
 * Migración — productos.proveedor_movimiento_id
 *
 * Auditoría #B-02: cuando una compra a proveedor crea N productos en
 * Inventario (`producto_stock`), borrar la compra revertía la caja pero
 * NO los productos. Resultado: la caja recupera el dinero y los productos
 * siguen en stock → doble beneficio contable.
 *
 * Schema:
 *   - `proveedor_movimiento_id INTEGER` FK opcional → proveedor_movimientos(id)
 *     ON DELETE SET NULL. Cuando se setea, identifica de qué compra vino
 *     el producto y permite el soft-delete en cascada al borrar la compra.
 *
 * Usage en ruta:
 *   - POST /proveedores/movimientos: al crear productos desde producto_stock,
 *     setear proveedor_movimiento_id = mov.id.
 *   - DELETE /proveedores/movimientos/:id: soft-delete los productos que
 *     vinieron de esa compra Y que aún no se vendieron. Si alguno ya se
 *     vendió (cantidad bajó), 409 y no se permite borrar la compra.
 *
 * Backfill: no necesario. Productos creados antes del deploy quedan en
 * NULL y NO se borran al borrar su compra original (comportamiento
 * conservador para datos históricos).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE productos
      ADD COLUMN IF NOT EXISTS proveedor_movimiento_id INTEGER
        REFERENCES proveedor_movimientos(id) ON DELETE SET NULL;

    -- Index parcial para resolver rápido "qué productos vinieron de esta compra"
    -- al borrar el movimiento. Acotado a vivos para no inflar.
    CREATE INDEX IF NOT EXISTS idx_productos_compra_origen
      ON productos (proveedor_movimiento_id)
      WHERE proveedor_movimiento_id IS NOT NULL AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_productos_compra_origen;
    ALTER TABLE productos DROP COLUMN IF EXISTS proveedor_movimiento_id;
  `);
};
