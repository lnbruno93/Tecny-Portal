// Cobros de Tarjeta generados automáticamente desde una venta.
//
// Cuando una venta se cobra con un método marcado como tarjeta
// (metodos_pago.es_tarjeta), se registra un 'cobro' en el módulo Tarjetas con la
// comisión del propio método (metodos_pago.comision_pct). El neto queda pendiente
// de liquidación (no entra a ninguna caja hasta que el procesador deposita).
//
// syncTarjetaCobros reconcilia de forma idempotente: borra los cobros previos de
// la venta y los recrea desde los pagos actuales. Debe correr dentro de la tx.
const { round2 } = require('./money');

function err400(msg) { return Object.assign(new Error(msg), { status: 400 }); }

// Pre-check: revertir un cobro de tarjeta es seguro mientras el saldo
// resultante de la tarjeta (SUM cobros activos − SUM liquidaciones) siga ≥ 0.
// Si quedaría negativo, significa que la liquidación ya recibió plata por
// este cobro y bloqueamos la cancelación pidiendo deshacer la liquidación.
//
// Hacemos el cálculo por (metodo_pago_id) — una venta puede tener cobros en
// varias tarjetas; bloqueamos si CUALQUIERA quedaría en rojo.
async function checkLiquidacionesBloqueantes(client, ventaId) {
  const { rows } = await client.query(
    `WITH cobros_revertir AS (
       SELECT metodo_pago_id, COALESCE(SUM(monto_bruto), 0) AS monto_revertir
         FROM tarjeta_movimientos
        WHERE venta_id = $1 AND tipo = 'cobro' AND deleted_at IS NULL
        GROUP BY metodo_pago_id
     ),
     saldos AS (
       SELECT cr.metodo_pago_id, cr.monto_revertir,
              COALESCE(SUM(CASE WHEN tm.tipo='cobro'        THEN tm.monto_bruto ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN tm.tipo='liquidacion' THEN tm.monto_neto  ELSE 0 END), 0) AS saldo_actual
         FROM cobros_revertir cr
         LEFT JOIN tarjeta_movimientos tm
           ON tm.metodo_pago_id = cr.metodo_pago_id
          AND tm.deleted_at IS NULL
        GROUP BY cr.metodo_pago_id, cr.monto_revertir
     )
     SELECT s.metodo_pago_id, s.monto_revertir, s.saldo_actual, mp.nombre AS metodo_nombre
       FROM saldos s
       JOIN metodos_pago mp ON mp.id = s.metodo_pago_id
      WHERE s.saldo_actual - s.monto_revertir < 0
      LIMIT 1`, [ventaId]
  );
  if (rows[0]) {
    throw err400(
      `No se puede revertir esta venta: el cobro de tarjeta "${rows[0].metodo_nombre}" ` +
      `ya fue liquidado (saldo pendiente: $${Number(rows[0].saldo_actual).toFixed(2)}, ` +
      `monto a revertir: $${Number(rows[0].monto_revertir).toFixed(2)}). ` +
      `Eliminá primero la liquidación correspondiente.`
    );
  }
}

async function syncTarjetaCobros(client, ventaId, estado) {
  // Si vamos a borrar/cancelar, validamos primero que no haya liquidaciones
  // posteriores que dependan de estos cobros. Si las hay, lanzamos err400 y
  // el caller hace ROLLBACK de la transacción entera (no se cancela nada).
  if (estado === 'cancelado') {
    await checkLiquidacionesBloqueantes(client, ventaId);
  }
  // Revertir cobros previos de esta venta
  await client.query(
    `UPDATE tarjeta_movimientos SET deleted_at = NOW()
      WHERE venta_id = $1 AND tipo = 'cobro' AND deleted_at IS NULL`, [ventaId]
  );
  if (estado === 'cancelado') return;

  const { rows: pagos } = await client.query(
    `SELECT vp.monto, vp.moneda, vp.metodo_pago_id, COALESCE(mp.comision_pct, 0) AS comision_pct
       FROM venta_pagos vp
       JOIN metodos_pago mp ON mp.id = vp.metodo_pago_id
      WHERE vp.venta_id = $1 AND vp.es_cuenta_corriente = false AND mp.es_tarjeta = true`, [ventaId]
  );
  if (pagos.length === 0) return;

  const { rows: v } = await client.query('SELECT fecha FROM ventas WHERE id = $1', [ventaId]);
  const fecha = v[0]?.fecha;

  for (const p of pagos) {
    const pct = Number(p.comision_pct || 0);
    const bruto = round2(Number(p.monto));
    const comision = round2(bruto * pct / 100);
    const neto = round2(bruto - comision);
    await client.query(
      `INSERT INTO tarjeta_movimientos
         (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, venta_id)
       VALUES ($1,$2,'cobro',$3,$4,$5,$6,$7,$8)`,
      [p.metodo_pago_id, fecha, p.moneda, bruto, pct, comision, neto, ventaId]
    );
  }
}

module.exports = { syncTarjetaCobros };
