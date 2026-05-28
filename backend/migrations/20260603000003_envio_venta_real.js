/**
 * Soporte para "envío → venta real":
 *   - envios.tc: tipo de cambio del envío (cuando registrar_venta=true y los
 *     items son ARS, se usa para calcular total_usd de la venta auto-creada).
 *   - envio_items.producto_id: FK opcional a productos. Cuando está presente,
 *     la venta auto-creada linkea ese producto (descuenta stock).
 *
 * Ambos campos son NULLABLE para no romper envíos viejos ni el frontend actual:
 * cuando no hay tc → la venta auto queda con total_usd=0 (registro contable)
 * cuando no hay producto_id → no se descuenta stock (los items son texto libre).
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE envios       ADD COLUMN IF NOT EXISTS tc NUMERIC(12,2);
    ALTER TABLE envio_items  ADD COLUMN IF NOT EXISTS producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_envio_items_producto
      ON envio_items (producto_id)
      WHERE producto_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_envio_items_producto;
    ALTER TABLE envio_items DROP COLUMN IF EXISTS producto_id;
    ALTER TABLE envios DROP COLUMN IF EXISTS tc;
  `);
};
