/* eslint-disable camelcase */
/**
 * Fase 2b (2/2) — cablear B2B (cuentas) y Envíos al ledger de cajas.
 *
 *  · movimientos_cc.caja_id  → caja donde ingresa el pago de un cliente mayorista
 *    (tipos 'pago' / 'parte_de_pago'). monto_total ya está normalizado en USD.
 *  · envio_items.metodo_pago_id → caja donde ingresa el cobro de un item 'pago'
 *    de un envío. El texto libre `metodo_pago` se conserva por compatibilidad.
 *
 * Ambas FK son ON DELETE SET NULL: borrar una caja no rompe los movimientos
 * históricos (el ledger ya quedó registrado en caja_movimientos).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE movimientos_cc
      ADD COLUMN IF NOT EXISTS caja_id INTEGER REFERENCES metodos_pago(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_movimientos_cc_caja ON movimientos_cc (caja_id) WHERE caja_id IS NOT NULL;

    ALTER TABLE envio_items
      ADD COLUMN IF NOT EXISTS metodo_pago_id INTEGER REFERENCES metodos_pago(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_envio_items_caja ON envio_items (metodo_pago_id) WHERE metodo_pago_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_envio_items_caja;
    ALTER TABLE envio_items DROP COLUMN IF EXISTS metodo_pago_id;

    DROP INDEX IF EXISTS idx_movimientos_cc_caja;
    ALTER TABLE movimientos_cc DROP COLUMN IF EXISTS caja_id;
  `);
};
