/**
 * Agregar costo unitario congelado a items_movimiento_cc (ventas B2B).
 *
 * Junio 2026 — testing pre-salida: los operadores piden ver el desglose de
 * cada venta B2B con costo y precio mayorista por unidad para tener
 * visibilidad de la ganancia real por venta. Antes el item guardaba sólo
 * `valor` (subtotal cobrado al cliente) sin info de cuánto le costó al negocio.
 *
 * Reglas:
 *   · NULLABLE: las ventas históricas (pre-migración) no tienen el dato.
 *     El frontend muestra "—" para esas y pinta un asterisco "histórico".
 *   · Al CREAR una venta B2B nueva, el backend toma `productos.costo` del
 *     momento (snapshot congelado, no se actualiza si después editás el
 *     costo del producto — eso sería contabilidad incorrecta).
 *   · `costo_moneda` por simetría con `productos.costo_moneda` (USD o ARS).
 *     El frontend convierte a USD para el cálculo de ganancia, usando el
 *     TC del movimiento si está disponible.
 */
exports.up = (pgm) => {
  pgm.addColumns('items_movimiento_cc', {
    costo_unit:   { type: 'numeric(12,2)' },
    costo_moneda: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('items_movimiento_cc', ['costo_unit', 'costo_moneda']);
};
