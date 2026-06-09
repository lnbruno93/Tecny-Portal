// Helper compartido: cancela un movimiento_cc dentro de una transacción.
//
// Surgió el 2026-06-09 al implementar el fix de cascada en DELETE /clientes/:id.
// Antes la lógica vivía inline en DELETE /movimientos/:id; al replicarla para el
// cascada (y para el cleanup admin de huérfanos), nos quedaban tres copias del
// mismo flow no-trivial:
//   1. Validar el movimiento (existe + no borrado) y lockearlo (FOR UPDATE).
//   2. Soft-delete del movimiento.
//   3. Revertir caja_movimientos asociados (ingreso vuelve a la caja origen).
//   4. Si el movimiento tocaba stock (compra / entrega_mercaderia / devolucion),
//      restaurar las cantidades en productos. Incluye guard #B-06: si el signo
//      es negativo (borrar una devolución) y el stock actual quedó vendido,
//      devolver 409 explícito antes del UPDATE para no romper el CHECK
//      constraint cantidad >= 0.
//   5. Audit log con el origen del cancel ('manual', 'cliente_cascade',
//      'orphan_cleanup') para trazabilidad.
//
// Diseño:
//   - Recibe un pg client ya en transacción (BEGIN ya emitido) — el caller
//     decide cuándo commitear. Esto permite que DELETE /clientes/:id procese
//     N movimientos atomicamente con el soft-delete del cliente.
//   - No invalida cache (responsabilidad del caller — el cliente puede tener
//     0..N movs y no queremos invalidar N veces, solo al final).
//   - Lanza errores con `err.status` para que el caller pueda traducir a HTTP
//     sin parsear regex (patrón consistente con pagos.js / comprobantes.js).

const audit = require('./audit');
const { reverseCajaMovimientos } = require('./cajaLedger');

/**
 * Cancela un movimiento_cc: soft-delete + revertir caja + restaurar stock.
 *
 * @param {pg.Client} client  Cliente PG en una TX activa (BEGIN ya emitido).
 * @param {object}    opts
 * @param {number}    opts.movimientoId
 * @param {number}    opts.userId       Para el audit log.
 * @param {string}    opts.origen       'manual' | 'cliente_cascade' | 'orphan_cleanup'
 * @returns {Promise<{movimiento, productos_restaurados: number, caja_revertida: boolean}>}
 *          Información para que el caller arme la respuesta o agregue al
 *          contador agregado en flows batch (cascada, cleanup).
 * @throws  Error con .status si el movimiento no existe (404), ya está borrado
 *          (404), o un check de stock falla (409). El caller hace el ROLLBACK.
 */
async function cancelMovimientoCC(client, { movimientoId, userId, origen = 'manual' }) {
  // 1. Lockear + leer.
  const { rows: pre } = await client.query(
    'SELECT * FROM movimientos_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [movimientoId]
  );
  if (!pre[0]) {
    const err = new Error('Movimiento no encontrado');
    err.status = 404;
    throw err;
  }
  const mov = pre[0];

  // 2. Revertir caja (idempotente: si no había caja_movimientos asociados, no-op).
  await reverseCajaMovimientos(client, 'movimientos_cc', movimientoId);

  // 3. Soft-delete del movimiento.
  await client.query(
    'UPDATE movimientos_cc SET deleted_at = NOW() WHERE id = $1',
    [movimientoId]
  );

  // 4. Restaurar stock si el tipo lo tocaba.
  let productosRestaurados = 0;
  if (['compra', 'entrega_mercaderia', 'devolucion'].includes(mov.tipo)) {
    const sign = mov.tipo === 'devolucion' ? -1 : 1; // compra/entrega: + (reintegrar); devolución: − (sacar)
    const { rows: items } = await client.query(
      `SELECT producto_id, cantidad FROM items_movimiento_cc
         WHERE movimiento_cc_id = $1 AND producto_id IS NOT NULL
         ORDER BY producto_id`,
      [movimientoId]
    );

    if (items.length > 0) {
      const prodIds = items.map(it => Number(it.producto_id));
      const cants   = items.map(it => sign * Number(it.cantidad || 1));

      // Guard #B-06: si vamos a restar (borrar una devolución) y entre la
      // devolución original y este cancel alguien revendió el stock, el CHECK
      // constraint (cantidad >= 0) rompería. Devolvemos 409 explícito ANTES
      // del UPDATE. Lockeo batch ordenado por id para evitar deadlock.
      if (sign < 0) {
        const { rows: prods } = await client.query(
          `SELECT id, nombre, cantidad FROM productos
             WHERE id = ANY($1::int[])
             ORDER BY id FOR UPDATE`,
          [prodIds]
        );
        const prodMap = new Map(prods.map(p => [Number(p.id), p]));
        for (let i = 0; i < items.length; i++) {
          const p = prodMap.get(Number(items[i].producto_id));
          if (!p) continue;
          if (Number(p.cantidad) + cants[i] < 0) {
            const err = new Error(
              `No se puede cancelar la devolución: el stock de "${p.nombre}" ya fue revendido ` +
              `(disponible ${p.cantidad}, necesario ${-cants[i]}).`
            );
            err.status = 409;
            err.producto_id = Number(items[i].producto_id);
            throw err;
          }
        }
      }

      // Bulk UPDATE.
      await client.query(
        `UPDATE productos p SET
           cantidad = p.cantidad + u.delta,
           estado = CASE
             WHEN p.cantidad + u.delta <= 0                              THEN 'vendido'
             WHEN p.cantidad + u.delta > 0 AND p.estado = 'vendido'      THEN 'disponible'
             ELSE p.estado
           END
         FROM UNNEST($1::int[], $2::int[]) AS u(pid, delta)
         WHERE p.id = u.pid`,
        [prodIds, cants]
      );
      productosRestaurados = items.length;
    }
  }

  // 5. Si el mov es una devolución inline (junio 2026), destachar los items
  //    originales que apuntaban a este mov via devolucion_mov_id. Sin esto,
  //    al borrar la devolución el stock vuelve a vendido (paso 4 ya lo hizo
  //    con sign=-1) pero el item original sigue marcado devuelto_at != NULL
  //    y se muestra tachado en el desglose — inconsistencia visual.
  //    NOOP para devoluciones manuales (sin devolucion_mov_id apuntando).
  let itemsDestachados = 0;
  if (mov.tipo === 'devolucion') {
    const { rowCount } = await client.query(
      `UPDATE items_movimiento_cc
          SET devuelto_at = NULL,
              devolucion_mov_id = NULL,
              devolucion_user_id = NULL
        WHERE devolucion_mov_id = $1`,
      [movimientoId]
    );
    itemsDestachados = rowCount;
  }

  // 6. Audit: incluye `_origen` para distinguir manual / cascada / cleanup.
  await audit(client, 'movimientos_cc', 'DELETE', movimientoId, {
    antes: mov,
    user_id: userId,
    _origen: origen,
    _items_destachados: itemsDestachados,
  });

  return {
    movimiento: mov,
    productos_restaurados: productosRestaurados,
    caja_revertida: true,
    items_destachados: itemsDestachados,
  };
}

module.exports = { cancelMovimientoCC };
