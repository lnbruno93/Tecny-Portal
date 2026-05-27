// Vínculo envío → venta: al registrar un envío como venta, se guarda la venta
// creada acá para poder borrarla/cancelarla junto con el envío y evitar duplicar.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE envios ADD COLUMN IF NOT EXISTS venta_id INTEGER REFERENCES ventas(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_envios_venta ON envios (venta_id) WHERE venta_id IS NOT NULL;
  `);
};
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_envios_venta;
    ALTER TABLE envios DROP COLUMN IF EXISTS venta_id;
  `);
};
