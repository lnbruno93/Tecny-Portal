/* eslint-disable camelcase */
// Auditoría 2026-06-30 D-01 — Snapshot lazy de % de comisión por fila.
//
// Bug P0 detectado por auditoría: cambiar config.pct_financiera o
// metodos_pago.comision_pct afectaba retroactivamente KPIs históricos porque
// los syncs (syncFinancieraComprobante / syncTarjetaCobros) leían el % ACTUAL
// cada vez que se invocaban — y se invocan en CUALQUIER edición de venta
// (cambiar nota, estado, comprobante, etc.).
//
// Diseño (Opción B — snapshot lazy):
//   · Cada fila persiste el % al momento de la operación. Mientras `pct_aplicado`
//     (o `comision_pct_snapshot`) sea NOT NULL, los syncs lo usan como fuente de
//     verdad — no consultan más config / metodos_pago para recalcular monto.
//   · Filas históricas pre-fix tienen NULL. Las "sellamos" lazy en el primer
//     toque: derivamos el % del monto ya congelado (pct = monto_financiera/monto
//     × 100). El script seal-historical-comisiones.js puede precorrerlo en bloque
//     antes del deploy.
//   · El sealing matemático es la única forma de no reescribir KPIs en el primer
//     toque post-deploy: la fila preserva su monto histórico aún cuando el % de
//     config haya cambiado entre la venta original y el primer touch.
//
// Tipo NUMERIC(6,3): mismo tipo que metodos_pago.comision_pct (NUMERIC(6,3)).
// Es 0-100 con hasta 3 decimales (ej. 28.500). config.pct_financiera es
// NUMERIC(5,2) pero acá usamos 6,3 para tener margen en el sealing matemático
// (la división puede devolver un decimal con más precisión que el % original).
//
// Sin DEFAULT y nullable: las filas pre-existentes quedan en NULL (señal de
// "puede sellarse lazy"). El sync detecta NULL y rellena.
//
// Sin índice: no se filtra por estas columnas, solo se leen junto con la fila.

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Auditoría 2026-06-30 D-01: snapshot del % de retención financiera al
  // momento de la venta. NULL para filas pre-fix (puede sealing lazy desde
  // syncFinancieraComprobante o el script seal-historical-comisiones.js).
  pgm.addColumn('comprobantes', {
    pct_aplicado: {
      type: 'numeric(6,3)',
      notNull: false,
      comment: 'Auditoria 2026-06-30 D-01: % snapshot al momento de la venta. NULL = pre-snapshot (sealing lazy).',
    },
  });

  // Auditoría 2026-06-30 D-01: snapshot del % del metodo_pago al INSERT del
  // venta_pagos. NULL para filas pre-fix; syncTarjetaCobros lo sella lazy
  // derivándolo del mov_old.monto_comision / mov_old.monto.
  pgm.addColumn('venta_pagos', {
    comision_pct_snapshot: {
      type: 'numeric(6,3)',
      notNull: false,
      comment: 'Auditoria 2026-06-30 D-01: % del metodo_pago al INSERT. NULL = pre-snapshot (sealing lazy).',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('comprobantes', 'pct_aplicado');
  pgm.dropColumn('venta_pagos', 'comision_pct_snapshot');
};
