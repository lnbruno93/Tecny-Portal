// Comisiones de Métodos de Pago — costo financiero de la venta.
//
// Tema C (2026-06-13): cuando una venta minorista se cobra con tarjeta de
// crédito o transferencia, el método de pago tiene un costo (comisión retenida
// por la procesadora / financiera). Ese costo ya impacta en sus dashboards
// específicos (Tarjetas, Transferencias), pero faltaba descontarlo de la
// `ganancia_usd` de la venta — por eso la ganancia bruta del módulo Ventas
// estaba inflada en el monto exacto de la comisión.
//
// Solución (approach C2 aprobado por Lucas):
//   · Denormalizamos `ventas.comision_total_metodos NUMERIC(12,2)` (migración
//     20260613000002_ventas_comision_total_metodos.js).
//   · Este helper computa el valor y lo persiste. Se invoca desde routes/ventas.js
//     POST + PUT + DELETE, SIEMPRE después de syncTarjetaCobros + syncFinancieraComprobante
//     (porque lee de las tablas que esas funciones escriben).
//   · El backfill histórico es PR C.2 — usa este mismo helper venta-por-venta.
//
// Invariante (no enforced por DB):
//   Para cada venta activa (estado != 'cancelado'):
//     ventas.comision_total_metodos =
//         Σ tarjeta_movimientos.monto_comision activos de tipo 'cobro' [USD-equiv]
//       + comprobantes.monto_financiera activo (uno por venta) [USD-equiv]
//
// Por qué se lee de tarjeta_movimientos y comprobantes en vez de re-calcular:
//   Los pct de tarjeta (metodos_pago.comision_pct) y de financiera (config.pct_financiera)
//   PUEDEN cambiar con el tiempo. Si re-calculáramos `comision_pct × monto_usd / 100`
//   a partir del valor ACTUAL del pct, ventas viejas quedarían con un costo
//   financiero distinto al que efectivamente fue retenido. Las tablas tm.monto_comision
//   y c.monto_financiera guardan el valor congelado al momento del sync — esa
//   es la fuente de verdad histórica.
//
// Conversión a USD:
//   `tarjeta_movimientos.monto_comision` y `comprobantes.monto_financiera` están
//   en la moneda del pago (ARS típicamente). `ventas.total_usd` y `ganancia_usd`
//   están en USD. Para que `comision_total_metodos` se pueda sumar/restar al
//   resto, lo expresamos en USD usando el ratio `monto_usd / monto` del venta_pago
//   correspondiente. Ese ratio es exactamente 1/tc (para ARS) o 1 (para USD/USDT).
//
// Matching:
//   · tarjeta_movimientos ↔ venta_pago: por (venta_id, metodo_pago_id, monto_bruto = monto).
//     syncTarjetaCobros crea un tm por cada vp con es_tarjeta — el match es 1:1
//     por construcción. Si por bug del sync hubiera duplicados o huérfanos, el
//     JOIN inner los filtra silenciosamente — el código del sync debería garantizar
//     no haya tales casos.
//   · comprobantes ↔ venta_pago: syncFinancieraComprobante usa LIMIT 1 sobre vp
//     con es_financiera = true — preservamos ese mismo orden (ORDER BY vp.id LIMIT 1).

const { round2 } = require('./money');

/**
 * Suma en USD de las comisiones retenidas por los métodos de pago de la venta.
 * Lee de tarjeta_movimientos + comprobantes (no re-calcula de pct actual).
 * @param {import('pg').PoolClient} client
 * @param {number} ventaId
 * @returns {Promise<number>} total en USD, redondeado a 2 decimales
 */
async function sumComisionesMetodosUsd(client, ventaId) {
  const { rows } = await client.query(
    `WITH
       tarjeta AS (
         SELECT COALESCE(SUM(
           CASE WHEN vp.monto > 0
                THEN tm.monto_comision * (vp.monto_usd / vp.monto)
                ELSE 0 END
         ), 0) AS total
         FROM tarjeta_movimientos tm
         JOIN venta_pagos vp
           ON vp.venta_id       = tm.venta_id
          AND vp.metodo_pago_id = tm.metodo_pago_id
          AND vp.monto          = tm.monto_bruto
          AND vp.es_cuenta_corriente = false
         WHERE tm.venta_id = $1
           AND tm.tipo = 'cobro'
           AND tm.deleted_at IS NULL
       ),
       financiera AS (
         SELECT COALESCE((
           SELECT c.monto_financiera * (vp.monto_usd / NULLIF(vp.monto, 0))
             FROM comprobantes c
             JOIN venta_pagos vp ON vp.venta_id = c.venta_id
             JOIN metodos_pago mp
               ON mp.id = vp.metodo_pago_id
              AND mp.es_financiera = true
            WHERE c.venta_id = $1 AND c.deleted_at IS NULL
            ORDER BY vp.id
            LIMIT 1
         ), 0) AS total
       )
     SELECT ((SELECT total FROM tarjeta) + (SELECT total FROM financiera))::numeric AS total`,
    [ventaId]
  );
  return round2(Number(rows[0]?.total || 0));
}

/**
 * Calcula y persiste `ventas.comision_total_metodos` para la venta indicada.
 * Idempotente: corre N veces, deja el mismo valor.
 *
 * Debe correr DENTRO de la misma transacción que llamó a syncTarjetaCobros y
 * syncFinancieraComprobante, y DESPUÉS de ellos — para que las tablas fuente
 * estén en el estado final antes de leer.
 *
 * @param {import('pg').PoolClient} client
 * @param {number} ventaId
 * @returns {Promise<number>} el valor escrito en la columna (USD, 2 decimales)
 */
async function syncComisionTotalMetodos(client, ventaId) {
  const total = await sumComisionesMetodosUsd(client, ventaId);
  await client.query(
    `UPDATE ventas SET comision_total_metodos = $2 WHERE id = $1`,
    [ventaId, total]
  );
  return total;
}

module.exports = { sumComisionesMetodosUsd, syncComisionTotalMetodos };
