/**
 * Agregar `vuelto_tc` a `ventas` para persistir el TC del vuelto cuando la
 * moneda del vuelto ≠ USD/USDT.
 *
 * 2026-07-14 (bug reportado por Lucas): el feature vuelto del 2026-07-13 (task
 * #92) agregó `vuelto_monto`, `vuelto_moneda`, `vuelto_caja_id` pero NO el TC.
 * Consecuencias:
 *   1. Sin TC, la conversión ARS/UYU → USD es imposible → la ganancia_usd
 *      persistida NO restaba el vuelto → el reporte de ganancia mentía.
 *   2. El preview del modal Nueva venta mostraba "Ganancia real: u$s120" para
 *      una venta cobrada USD 600 (cubierta) + vuelto ARS 150.000: el vuelto se
 *      ignoraba por completo.
 *
 * Diseño:
 *   · `vuelto_tc` NUMERIC(12,4) nullable (misma precisión que `tc_venta`).
 *   · CHECK: si `vuelto_moneda IN ('ARS','UYU')` entonces `vuelto_tc` requerido.
 *     Si vuelto_moneda es USD/USDT/NULL, tc puede ser NULL (redundante).
 *   · CHECK: si presente, `vuelto_tc > 0`.
 *
 * Sin backfill: acordado con Lucas (ver task chapter). Las ventas viejas con
 * vuelto quedan con `vuelto_tc = NULL` y su `ganancia_usd` con el bug pre-fix.
 * El feature vuelto es de hace ~1 semana y afecta pocas filas — mejor no tocar
 * data histórica que ya cerró.
 */

exports.up = (pgm) => {
  pgm.addColumns('ventas', {
    vuelto_tc: {
      type: 'numeric(12,4)',
      notNull: false,
    },
  });

  // CHECK: si vuelto_moneda es local (ARS/UYU), vuelto_tc es requerido.
  // Si es USD/USDT o NULL, no requerimos TC (sería redundante).
  pgm.addConstraint('ventas', 'ventas_vuelto_tc_requerido_local_check', {
    check: `vuelto_moneda IS NULL
         OR vuelto_moneda IN ('USD', 'USDT')
         OR (vuelto_moneda IN ('ARS', 'UYU') AND vuelto_tc IS NOT NULL)`,
  });

  // CHECK monto positivo si presente.
  pgm.addConstraint('ventas', 'ventas_vuelto_tc_positive_check', {
    check: `vuelto_tc IS NULL OR vuelto_tc > 0`,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('ventas', 'ventas_vuelto_tc_positive_check', { ifExists: true });
  pgm.dropConstraint('ventas', 'ventas_vuelto_tc_requerido_local_check', { ifExists: true });
  pgm.dropColumns('ventas', ['vuelto_tc']);
};
