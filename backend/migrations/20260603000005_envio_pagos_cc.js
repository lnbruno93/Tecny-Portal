/**
 * Envíos: soporte completo de métodos de pago como en Ventas.
 *
 *  - envios.cliente_cc_id: FK al cliente de cuenta corriente vinculado al envío.
 *    Requerido cuando algún item 'pago' del envío es es_cuenta_corriente=true.
 *  - envio_items.es_cuenta_corriente: marca un pago como CC (genera deuda en
 *    movimientos_cc a través de la venta auto-creada).
 *
 * Ambos nullable / default falso para compat con envíos viejos.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE envios
      ADD COLUMN IF NOT EXISTS cliente_cc_id INTEGER REFERENCES clientes_cc(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_envios_cliente_cc
      ON envios (cliente_cc_id) WHERE cliente_cc_id IS NOT NULL;

    ALTER TABLE envio_items
      ADD COLUMN IF NOT EXISTS es_cuenta_corriente BOOLEAN NOT NULL DEFAULT false;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE envio_items DROP COLUMN IF EXISTS es_cuenta_corriente;
    DROP INDEX IF EXISTS idx_envios_cliente_cc;
    ALTER TABLE envios DROP COLUMN IF EXISTS cliente_cc_id;
  `);
};
