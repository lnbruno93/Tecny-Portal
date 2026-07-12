/**
 * Agregar `canjes.deleted_at` para soft-delete.
 *
 * 2026-07-12 (auditoría TOTAL Stock P1-1):
 *
 * Contexto: hoy `canjes` es hard-delete (routes/ventas.js:1411 hace
 * `DELETE FROM canjes WHERE venta_id = $1` al editar venta) y no hay
 * revert en cancel de venta (revertirEfectosVenta NO toca canjes). Esto
 * rompe trazabilidad histórica y deja productos huérfanos en stock:
 *
 *   1. Operador crea venta con canje que agrega_stock=true → se crea un
 *      `productos` nuevo (el equipo usado ingresado).
 *   2. Operador edita la venta y remueve el canje.
 *   3. El canje se elimina con DELETE hardcoded; el producto sobrevive
 *      "huérfano" en el catálogo — está en stock, pero no hay canje que
 *      justifique su origen.
 *   4. Si el operador después cancela la venta con DELETE, tampoco pasa
 *      nada con el canje (ya no existe). El producto sigue en stock.
 *
 * Fix: soft-delete de canjes (deleted_at) + coordinación con producto
 * linkeado (producto_id). Política acordada (Lucas 2026-07-12):
 *
 *   · producto DISPONIBLE → se soft-deletea el producto junto al canje.
 *   · producto YA VENDIDO en otra venta → se rechaza la eliminación del
 *     canje (409 con mensaje claro).
 *   · producto NULL → soft-delete del canje sin más side-effects.
 *
 * Estrategia:
 *   1. Migration nullable + partial index (safe deploy sin bloquear).
 *   2. Backfill trivial: canjes existentes tienen deleted_at=NULL
 *      (todos activos). No hay data histórica que ajustar.
 *   3. Backend (mismo commit):
 *      - DELETE /ventas: revertirEfectosVenta suma bloque canjes con
 *        política 3-cases arriba.
 *      - PUT /ventas: reemplazar hard-delete por diff (soft-delete los
 *        que se van, INSERT los nuevos).
 *      - SELECTs de canjes agregan AND deleted_at IS NULL.
 */

exports.up = (pgm) => {
  pgm.addColumns('canjes', {
    deleted_at: {
      type: 'timestamptz',
      notNull: false,
    },
  });

  // Partial index para filtrar activos rápido en JOINs (routes/ventas.js
  // hace SELECT * FROM canjes WHERE venta_id = $1 AND deleted_at IS NULL
  // en varios puntos). Sin el partial, PG usa scan sobre venta_id + filter,
  // que en tablas de 100k+ canjes se degrada.
  pgm.createIndex('canjes', 'venta_id', {
    name: 'idx_canjes_venta_id_activos',
    where: 'deleted_at IS NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('canjes', 'venta_id', {
    name: 'idx_canjes_venta_id_activos',
    ifExists: true,
  });
  pgm.dropColumns('canjes', ['deleted_at']);
};
