/* eslint-disable camelcase */
/**
 * Migración 005 — Vínculo entre una venta y la deuda de cuenta corriente que genera.
 *
 * Cuando una venta se paga (total o parcialmente) en cuenta corriente, se crea un
 * movimiento 'compra' en movimientos_cc (en USD, igual que el resto del módulo CC).
 * Esta columna permite revertir esa deuda (soft-delete) si la venta se cancela,
 * edita o elimina, manteniendo el saldo del cliente siempre consistente.
 *
 * Cambio ADITIVO y seguro: columna nullable; no afecta a los movimientos existentes.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE movimientos_cc
      ADD COLUMN IF NOT EXISTS venta_id INTEGER REFERENCES ventas(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_mov_cc_venta ON movimientos_cc (venta_id) WHERE venta_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_mov_cc_venta;
    ALTER TABLE movimientos_cc DROP COLUMN IF EXISTS venta_id;
  `);
};
