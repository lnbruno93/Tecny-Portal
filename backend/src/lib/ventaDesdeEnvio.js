// Crea una venta "registro" a partir de un envío, para evitar el doble trabajo de
// cargar el envío y después la venta. Toma los items de tipo 'producto' del envío
// como items de venta (en ARS, sin costo). NO postea a caja ni crea pagos: la plata
// la sigue manejando el envío (origen 'envio' en el ledger), así no se duplica.
// Debe ejecutarse dentro de la transacción del envío. Devuelve la venta o null.
const crypto = require('crypto');
const { round2 } = require('./money');

function genOrderId() {
  const yy = new Date().getFullYear().toString().slice(-2);
  return `ORD-${yy}-${crypto.randomBytes(6).toString('hex')}`;
}

async function crearVentaDesdeEnvio(client, envio, items, userId) {
  const productos = (items || []).filter(i => i.tipo === 'producto');
  if (productos.length === 0) return null;

  const { rows } = await client.query(
    `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, ganancia_usd, notas, user_id)
     VALUES ($1,$2,$3,'acreditado',0,0,$4,$5) RETURNING *`,
    [genOrderId(), envio.fecha, envio.cliente, 'Generada automáticamente desde un envío', userId]
  );
  const venta = rows[0];
  for (const it of productos) {
    const precio = round2(Number(it.monto) || 0);
    await client.query(
      `INSERT INTO venta_items (venta_id, descripcion, cantidad, precio_vendido, costo, moneda, comision, ganancia)
       VALUES ($1,$2,1,$3,0,'ARS',0,$3)`,
      [venta.id, it.descripcion || 'Producto', precio]
    );
  }
  return venta;
}

module.exports = { crearVentaDesdeEnvio };
