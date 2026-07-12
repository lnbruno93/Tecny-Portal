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
//
// Reglas de validación:
//   1. Unitario ya vendido → rechazar (con o sin trackeo). El estado es la fuente
//      de verdad para unitarios.
//   2. trackear_stock=true → validar cantidad (caso normal).
//   3. trackear_stock=false en tipo_carga='lote' → validamos cantidad IGUAL. Antes
//      de mayo-2026 acá había un bug: lotes "no trackeados" se podían vender
//      ilimitado porque el chequeo se saltaba. Para lotes, la cantidad ES el stock;
//      si querés un lote infinito tenés que setearlo en una cantidad alta a
//      propósito. trackear_stock=false en lotes pasa a ser efectivamente lo mismo
//      que con tracking — se mantiene el flag por compatibilidad histórica.
//
// P2 auditoría 2026-06: bulkificado de N round-trips (2N queries) a 2 queries
// fijas (1 SELECT FOR UPDATE + 1 UPDATE con UNNEST). Para una venta típica con
// 5 items: 10 → 2 queries. Para una B2B con 50 items: 100 → 2 queries. El
// ORDER BY id en el SELECT mantiene el orden estable para evitar deadlocks
// (mismo orden = serialización determinística entre tx concurrentes).
async function descontarStock(client, items) {
  const need = necesidadPorProducto(items);
  if (need.size === 0) return;

  const ids = [...need.keys()].sort((a, b) => a - b);

  // 1 SELECT con FOR UPDATE — lockea todas las filas necesarias en orden
  // estable. Validamos disponibilidad en JS antes del UPDATE.
  const { rows } = await client.query(
    `SELECT id, nombre, tipo_carga, estado, cantidad, trackear_stock
       FROM productos
      WHERE id = ANY($1::int[]) AND deleted_at IS NULL
      ORDER BY id
      FOR UPDATE`,
    [ids]
  );

  // Detectar productos que faltaron (deleted_at o id inexistente).
  if (rows.length < ids.length) {
    throw err400('Un producto ya no existe en el inventario.');
  }

  // Validación item por item (en memoria, no queries).
  for (const p of rows) {
    const qty = need.get(p.id);
    if (p.tipo_carga === 'unitario' && p.estado === 'vendido') {
      throw err400(`"${p.nombre}" ya figura como vendido.`);
    }
    const debeValidarCantidad = p.trackear_stock || p.tipo_carga === 'lote';
    if (debeValidarCantidad && p.cantidad < qty) {
      throw err400(`Stock insuficiente de "${p.nombre}" (disponible: ${p.cantidad}, pedido: ${qty}).`);
    }
  }

  // 1 UPDATE bulk con UNNEST — aplica el descuento a todos los productos a la vez.
  // El array de cantidades va en el mismo orden que `ids`.
  //
  // 2026-07-12 (auditoría TOTAL P0-2 Stock): agregado `AND p.deleted_at IS NULL`
  // — mismo pattern que TODOS los otros UPDATE productos del portal
  // (`reponerStock` acá abajo, `cuentas.js:975` B2B, `pagos.js:1091, 1140`
  // devolución cross-tenant, `crossTenantOps.js:358` post-fix Red B2B P2-1).
  // El SELECT previo filtra `deleted_at IS NULL`, pero el UPDATE no
  // filtraba — TOCTOU si un producto se soft-deletea entre SELECT y UPDATE.
  const cantidades = ids.map(id => need.get(id));
  await client.query(
    `UPDATE productos AS p
        SET cantidad = GREATEST(p.cantidad - u.cant, 0),
            estado   = CASE WHEN p.tipo_carga = 'unitario' THEN 'vendido' ELSE p.estado END
       FROM UNNEST($1::int[], $2::int[]) AS u(id, cant)
      WHERE p.id = u.id AND p.deleted_at IS NULL`,
    [ids, cantidades]
  );
}

// Repone stock (al eliminar o reeditar una venta). Devuelve unitarios vendidos a 'disponible'.
//
// P2 auditoría 2026-06: bulkificado igual que descontarStock — 1 UPDATE
// con UNNEST en lugar de N UPDATEs serializados. No requiere SELECT FOR
// UPDATE previo porque reponer es estrictamente aditivo (no puede romper
// invariantes — un producto nunca tiene "demasiado stock" como problema).
async function reponerStock(client, items) {
  const need = necesidadPorProducto(items);
  if (need.size === 0) return;

  const ids = [...need.keys()].sort((a, b) => a - b);
  const cantidades = ids.map(id => need.get(id));
  await client.query(
    `UPDATE productos AS p
        SET cantidad = p.cantidad + u.cant,
            estado   = CASE WHEN p.tipo_carga = 'unitario' AND p.estado = 'vendido'
                            THEN 'disponible' ELSE p.estado END
       FROM UNNEST($1::int[], $2::int[]) AS u(id, cant)
      WHERE p.id = u.id AND p.deleted_at IS NULL`,
    [ids, cantidades]
  );
}

module.exports = { err400, retieneStock, necesidadPorProducto, descontarStock, reponerStock };
