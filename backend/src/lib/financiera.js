// Comprobante de Financiera generado automáticamente a partir de una venta.
//
// Invariante (única fuente de verdad): el comprobante de Financiera de una venta
// existe (deleted_at IS NULL) sí y solo sí:
//   (a) la venta está activa (estado !== 'cancelado'),
//   (b) tiene un pago con la caja financiera (metodos_pago.es_financiera), y
//   (c) tiene al menos un archivo de comprobante adjunto (venta_comprobantes).
//
// `syncFinancieraComprobante` reconcilia ese estado de forma idempotente: crea la
// fila si corresponde y no existe, la restaura + recalcula la comisión si existe,
// o la revierte (soft-delete) si ya no corresponde. Debe correr dentro de la tx.
// Devuelve la fila activa del comprobante, o null si no corresponde.
const { round2 } = require('./money');

async function syncFinancieraComprobante(client, ventaId, estado) {
  let pagoFin = null;
  let file = null;
  if (estado !== 'cancelado') {
    const fin = await client.query(
      `SELECT vp.monto FROM venta_pagos vp
         JOIN metodos_pago mp ON mp.id = vp.metodo_pago_id
        WHERE vp.venta_id = $1 AND mp.es_financiera = true AND mp.deleted_at IS NULL
        LIMIT 1`, [ventaId]
    );
    const f = await client.query(
      `SELECT archivo_data, archivo_nombre, archivo_tipo
         FROM venta_comprobantes
        WHERE venta_id = $1 AND deleted_at IS NULL
        ORDER BY id LIMIT 1`, [ventaId]
    );
    if (fin.rows[0] && f.rows[0]) { pagoFin = fin.rows[0]; file = f.rows[0]; }
  }

  // No corresponde → revertir el comprobante si existe.
  if (!pagoFin) {
    await client.query('UPDATE comprobantes SET deleted_at = NOW() WHERE venta_id = $1 AND deleted_at IS NULL', [ventaId]);
    return null;
  }

  // Comisión con el monto y % actuales.
  const monto = Number(pagoFin.monto);
  const { rows: cfg } = await client.query('SELECT pct_financiera FROM config LIMIT 1');
  const pct = Number(cfg[0]?.pct_financiera || 0);
  const monto_financiera = round2(monto * pct / 100);
  const monto_neto = round2(monto - monto_financiera);

  // Si ya hay una fila (activa o revertida), restaurarla + recalcular. Si no, crearla.
  //
  // IMPORTANTE: el UPDATE incluye archivo_data/nombre/tipo, no solo los montos.
  // Antes de mayo-2026 estos no se refrescaban: si la venta era cancelada (con su
  // comprobante soft-deleted), después se subía un archivo nuevo en venta_comprobantes,
  // y al reactivarse, el comprobante de Financiera quedaba pegado al archivo viejo —
  // archivo desincronizado de los montos. Riesgo de auditoría con terceros.
  const existing = await client.query('SELECT id FROM comprobantes WHERE venta_id = $1 ORDER BY id LIMIT 1', [ventaId]);
  if (existing.rows[0]) {
    const { rows } = await client.query(
      `UPDATE comprobantes
          SET deleted_at = NULL, monto = $2, monto_financiera = $3, monto_neto = $4,
              archivo_data = $5, archivo_nombre = $6, archivo_tipo = $7
        WHERE venta_id = $1
       RETURNING id, monto, monto_financiera, monto_neto`,
      [ventaId, monto, monto_financiera, monto_neto,
       file.archivo_data, file.archivo_nombre ?? null, file.archivo_tipo ?? null]
    );
    return rows[0];
  }

  const { rows: v } = await client.query('SELECT fecha, cliente_nombre, order_id FROM ventas WHERE id = $1', [ventaId]);
  const { rows } = await client.query(
    `INSERT INTO comprobantes (fecha, cliente, monto, monto_financiera, monto_neto, referencia, archivo_data, archivo_nombre, archivo_tipo, venta_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, monto, monto_financiera, monto_neto`,
    [v[0].fecha, v[0].cliente_nombre ?? null, monto, monto_financiera, monto_neto, v[0].order_id,
     file.archivo_data, file.archivo_nombre ?? null, file.archivo_tipo ?? null, ventaId]
  );
  return rows[0];
}

module.exports = { syncFinancieraComprobante };
