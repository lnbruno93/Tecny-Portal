/* eslint-disable camelcase */
/**
 * Fase 2b — marca una caja como "la financiera".
 *
 * Cuando una venta se paga con la caja financiera y adjunta comprobante, el
 * sistema genera automáticamente el comprobante en el módulo Financiera
 * (comisión = monto × config.pct_financiera). Solo una caja puede ser la
 * financiera a la vez (se asegura por lógica de la app, igual que la garantía
 * predeterminada).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE metodos_pago
      ADD COLUMN IF NOT EXISTS es_financiera BOOLEAN NOT NULL DEFAULT false;
    -- A lo sumo una caja financiera activa
    CREATE UNIQUE INDEX IF NOT EXISTS idx_metodos_pago_financiera
      ON metodos_pago ((1)) WHERE es_financiera = true AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_metodos_pago_financiera;
    ALTER TABLE metodos_pago DROP COLUMN IF EXISTS es_financiera;
  `);
};
