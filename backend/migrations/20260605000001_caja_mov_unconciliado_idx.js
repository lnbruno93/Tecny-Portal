/* eslint-disable camelcase */
/**
 * Migración — Índice partial para autoMatch de conciliación.
 *
 * El índice viejo (idx_caja_mov_conciliado) filtra WHERE conciliado_en IS NOT NULL
 * — exactamente lo opuesto a lo que necesita el autoMatch (que busca movimientos
 * NO conciliados todavía en un rango de fechas para una caja específica).
 *
 * Agregamos un partial index `(caja_id, fecha) WHERE conciliado_en IS NULL`
 * que cubre exactamente el plan de:
 *   SELECT id, fecha, tipo, monto FROM caja_movimientos
 *    WHERE caja_id = $1 AND deleted_at IS NULL
 *      AND conciliado_en IS NULL
 *      AND fecha BETWEEN $2 AND $3
 * El índice viejo se conserva — es útil para reportes "movimientos conciliados".
 *
 * Sin este índice, en cajas con miles de movimientos el autoMatch hace seq-scan.
 *
 * CONCURRENTLY no se puede usar dentro de la TX que node-pg-migrate envuelve
 * por defecto. Usamos `noTransaction` (boolean) en el wrapper de la lib para
 * permitirlo. Si CONCURRENTLY falla, la migración la podemos correr a mano en
 * prod (no es bloqueante para el deploy).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_caja_mov_unconciliado
      ON caja_movimientos (caja_id, fecha)
      WHERE conciliado_en IS NULL AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_caja_mov_unconciliado;
  `);
};
