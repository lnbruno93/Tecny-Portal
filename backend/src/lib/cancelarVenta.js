// Rollback completo de una venta: reverter todos sus efectos secundarios
// (stock, caja, deuda CC, comprobantes, tarjetas). Extraído de routes/ventas.js
// para reusar desde el flujo de cancelación/borrado de envíos cuando éstos tienen
// una venta asociada (venta_id).
//
// El caller decide qué hacer con la fila `ventas` después: marcar 'cancelado'
// o soft-delete. Esta función NO toca `ventas.estado` ni `ventas.deleted_at`.

const { reverseCajaMovimientos } = require('./cajaLedger');
const { syncTarjetaCobros } = require('./tarjetas');
const { retieneStock, reponerStock } = require('./ventaCore');

// Devuelve true si la venta tenía efectos vivos (stock retenido, cc, caja, etc.).
async function revertirEfectosVenta(client, venta) {
  if (!venta || !venta.id) return false;
  // 1) Reponer stock si la venta retenía (las canceladas ya lo habían liberado).
  if (retieneStock(venta.estado)) {
    const { rows: items } = await client.query(
      'SELECT producto_id, cantidad FROM venta_items WHERE venta_id = $1 AND producto_id IS NOT NULL',
      [venta.id]
    );
    if (items.length) await reponerStock(client, items);
  }
  // 2) Revertir deuda de cuenta corriente generada por esta venta.
  await client.query('UPDATE movimientos_cc SET deleted_at = NOW() WHERE venta_id = $1 AND deleted_at IS NULL', [venta.id]);
  // 3) Revertir ingresos de caja.
  await reverseCajaMovimientos(client, 'ventas', venta.id);
  // 4) Soft-delete del comprobante de Financiera.
  await client.query('UPDATE comprobantes SET deleted_at = NOW() WHERE venta_id = $1 AND deleted_at IS NULL', [venta.id]);
  // 5) Revertir cobros de tarjeta.
  await syncTarjetaCobros(client, venta.id, 'cancelado');
  return true;
}

module.exports = { revertirEfectosVenta };
