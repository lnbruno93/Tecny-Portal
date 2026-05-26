/* eslint-disable camelcase */
/**
 * Índice para la vista de ledger global (Cajas → Historial Movimientos), que
 * filtra por `origen` y ordena por fecha. Soporta `GET /api/cajas/movimientos`
 * cuando se filtra por origen, en una tabla que crece con cada venta/envío/etc.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_caja_mov_origen_fecha
      ON caja_movimientos (origen, fecha DESC)
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS idx_caja_mov_origen_fecha;');
};
