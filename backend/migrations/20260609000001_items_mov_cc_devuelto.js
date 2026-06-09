/**
 * Marca de devolución por item en items_movimiento_cc.
 *
 * Junio 2026, testing pre-salida — Lucas pidió poder devolver items
 * individuales desde el desglose del movimiento B2B con un botón inline.
 * El item queda visible (tachado) en el desglose original; en paralelo se
 * registra un movimiento_cc tipo='devolucion' asociado para mantener la
 * trazabilidad contable.
 *
 * Campos:
 *   · devuelto_at:        TIMESTAMPTZ NULL — fecha/hora en que se devolvió.
 *                         NULL = item no devuelto. El frontend usa el NULL
 *                         para decidir si mostrar el botón ↺ o el tachado.
 *   · devolucion_mov_id:  INT NULL — FK al movimientos_cc.id del mov de
 *                         devolución que se creó. Permite cross-referenciar
 *                         para auditoría sin parsear texto.
 *   · devolucion_user_id: INT NULL — quién hizo la devolución (audit).
 *
 * Decisión: NO un campo `cantidad_devuelta` para soportar parciales. En B2B
 * los items son típicamente unitarios (cantidad=1 — celulares con IMEI), y
 * los accesorios en lote rara vez se devuelven parcialmente. Si en el
 * futuro surge el caso, agregamos `cantidad_devuelta` y se hace bool/int.
 *
 * Sin índice por ahora — la lectura es siempre por movimiento_cc_id que
 * ya tiene su índice; devuelto_at se filtra en memoria del payload chico.
 */
exports.up = (pgm) => {
  pgm.addColumns('items_movimiento_cc', {
    devuelto_at:        { type: 'timestamptz' },
    devolucion_mov_id:  { type: 'integer', references: 'movimientos_cc(id)', onDelete: 'SET NULL' },
    devolucion_user_id: { type: 'integer', references: 'users(id)',          onDelete: 'SET NULL' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('items_movimiento_cc', ['devuelto_at', 'devolucion_mov_id', 'devolucion_user_id']);
};
