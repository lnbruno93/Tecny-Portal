// Helpers compartidos del módulo Ventas. Extraídos de `routes/ventas.js` para
// poder reusarlos desde el flujo "envío → venta auto" (lib/ventaDesdeEnvio.js)
// y el rollback de cancelación (lib/cancelarVenta.js) sin duplicar lógica.

function err400(msg) { return Object.assign(new Error(msg), { status: 400 }); }

// Una venta retiene (descuenta) stock mientras no esté cancelada.
const retieneStock = (estado) => estado !== 'cancelado';

// Suma de cantidades necesarias por producto_id (ignora ítems manuales sin producto)
function necesidadPorProducto(items) {
  const map = new Map();
  for (const it of items || []) {
    if (!it.producto_id) continue;
    map.set(it.producto_id, (map.get(it.producto_id) || 0) + (Number(it.cantidad) || 0));
  }
  return map;
}

// Bloquea las filas (FOR UPDATE, orden estable para evitar deadlocks), valida
// disponibilidad y descuenta stock. Lanza err400 si no hay stock o el unitario ya se vendió.
async function descontarStock(client, items) {
  const need = necesidadPorProducto(items);
  for (const id of [...need.keys()].sort((a, b) => a - b)) {
    const { rows } = await client.query(
      `SELECT id, nombre, tipo_carga, estado, cantidad, trackear_stock
         FROM productos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]
    );
    const p = rows[0];
    if (!p) throw err400('Un producto ya no existe en el inventario.');
    const qty = need.get(id);
    if (p.tipo_carga === 'unitario' && p.estado === 'vendido') throw err400(`"${p.nombre}" ya figura como vendido.`);
    if (p.trackear_stock && p.cantidad < qty) throw err400(`Stock insuficiente de "${p.nombre}" (disponible: ${p.cantidad}, pedido: ${qty}).`);
    await client.query(
      `UPDATE productos
         SET cantidad = GREATEST(cantidad - $1, 0),
             estado   = CASE WHEN tipo_carga = 'unitario' THEN 'vendido' ELSE estado END
       WHERE id = $2`, [qty, id]
    );
  }
}

// Repone stock (al eliminar o reeditar una venta). Devuelve unitarios vendidos a 'disponible'.
async function reponerStock(client, items) {
  const need = necesidadPorProducto(items);
  for (const id of [...need.keys()].sort((a, b) => a - b)) {
    await client.query(
      `UPDATE productos
         SET cantidad = cantidad + $1,
             estado   = CASE WHEN tipo_carga = 'unitario' AND estado = 'vendido' THEN 'disponible' ELSE estado END
       WHERE id = $2 AND deleted_at IS NULL`, [need.get(id), id]
    );
  }
}

module.exports = { err400, retieneStock, necesidadPorProducto, descontarStock, reponerStock };
