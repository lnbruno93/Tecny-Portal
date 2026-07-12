/**
 * Agregar `tarjeta_movimientos.venta_pago_id` FK a `venta_pagos.id`.
 *
 * 2026-07-12 (auditoría TOTAL Financiero P1-5):
 *
 * Contexto: hoy `syncComisionTotalMetodos` (lib/comisionesMetodos.js:60-73)
 * matchea `tarjeta_movimientos` con `venta_pagos` por triple JOIN:
 *
 *   ON vp.venta_id       = tm.venta_id
 *  AND vp.metodo_pago_id = tm.metodo_pago_id
 *  AND vp.monto          = tm.monto_bruto
 *
 * Si una venta tiene 2 pagos con MISMO método + MISMO monto (edge case: 2
 * pagos de $500 con la misma Visa por fail del POS al cobrar $1000), el
 * JOIN produce el producto cartesiano 2×2 = 4 rows y suma comisión × 2 →
 * `ventas.comision_total_metodos` overcount por 2×.
 *
 * Fix: link explícito por FK. `syncTarjetaCobros` (lib/tarjetas.js:178) ya
 * conoce el `venta_pagos.id` cuando inserta el cobro — persistir esa
 * relación en columna nueva y usar `tm.venta_pago_id = vp.id` en el JOIN.
 *
 * Estrategia:
 *   1. Migration agrega columna nullable (safe deploy, sin bloquear traffic).
 *   2. Backfill sobre filas históricas: matchear con el triple JOIN actual
 *      (que ya es lo que hace el código legacy) y persistir. Los edge case
 *      de duplicados no matchean unequívocamente → quedan NULL y el JOIN
 *      nuevo los ignora (mejor que overcount).
 *   3. Backend (PR siguiente en el mismo commit):
 *      - syncTarjetaCobros INSERT incluye venta_pago_id
 *      - sumComisionesMetodosUsd usa el JOIN por FK
 *
 * Nota: NO agregamos NOT NULL constraint por ahora. Filas históricas
 * ambiguas quedan NULL — si en el futuro querés forzar el link, primero
 * migrar las NULLs manualmente y luego ALTER TABLE.
 *
 * FK con `ON DELETE SET NULL` — si un venta_pago se borra (raro pero
 * posible via edit), el link queda NULL en vez de romper CASCADE.
 */

exports.up = (pgm) => {
  // 1. Agregar columna nullable.
  pgm.addColumns('tarjeta_movimientos', {
    venta_pago_id: {
      type: 'integer',
      notNull: false,
      references: 'venta_pagos(id)',
      onDelete: 'SET NULL',
    },
  });

  // 2. Backfill: matchear con el triple JOIN legacy.
  //    Filas con match único → populate. Filas con match ambiguo (2+ pagos
  //    con mismo método+monto en la venta) → quedan NULL.
  //
  //    Estrategia SQL: subquery con LIMIT 1 en la coincidencia. Elegimos
  //    el venta_pagos.id más chico (ORDER BY id ASC) para determinismo.
  //    Filas duplicadas históricas quedan mapeadas al mismo vp_id — no
  //    ideal pero preserva el comportamiento actual (el JOIN triple viejo
  //    también matchaba múltiples veces).
  //
  //    Filtro: solo cobros (tipo='cobro' + venta_id NOT NULL). Las
  //    liquidaciones (tipo='liquidacion') no matchean con venta_pagos.
  pgm.sql(`
    UPDATE tarjeta_movimientos tm
       SET venta_pago_id = (
         SELECT vp.id
           FROM venta_pagos vp
          WHERE vp.venta_id       = tm.venta_id
            AND vp.metodo_pago_id = tm.metodo_pago_id
            AND vp.monto          = tm.monto_bruto
          ORDER BY vp.id ASC
          LIMIT 1
       )
     WHERE tm.tipo = 'cobro'
       AND tm.venta_id IS NOT NULL
       AND tm.venta_pago_id IS NULL;
  `);

  // 3. Índice sobre la nueva columna para acelerar el JOIN en
  //    sumComisionesMetodosUsd (dashboard mensual + POST/PUT ventas).
  pgm.createIndex('tarjeta_movimientos', 'venta_pago_id', {
    name: 'idx_tarjeta_mov_venta_pago',
    where: 'venta_pago_id IS NOT NULL AND deleted_at IS NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('tarjeta_movimientos', 'venta_pago_id', {
    name: 'idx_tarjeta_mov_venta_pago',
    ifExists: true,
  });
  pgm.dropColumns('tarjeta_movimientos', ['venta_pago_id']);
};
