/* eslint-disable camelcase */
// Tema C (2026-06-13) — Denormalizar comisión total de métodos de pago en `ventas`.
//
// Contexto (bug encontrado en testing interno post-P-03):
//   Cuando una venta minorista se cobra con tarjeta de crédito o transferencia,
//   el método de pago tiene un costo (la comisión que retiene la financiera o
//   la procesadora de tarjeta). Hoy ese costo:
//     · SE refleja en el dashboard de Tarjetas (tarjeta_movimientos.monto_comision)
//     · SE refleja en el módulo Financiera (comprobantes.monto_financiera)
//     · NO se descuenta de la `ganancia_usd` de la venta.
//
//   Resultado: el dashboard de Ventas muestra una ganancia bruta inflada — porque
//   la comisión del método de pago aparece como margen positivo cuando en realidad
//   es un costo. En una venta de USD $1.000 cobrada en 6 cuotas (28% recargo
//   pasado al cliente, 28% comisión retenida → coef. ~1.389), el costo financiero
//   real es ~$280 que hoy figura como ganancia.
//
// Decisión (aprobada por Lucas):
//   · Approach C2: denormalizar `comision_total_metodos` en `ventas` — no
//     recalcular sobre la marcha en cada query del dashboard. Razones:
//       (a) el cálculo cruza 2 tablas (tarjeta_movimientos + comprobantes) que
//           ya tienen su propio ciclo de sync — agregar JOINs adicionales en
//           cada query del dashboard duplica trabajo.
//       (b) la columna se computa con la MISMA tx que ya hace syncTarjetaCobros
//           + syncFinancieraComprobante en POST/PUT/DELETE de venta — sin race.
//       (c) backfill idempotente del histórico (PR C.2) deja todo consistente.
//   · Approach C1 (recalcular en cada query) descartado: el dashboard agrega por
//     mes/año, sería un SUM sobre JOINs de 3 tablas filtradas por venta.estado y
//     fecha. La denormalización mantiene una sola lectura por venta.
//
// Esta migración:
//   ADD COLUMN ventas.comision_total_metodos NUMERIC(12,2) NOT NULL DEFAULT 0
//
//   El DEFAULT 0 hace que las filas existentes queden en 0 (no rompe ningún
//   read existente). El backfill de filas históricas se hace en PR C.2 con
//   un script separado, que lee tarjeta_movimientos + comprobantes y popula
//   la columna venta por venta. Hasta que el backfill corra, el dashboard
//   muestra la ganancia bruta vieja (sin el costo financiero descontado) —
//   no es un regression, es el estado pre-fix.
//
// Invariante operativo (no enforced por DB):
//   Para cada venta activa (estado != 'cancelado'):
//     ventas.comision_total_metodos =
//         COALESCE(SUM(tarjeta_movimientos.monto_comision WHERE venta_id = v.id AND deleted_at IS NULL), 0)
//       + COALESCE(SUM(comprobantes.monto_financiera     WHERE venta_id = v.id AND deleted_at IS NULL), 0)
//
//   Se mantiene en sync vía helper `sumComisionesMetodos` invocado en POST/PUT
//   de ventas, después de syncTarjetaCobros + syncFinancieraComprobante.
//
// Convenciones:
//   · Tipo NUMERIC(12,2): mismo tipo que `total_usd` y `ganancia_usd` — coherente
//     con el resto de montos en USD del módulo ventas.
//   · NOT NULL DEFAULT 0: ninguna venta legítima tiene "comisión desconocida".
//     Si no hay pago con método con comisión, el valor correcto es 0.
//   · Sin índice: la columna no se usa como filtro ni para ORDER BY — solo
//     se agrega como SUM en el dashboard, que ya escanea las ventas del período.
//
// Down: T-05 enforcement. Drop column. Safe porque la columna es derivada de
//   otras tablas, no es fuente de verdad — la pérdida solo afecta el reporte
//   de ganancia neta, que vuelve a la versión bruta inflada.

exports.up = (pgm) => {
  pgm.addColumns('ventas', {
    comision_total_metodos: {
      type:    'numeric(12,2)',
      notNull: true,
      default: 0,
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('ventas', ['comision_total_metodos']);
};
