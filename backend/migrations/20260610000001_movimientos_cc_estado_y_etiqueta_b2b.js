/**
 * 2 cambios para que las ventas B2B se sientan parte del flujo retail:
 *
 *  1. `movimientos_cc.estado` — Acreditada / Pendiente
 *     Hasta hoy el listado unificado de Ventas hardcodeaba 'pendiente' para
 *     toda venta B2B (movimientos_cc tipo='compra'). Lucas pidió que las
 *     B2B nazcan como "Acreditada" (registradas/confirmadas, independiente
 *     del cobro) y que el operador pueda alternar entre los 2 estados desde
 *     la grilla, igual que las ventas retail.
 *
 *     · CHECK ('acreditado' | 'pendiente'). Default 'acreditado' para que
 *       cualquier mov nuevo (incluso pagos / devoluciones que no muestran
 *       el campo) tenga un valor válido.
 *     · NOT NULL — el dato es obligatorio en la app. Los movs existentes
 *       quedan en 'acreditado' por el DEFAULT al hacer el ALTER.
 *     · Sin índice — la lectura siempre se hace por cliente/fecha; el
 *       estado se filtra en memoria del payload chico.
 *
 *  2. Seed de la etiqueta 'B2B'
 *     La grilla unificada ya muestra el badge "B2B" en las filas de venta
 *     B2B (mapeado virtual desde el backend). Lucas pidió que la etiqueta
 *     exista como cualquier otra en Ventas → Etiquetas, así también puede
 *     marcar una venta retail con esa etiqueta si quiere (ej. cliente B2B
 *     que paga en el momento sin cuenta corriente).
 *
 *     Idempotente: ON CONFLICT contra el UNIQUE INDEX por LOWER(nombre).
 *     Color #6b7cff (mismo azul-violeta que usa el badge virtual hardcoded
 *     en routes/ventas.js para consistencia visual).
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE movimientos_cc
      ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'acreditado'
        CHECK (estado IN ('acreditado', 'pendiente'));
  `);
  pgm.sql(`
    INSERT INTO etiquetas (nombre, color)
    SELECT 'B2B', '#6b7cff'
    WHERE NOT EXISTS (
      SELECT 1 FROM etiquetas
       WHERE LOWER(nombre) = LOWER('B2B') AND deleted_at IS NULL
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE movimientos_cc DROP COLUMN IF EXISTS estado;`);
  // No revertimos el seed de la etiqueta — si el operador la usó en alguna
  // venta retail, borrarla cascade'aría a venta_id. Dejamos la fila viva.
};
