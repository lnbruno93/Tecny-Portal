// Cobros de Tarjeta generados automáticamente desde una venta.
//
// Cuando una venta se cobra con un método marcado como tarjeta
// (metodos_pago.es_tarjeta), se registra un 'cobro' en el módulo Tarjetas con la
// comisión del plan asociado al método. El neto queda pendiente de liquidación
// (no entra a ninguna caja hasta que el procesador deposita → 'liquidacion').
//
// syncTarjetaCobros reconcilia de forma idempotente: borra los cobros previos de
// la venta y los recrea desde los pagos actuales. Debe correr dentro de la tx.
const { round2 } = require('./money');

async function syncTarjetaCobros(client, ventaId, estado) {
  // Revertir cobros previos de esta venta
  await client.query(
    `UPDATE tarjeta_movimientos SET deleted_at = NOW()
      WHERE venta_id = $1 AND tipo = 'cobro' AND deleted_at IS NULL`, [ventaId]
  );
  if (estado === 'cancelado') return;

  const { rows: pagos } = await client.query(
    `SELECT vp.monto, vp.moneda, mp.tarjeta_entidad_id, mp.tarjeta_plan_id, tp.pct AS plan_pct
       FROM venta_pagos vp
       JOIN metodos_pago mp ON mp.id = vp.metodo_pago_id
       LEFT JOIN tarjeta_planes tp ON tp.id = mp.tarjeta_plan_id AND tp.deleted_at IS NULL
      WHERE vp.venta_id = $1 AND vp.es_cuenta_corriente = false
        AND mp.es_tarjeta = true AND mp.tarjeta_entidad_id IS NOT NULL`, [ventaId]
  );
  if (pagos.length === 0) return;

  const { rows: v } = await client.query('SELECT fecha FROM ventas WHERE id = $1', [ventaId]);
  const fecha = v[0]?.fecha;

  for (const p of pagos) {
    const pct = Number(p.plan_pct || 0);
    const bruto = round2(Number(p.monto));
    const comision = round2(bruto * pct / 100);
    const neto = round2(bruto - comision);
    await client.query(
      `INSERT INTO tarjeta_movimientos
         (entidad_id, plan_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, venta_id)
       VALUES ($1,$2,$3,'cobro',$4,$5,$6,$7,$8,$9)`,
      [p.tarjeta_entidad_id, p.tarjeta_plan_id ?? null, fecha, p.moneda, bruto, pct, comision, neto, ventaId]
    );
  }
}

module.exports = { syncTarjetaCobros };
