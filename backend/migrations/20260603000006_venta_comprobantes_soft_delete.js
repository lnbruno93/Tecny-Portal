/* eslint-disable camelcase */
/**
 * Migración — soft-delete para `venta_comprobantes`
 *
 * Bug encontrado en la auditoría ultra (mayo-2026, hallazgo A3):
 *   - `venta_comprobantes` no tenía `deleted_at`. Al cancelar una venta, las
 *     filas seguían vivas. Riesgos:
 *       (a) `syncFinancieraComprobante` busca el primer archivo por LIMIT 1
 *           sin filtrar venta activa → puede levantar el archivo de una venta
 *           soft-deleted en escenarios de re-link.
 *       (b) Storage en TOAST crece sin tope (cada blob puede ser ~7MB) — no
 *           hay forma de limpiar archivos huérfanos sin borrar la venta dura.
 *
 * Fix:
 *   1. Agregar `deleted_at TIMESTAMPTZ` (nullable).
 *   2. Índice parcial sobre `venta_id` filtrando activos (queries más rápidas
 *      y permite reusar el patrón del resto del sistema).
 *
 * El soft-delete propiamente dicho lo aplica `revertirEfectosVenta` (lib/
 * cancelarVenta.js) en cada cancelación/borrado de venta.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE venta_comprobantes
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    -- Reemplazamos el índice genérico por uno parcial sobre filas activas.
    -- Es lo que usa el 99% de las queries (sync de Financiera, listing del
    -- detalle de venta). El viejo se mantiene como fallback histórico.
    CREATE INDEX IF NOT EXISTS idx_venta_comprobantes_venta_activos
      ON venta_comprobantes (venta_id)
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_venta_comprobantes_venta_activos;
    ALTER TABLE venta_comprobantes DROP COLUMN IF EXISTS deleted_at;
  `);
};
