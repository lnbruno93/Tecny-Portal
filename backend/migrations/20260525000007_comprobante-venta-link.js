/* eslint-disable camelcase */
/**
 * Fase 2b — vínculo entre una venta y el comprobante de Financiera que genera.
 *
 * Cuando una venta se paga con la "caja financiera" y se le adjunta el
 * comprobante, se crea automáticamente un registro en `comprobantes` (módulo
 * Financiera). `comprobantes.venta_id` permite: (a) no duplicar el comprobante,
 * (b) revertirlo (soft-delete) si la venta se cancela o borra.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE comprobantes
      ADD COLUMN IF NOT EXISTS venta_id INTEGER REFERENCES ventas(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_comprobantes_venta ON comprobantes (venta_id) WHERE venta_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_comprobantes_venta;
    ALTER TABLE comprobantes DROP COLUMN IF EXISTS venta_id;
  `);
};
