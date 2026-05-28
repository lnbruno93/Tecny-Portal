// Helpers de sincronización post-venta extraídos de routes/ventas.js para poder
// reusarlos desde el flujo "envío → venta auto" (lib/ventaDesdeEnvio.js).
//
// La venta es la "fuente de verdad" de los efectos secundarios financieros:
//   · syncVentaCaja          → ingresos de caja por pagos no-CC y no-financiera/tarjeta
//   · sincronizarCuentaCorriente → deuda en movimientos_cc para pagos CC
//   · (los comprobantes de Financiera y los cobros de Tarjeta viven en sus
//      propios módulos: lib/financiera.js y lib/tarjetas.js)

const { postCajaMovimiento, reverseCajaMovimientos } = require('./cajaLedger');
const { round2 } = require('./money');
const { retieneStock } = require('./ventaCore');

// Sincroniza los ingresos de caja de una venta. Idempotente: revierte previos
// y re-postea según el estado actual. Saltea pagos CC, financiera y tarjeta.
async function syncVentaCaja(client, venta, userId) {
  await reverseCajaMovimientos(client, 'ventas', venta.id);
  if (!retieneStock(venta.estado)) return;
  const { rows: pagos } = await client.query(
    `SELECT vp.metodo_pago_id, vp.monto, vp.moneda, vp.tc, mp.es_financiera, mp.es_tarjeta
       FROM venta_pagos vp JOIN metodos_pago mp ON mp.id = vp.metodo_pago_id
      WHERE vp.venta_id = $1 AND vp.es_cuenta_corriente = false AND vp.metodo_pago_id IS NOT NULL`, [venta.id]
  );
  for (const p of pagos) {
    if (p.es_financiera || p.es_tarjeta) continue;
    await postCajaMovimiento(client, {
      caja_id: p.metodo_pago_id, fecha: venta.fecha, tipo: 'ingreso',
      monto: p.monto, moneda: p.moneda, tc: p.tc,
      origen: 'venta', ref_tabla: 'ventas', ref_id: venta.id,
      concepto: `Venta ${venta.order_id}`, user_id: userId,
    });
  }
}

// Sincroniza la deuda CC generada por la venta. Idempotente. Sólo crea
// movimiento si hay cliente_cc_id, la venta retiene stock y hay pagos CC > 0.
async function sincronizarCuentaCorriente(client, venta) {
  await client.query('UPDATE movimientos_cc SET deleted_at = NOW() WHERE venta_id = $1 AND deleted_at IS NULL', [venta.id]);
  if (!retieneStock(venta.estado) || !venta.cliente_cc_id) return;
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(monto_usd), 0) AS total FROM venta_pagos WHERE venta_id = $1 AND es_cuenta_corriente = true', [venta.id]
  );
  const total = round2(Number(rows[0].total));
  if (total <= 0) return;
  await client.query(
    `INSERT INTO movimientos_cc (cliente_cc_id, fecha, tipo, descripcion, monto_total, venta_id)
     VALUES ($1, $2, 'compra', $3, $4, $5)`,
    [venta.cliente_cc_id, venta.fecha, `Venta ${venta.order_id}`, total, venta.id]
  );
}

module.exports = { syncVentaCaja, sincronizarCuentaCorriente };
