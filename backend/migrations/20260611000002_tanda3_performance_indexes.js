/* eslint-disable camelcase */
/**
 * TANDA 3 — Performance crítica (auditoría 2026-06-10).
 *
 * Índices compuestos que faltan para queries hot del dashboard y del historial.
 * Cada uno cubre EXACTAMENTE un plan que hoy hace o (a) bitmap-and de 2 índices
 * simples (caro a escala) o (b) seq scan con filter (peor a escala).
 *
 *  · P-09 — movimientos_cc(tipo, fecha DESC)
 *    Dashboard B2B (`routes/ventas.js:152`) hace `WHERE m.deleted_at IS NULL
 *    AND m.tipo='compra' AND m.fecha BETWEEN $1 AND $2`. Hoy hay índices simples
 *    `idx_mov_cc_tipo (tipo)` e `idx_mov_cc_fecha (fecha DESC)`. PG combina
 *    ambos con bitmap; el compuesto `(tipo, fecha DESC)` con partial deleted_at
 *    da single-index range scan + order-preserved, ~5–20× más rápido cuando
 *    `tipo='compra'` representa una fracción minoritaria (la mayoría de los
 *    movs CC son pagos/devoluciones, no compras).
 *
 *  · P-10 — audit_logs(tabla, created_at DESC)
 *    Historial (`routes/historial.js:114`) filtra por `tabla=$1` y ordena por
 *    `created_at DESC` con LIMIT/OFFSET. El índice viejo
 *    `idx_audit_logs_created_tabla (created_at DESC, tabla)` ordena bien pero
 *    NO hace lookup eficiente por tabla (lee del orden global y filtra). El
 *    índice `idx_audit_tabla (tabla, registro_id)` apunta a otro caso
 *    (drilldown por registro). Este nuevo compuesto resuelve el query del
 *    panel "ver solo tabla X, últimos N" en O(log N + página).
 *
 *  · P-20 — egresos(estado, fecha DESC)
 *    Dashboard ventas (`routes/ventas.js:180`) hace `WHERE deleted_at IS NULL
 *    AND estado='pagado' AND fecha BETWEEN $1 AND $2`. Mismo patrón que P-09:
 *    bitmap-and de dos índices simples vs. range scan ordenado sobre uno
 *    compuesto. Con partial `deleted_at IS NULL` mantiene el patrón del repo.
 *
 *  · P-11 — caja_movimientos: NO incluido. El compuesto ideal
 *    `(caja_id, fecha DESC) WHERE deleted_at IS NULL` YA existe como
 *    `idx_caja_mov_caja_fecha` (migración 20260525000009). El P-11 "real" es
 *    denormalizar saldo_actual con triggers — scope para PR separada.
 *
 * Todos los índices son aditivos e idempotentes. No requieren backfill.
 * node-pg-migrate envuelve la migración en una TX → no usamos CONCURRENTLY;
 * mantenemos el patrón del repo (`CREATE INDEX IF NOT EXISTS` plano).
 * En prod a escala actual estos índices se crean en segundos. Si en el futuro
 * a 1M+ filas el lock molesta, se corre a mano con CONCURRENTLY (la migración
 * IF NOT EXISTS la vuelve un no-op).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- P-09: dashboard B2B → WHERE tipo='compra' AND fecha BETWEEN ...
    CREATE INDEX IF NOT EXISTS idx_mov_cc_tipo_fecha
      ON movimientos_cc (tipo, fecha DESC)
      WHERE deleted_at IS NULL;

    -- P-10: historial → WHERE tabla=$1 ORDER BY created_at DESC LIMIT ...
    CREATE INDEX IF NOT EXISTS idx_audit_logs_tabla_created
      ON audit_logs (tabla, created_at DESC);

    -- P-20: dashboard egresos → WHERE estado='pagado' AND fecha BETWEEN ...
    CREATE INDEX IF NOT EXISTS idx_egresos_estado_fecha
      ON egresos (estado, fecha DESC)
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_egresos_estado_fecha;
    DROP INDEX IF EXISTS idx_audit_logs_tabla_created;
    DROP INDEX IF EXISTS idx_mov_cc_tipo_fecha;
  `);
};
