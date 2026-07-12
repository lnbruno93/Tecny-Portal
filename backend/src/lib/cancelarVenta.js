// Rollback completo de una venta: reverter todos sus efectos secundarios
// (stock, caja, deuda CC, comprobantes, tarjetas, canjes). Extraído de
// routes/ventas.js para reusar desde el flujo de cancelación/borrado de envíos
// cuando éstos tienen una venta asociada (venta_id).
//
// El caller decide qué hacer con la fila `ventas` después: marcar 'cancelado'
// o soft-delete. Esta función NO toca `ventas.estado` ni `ventas.deleted_at`.

const { reverseCajaMovimientos } = require('./cajaLedger');
const { syncTarjetaCobros } = require('./tarjetas');
const { retieneStock, reponerStock } = require('./ventaCore');

/**
 * Soft-delete de canjes de una venta con manejo del producto linkeado.
 *
 * 2026-07-12 (auditoría TOTAL Stock P1-1):
 *
 * Política acordada (Lucas 2026-07-12):
 *   · Si el producto del canje está DISPONIBLE → se soft-deletea el producto
 *     junto al canje (limpia stock fantasma).
 *   · Si el producto del canje ya fue VENDIDO en otra venta → 409 (bloquear
 *     el revert; el operador debe anular esa otra venta primero).
 *   · Si el producto está en OTRO estado (reservado, en_técnico) → 409
 *     conservador (el operador libera manualmente).
 *   · Si el canje no tiene producto_id → soft-delete del canje solo.
 *
 * Con `preserveProductoIds`, los canjes cuyo producto_id esté en esa lista
 * NO auto-soft-deletean el producto (usado en el PUT /ventas para preservar
 * productos que persisten en el body nuevo).
 *
 * @throws Error con .status=409 si algún producto del canje ya fue vendido.
 */
async function revertirCanjesDeVenta(client, ventaId, { preserveProductoIds = [] } = {}) {
  const { rows: canjes } = await client.query(
    // FOR UPDATE de canjes activos para bloquear concurrencia. El producto
    // se lockea después individualmente (evita self-join lock que serializa
    // demasiado).
    `SELECT id, producto_id FROM canjes
      WHERE venta_id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [ventaId]
  );
  if (!canjes.length) return;

  const preserveSet = new Set((preserveProductoIds || []).filter(x => x != null));

  for (const canje of canjes) {
    // Producto linkeado + NO preservado → decidir destino.
    if (canje.producto_id && !preserveSet.has(canje.producto_id)) {
      const { rows: prod } = await client.query(
        `SELECT id, estado, imei FROM productos
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [canje.producto_id]
      );
      if (prod[0]) {
        if (prod[0].estado === 'disponible') {
          // Ideal path: producto todavía en stock → limpieza.
          await client.query(
            'UPDATE productos SET deleted_at = NOW() WHERE id = $1',
            [canje.producto_id]
          );
        } else if (prod[0].estado === 'vendido') {
          const e = new Error(
            `No se puede revertir el canje: el equipo (producto #${canje.producto_id}${prod[0].imei ? ` · IMEI ${prod[0].imei}` : ''}) ya fue vendido en otra venta. Primero anulá esa venta.`
          );
          e.status = 409;
          e.code = 'CANJE_PRODUCTO_VENDIDO';
          throw e;
        } else {
          // Reservado, en_técnico, etc. — el operador debe liberar manualmente.
          const e = new Error(
            `No se puede revertir el canje: el equipo (producto #${canje.producto_id}${prod[0].imei ? ` · IMEI ${prod[0].imei}` : ''}) está en estado "${prod[0].estado}". Cambialo a "disponible" o eliminá el producto manualmente antes de revertir.`
          );
          e.status = 409;
          e.code = 'CANJE_PRODUCTO_NO_LIBRE';
          throw e;
        }
      }
      // Si prod[0] es undefined → el producto ya estaba soft-deleted; el
      // canje pierde referencia pero se soft-deletea igual (no rompemos).
    }
    // Soft-delete del canje siempre. En el PUT /ventas el body nuevo va a
    // re-insertar los canjes que persisten (apuntando al mismo producto si
    // se preservó); en el DELETE /ventas queda como está.
    await client.query(
      'UPDATE canjes SET deleted_at = NOW() WHERE id = $1',
      [canje.id]
    );
  }
}

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
  // 5) Soft-delete de los archivos adjuntos de la venta. Antes de mayo-2026
  // estos quedaban vivos al cancelar — riesgo de leak (sync de Financiera
  // podía levantar un archivo de venta cancelada) y storage sin tope.
  await client.query('UPDATE venta_comprobantes SET deleted_at = NOW() WHERE venta_id = $1 AND deleted_at IS NULL', [venta.id]);
  // 6) Revertir cobros de tarjeta.
  await syncTarjetaCobros(client, venta.id, 'cancelado');
  // 7) 2026-07-12 (audit Stock P1-1): revertir canjes con política 3-cases
  // (disponible → soft-delete producto, vendido/no-libre → 409). Antes esta
  // función NO tocaba canjes → equipos huérfanos en stock al cancelar venta.
  await revertirCanjesDeVenta(client, venta.id);
  return true;
}

module.exports = { revertirEfectosVenta, revertirCanjesDeVenta };
