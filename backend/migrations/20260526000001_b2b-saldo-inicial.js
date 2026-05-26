/* eslint-disable camelcase */
/**
 * Saldo inicial para clientes B2B (cuenta corriente).
 *
 * Permite que un cliente nuevo arranque con un saldo de apertura, igual que ya
 * lo hacen los Proveedores. Se modela como un movimiento `tipo='saldo_inicial'`
 * que cuenta en el saldo del mismo lado que una 'compra' (el cliente nos debe).
 *
 * Solo amplía el CHECK de `movimientos_cc.tipo`. El tipo NO se expone en el
 * endpoint de alta de movimientos (no es creable a mano): la ruta de alta de
 * cliente lo inserta programáticamente. Aditivo e idempotente.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE movimientos_cc DROP CONSTRAINT IF EXISTS movimientos_cc_tipo_check;
    ALTER TABLE movimientos_cc ADD CONSTRAINT movimientos_cc_tipo_check
      CHECK (tipo IN ('compra','pago','devolucion','parte_de_pago','entrega_mercaderia','saldo_inicial'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE movimientos_cc DROP CONSTRAINT IF EXISTS movimientos_cc_tipo_check;
    ALTER TABLE movimientos_cc ADD CONSTRAINT movimientos_cc_tipo_check
      CHECK (tipo IN ('compra','pago','devolucion','parte_de_pago','entrega_mercaderia'));
  `);
};
