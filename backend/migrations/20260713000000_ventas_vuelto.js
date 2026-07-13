/**
 * Agregar campos de "vuelto" (cambio dado al cliente) a `ventas`.
 *
 * 2026-07-13 (feature): antes el vuelto no tenía representación explícita —
 * el operador o bien cargaba un ítem "Diferencia de cambio" con valor
 * negativo (workaround feo), o simplemente no registraba el egreso y la
 * caja quedaba "misteriosamente" con menos plata que el ticket.
 *
 * Feature: al crear/editar una venta, el operador puede indicar cuánto
 * dinero entregó como vuelto al cliente y de qué caja sale. El backend
 * postea automáticamente un `caja_movimientos` tipo='egreso' apuntando a
 * esa caja con `ref_tabla='ventas'` + `ref_id=venta.id`. Al cancelar la
 * venta, `reverseCajaMovimientos` revierte AUTOMÁTICAMENTE el egreso
 * (sin código nuevo) porque ya barre todo lo apuntado por ref.
 *
 * Diseño:
 *   · Los 3 campos son nullable (ventas sin vuelto = todo NULL).
 *   · `vuelto_caja_id` es FK a `metodos_pago` (donde viven las cajas) con
 *     ON DELETE SET NULL — si la caja se elimina, el link se pierde pero
 *     el histórico de la venta sobrevive.
 *   · CHECK: si `vuelto_monto` NOT NULL debe ser > 0, y los otros 2 NOT NULL
 *     también (todo o nada). Si es NULL, los 3 NULL. Evita estados raros.
 *   · CHECK moneda: enum ARS/UYU/USD/USDT (mismo set que resto del sistema).
 *
 * Decisiones acordadas 2026-07-13 (Lucas):
 *   · La caja del vuelto es LIBRE (cualquier moneda, no tiene que
 *     coincidir con las cajas de los pagos de la venta).
 *   · No validamos que `vuelto <= (total_pagado - total_venta)` — el
 *     operador puede registrar vuelto por redondeo, cortesía, etc.
 *
 * Sin backfill: todas las ventas existentes tienen `vuelto_monto = NULL`
 * (no había vuelto registrado antes).
 */

exports.up = (pgm) => {
  pgm.addColumns('ventas', {
    vuelto_monto: {
      type: 'numeric(12,2)',
      notNull: false,
    },
    vuelto_moneda: {
      type: 'text',
      notNull: false,
    },
    vuelto_caja_id: {
      type: 'integer',
      notNull: false,
      references: 'metodos_pago(id)',
      onDelete: 'SET NULL',
    },
  });

  // CHECK "todo o nada": los 3 campos van juntos. Evita estados raros
  // como (monto=10, moneda=NULL, caja=NULL) que no tienen sentido operativo.
  pgm.addConstraint('ventas', 'ventas_vuelto_completo_check', {
    check: `(vuelto_monto IS NULL AND vuelto_moneda IS NULL AND vuelto_caja_id IS NULL)
         OR (vuelto_monto IS NOT NULL AND vuelto_moneda IS NOT NULL AND vuelto_caja_id IS NOT NULL)`,
  });

  // CHECK monto > 0 (si presente): un vuelto de 0 no tiene sentido — que
  // no exista es la forma canónica de "no hay vuelto".
  pgm.addConstraint('ventas', 'ventas_vuelto_monto_positive_check', {
    check: `vuelto_monto IS NULL OR vuelto_monto > 0`,
  });

  // CHECK moneda enum: mismo set que resto del sistema (canjes.moneda,
  // venta_pagos.moneda, caja_movimientos.moneda).
  pgm.addConstraint('ventas', 'ventas_vuelto_moneda_check', {
    check: `vuelto_moneda IS NULL OR vuelto_moneda IN ('ARS','UYU','USD','USDT')`,
  });

  // Partial index para queries analíticas futuras (ej: "top cajas con más
  // vuelto pagado en el mes"). Solo indexa ventas CON vuelto — la mayoría
  // (~90%+ estimado) no van a tenerlo, no vale la pena indexar NULLs.
  pgm.createIndex('ventas', 'vuelto_caja_id', {
    name: 'idx_ventas_vuelto_caja',
    where: 'vuelto_caja_id IS NOT NULL AND deleted_at IS NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('ventas', 'vuelto_caja_id', {
    name: 'idx_ventas_vuelto_caja',
    ifExists: true,
  });
  pgm.dropConstraint('ventas', 'ventas_vuelto_moneda_check', { ifExists: true });
  pgm.dropConstraint('ventas', 'ventas_vuelto_monto_positive_check', { ifExists: true });
  pgm.dropConstraint('ventas', 'ventas_vuelto_completo_check', { ifExists: true });
  pgm.dropColumns('ventas', ['vuelto_monto', 'vuelto_moneda', 'vuelto_caja_id']);
};
