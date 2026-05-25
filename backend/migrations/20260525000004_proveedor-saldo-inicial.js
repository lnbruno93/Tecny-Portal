/* eslint-disable camelcase */
/**
 * Permite registrar un "saldo inicial" al crear un proveedor: un movimiento de
 * apertura (tipo 'saldo_inicial') que representa lo que ya le debemos al arrancar
 * la cuenta. Suma al saldo igual que una compra, pero es un tipo distinto para no
 * contarlo como "compra real" en los KPIs.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE proveedor_movimientos DROP CONSTRAINT IF EXISTS proveedor_movimientos_tipo_check;
    ALTER TABLE proveedor_movimientos ADD CONSTRAINT proveedor_movimientos_tipo_check
      CHECK (tipo IN ('compra','pago','saldo_inicial'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM proveedor_movimientos WHERE tipo = 'saldo_inicial';
    ALTER TABLE proveedor_movimientos DROP CONSTRAINT IF EXISTS proveedor_movimientos_tipo_check;
    ALTER TABLE proveedor_movimientos ADD CONSTRAINT proveedor_movimientos_tipo_check
      CHECK (tipo IN ('compra','pago'));
  `);
};
