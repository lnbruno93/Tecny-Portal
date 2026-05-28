/**
 * envio_items: agregar moneda + tc para soportar pagos en USD/USDT/ARS
 * (no solo ARS como originalmente). El syncEnvioCaja usa estos campos al
 * postear al ledger; el frontend infiere la moneda de la caja elegida.
 *
 * Ambos campos opcionales:
 *   - moneda: default 'ARS' (compat con envíos viejos).
 *   - tc: opcional (necesario solo si moneda es ARS y queremos monto_usd preciso).
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE envio_items
      ADD COLUMN IF NOT EXISTS moneda VARCHAR(8) NOT NULL DEFAULT 'ARS',
      ADD COLUMN IF NOT EXISTS tc NUMERIC(12,2);
    ALTER TABLE envio_items
      ADD CONSTRAINT envio_items_moneda_check
      CHECK (moneda IN ('ARS','USD','USDT'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE envio_items DROP CONSTRAINT IF EXISTS envio_items_moneda_check;
    ALTER TABLE envio_items DROP COLUMN IF EXISTS tc;
    ALTER TABLE envio_items DROP COLUMN IF EXISTS moneda;
  `);
};
