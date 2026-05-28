// Crea una venta REAL a partir de un envío, para evitar el doble trabajo de
// cargar el envío y después la venta. Toma los items de tipo 'producto' del
// envío como items de venta.
//
// Comportamiento según los campos opcionales del envío:
//   · si `envio.tc` está seteado y los items son ARS, se calcula total_usd
//     correctamente; sino, queda en 0 (compat con frontend viejo).
//   · si un item trae `producto_id`, la venta linkea ese producto y se descuenta
//     stock (vía descontarStock); sino, la venta es solo registro contable.
//
// La plata la sigue manejando el envío (origen 'envio' en el ledger), por eso
// esta función NO postea a caja_movimientos.
//
// Debe ejecutarse dentro de la transacción del envío.
const crypto = require('crypto');
const { round2, toUsd } = require('./money');
const { descontarStock } = require('./ventaCore');

function genOrderId() {
  const yy = new Date().getFullYear().toString().slice(-2);
  return `ORD-${yy}-${crypto.randomBytes(6).toString('hex')}`;
}

async function crearVentaDesdeEnvio(client, envio, items, userId) {
  const productos = (items || []).filter(i => i.tipo === 'producto');
  if (productos.length === 0) return null;

  // Total/ganancia: si hay TC, convertimos ARS→USD; sino quedan en 0 (la venta
  // entra como registro sin total — caller decide si la quiere contar o no).
  let totalUsd = 0;
  let costoUsd = 0;
  if (envio.tc && Number(envio.tc) > 0) {
    for (const it of productos) {
      const monto = round2(Number(it.monto) || 0);
      totalUsd += toUsd(monto, 'ARS', envio.tc);
      // Si linkeamos producto_id, la ganancia es total - costo del producto
      // (lo leemos a continuación, antes del descuento). Sino, costoUsd queda 0.
    }
    totalUsd = round2(totalUsd);
  }

  // Si hay producto_id linkeados, descontamos stock y traemos costos para ganancia.
  const linkedItems = productos.filter(p => p.producto_id);
  if (linkedItems.length > 0 && envio.tc && Number(envio.tc) > 0) {
    const ids = [...new Set(linkedItems.map(p => p.producto_id))];
    const { rows: prods } = await client.query(
      'SELECT id, costo, costo_moneda FROM productos WHERE id = ANY($1::int[]) AND deleted_at IS NULL',
      [ids]
    );
    const costoPorId = new Map(prods.map(p => [p.id, p]));
    for (const it of linkedItems) {
      const p = costoPorId.get(it.producto_id);
      if (p) costoUsd += toUsd(Number(p.costo) || 0, p.costo_moneda || 'USD', envio.tc);
    }
    costoUsd = round2(costoUsd);
  }
  const gananciaUsd = round2(totalUsd - costoUsd);

  const { rows } = await client.query(
    `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, ganancia_usd, notas, user_id)
     VALUES ($1,$2,$3,'acreditado',$4,$5,$6,$7) RETURNING *`,
    [genOrderId(), envio.fecha, envio.cliente, totalUsd, gananciaUsd, 'Generada automáticamente desde un envío', userId]
  );
  const venta = rows[0];

  for (const it of productos) {
    const precio = round2(Number(it.monto) || 0);
    // costo_unitario por venta_item: si linkeado, leer del producto; sino 0.
    let costoItem = 0;
    if (it.producto_id) {
      const { rows: pr } = await client.query(
        'SELECT costo, costo_moneda FROM productos WHERE id = $1 AND deleted_at IS NULL',
        [it.producto_id]
      );
      if (pr[0]) {
        // Si el envío trae TC y el producto está en USD, lo dejamos en USD; sino convertimos.
        costoItem = round2(Number(pr[0].costo) || 0);
      }
    }
    const ganancia = round2(precio - costoItem);
    await client.query(
      `INSERT INTO venta_items (venta_id, producto_id, descripcion, cantidad, precio_vendido, costo, moneda, comision, ganancia)
       VALUES ($1,$2,$3,1,$4,$5,'ARS',0,$6)`,
      [venta.id, it.producto_id || null, it.descripcion || 'Producto', precio, costoItem, ganancia]
    );
  }

  // Descontar stock para los items linkeados a productos.
  if (linkedItems.length > 0) {
    await descontarStock(client, linkedItems.map(it => ({ producto_id: it.producto_id, cantidad: 1 })));
  }

  return venta;
}

// Sincroniza los venta_items con los items del envío cuando éste se edita.
// Devuelve la venta actualizada o null si la venta ya no existe.
async function actualizarVentaDesdeEnvio(client, envio, items, userId) {
  if (!envio.venta_id) return null;
  // Reponer stock de los items linkeados anteriores antes de borrar.
  const { rows: prev } = await client.query(
    'SELECT producto_id, cantidad FROM venta_items WHERE venta_id = $1 AND producto_id IS NOT NULL',
    [envio.venta_id]
  );
  if (prev.length) {
    const { reponerStock } = require('./ventaCore');
    await reponerStock(client, prev);
  }
  await client.query('DELETE FROM venta_items WHERE venta_id = $1', [envio.venta_id]);

  // Re-insertar items + recalcular total/ganancia + re-descontar stock para los nuevos linkeados.
  const productos = (items || []).filter(i => i.tipo === 'producto');
  let totalUsd = 0, costoUsd = 0;
  const hasTc = envio.tc && Number(envio.tc) > 0;
  if (hasTc) {
    for (const it of productos) totalUsd += toUsd(Number(it.monto) || 0, 'ARS', envio.tc);
    totalUsd = round2(totalUsd);
  }
  for (const it of productos) {
    const precio = round2(Number(it.monto) || 0);
    let costoItem = 0;
    if (it.producto_id) {
      const { rows: pr } = await client.query('SELECT costo, costo_moneda FROM productos WHERE id = $1 AND deleted_at IS NULL', [it.producto_id]);
      if (pr[0]) costoItem = round2(Number(pr[0].costo) || 0);
      if (hasTc) costoUsd += toUsd(costoItem, pr[0]?.costo_moneda || 'USD', envio.tc);
    }
    await client.query(
      `INSERT INTO venta_items (venta_id, producto_id, descripcion, cantidad, precio_vendido, costo, moneda, comision, ganancia)
       VALUES ($1,$2,$3,1,$4,$5,'ARS',0,$6)`,
      [envio.venta_id, it.producto_id || null, it.descripcion || 'Producto', precio, costoItem, round2(precio - costoItem)]
    );
  }
  const gananciaUsd = round2(totalUsd - costoUsd);
  const { rows: vrows } = await client.query(
    `UPDATE ventas SET total_usd = $1, ganancia_usd = $2 WHERE id = $3 RETURNING *`,
    [totalUsd, gananciaUsd, envio.venta_id]
  );

  // Descontar stock de los nuevos linkeados.
  const linkedNew = productos.filter(p => p.producto_id);
  if (linkedNew.length) {
    await descontarStock(client, linkedNew.map(it => ({ producto_id: it.producto_id, cantidad: 1 })));
  }

  return vrows[0] || null;
}

module.exports = { crearVentaDesdeEnvio, actualizarVentaDesdeEnvio };
