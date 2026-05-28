const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { createEnvioSchema, updateEnvioSchema, queryEnviosSchema } = require('../schemas/envios');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const parseId = require('../lib/parseId');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { crearVentaDesdeEnvio, actualizarVentaDesdeEnvio } = require('../lib/ventaDesdeEnvio');
const { revertirEfectosVenta } = require('../lib/cancelarVenta');

// Sincroniza el impacto de un envío en el ledger de cajas: revierte los ingresos
// previos y, si el envío no está cancelado, re-postea un ingreso por cada item
// 'pago' que tenga una caja asignada (metodo_pago_id). Idempotente.
async function syncEnvioCaja(client, envioId, fecha, estado, userId) {
  await reverseCajaMovimientos(client, 'envios', envioId);
  if (estado === 'Cancelado') return;
  // Los cobros de envío son siempre en ARS (el form captura "Monto ARS"); el front
  // solo ofrece cajas ARS. Dejar moneda 'ARS' fija es intencional: la guarda de
  // postCajaMovimiento rechaza una caja no-ARS, evitando contaminar su saldo.
  const { rows: pagos } = await client.query(
    `SELECT metodo_pago_id, monto FROM envio_items
      WHERE envio_id = $1 AND tipo = 'pago' AND metodo_pago_id IS NOT NULL AND monto > 0`,
    [envioId]
  );
  for (const p of pagos) {
    await postCajaMovimiento(client, {
      caja_id: p.metodo_pago_id, fecha, tipo: 'ingreso',
      monto: p.monto, moneda: 'ARS', tc: null,
      origen: 'envio', ref_tabla: 'envios', ref_id: envioId,
      concepto: `Cobro envío #${envioId}`, user_id: userId,
    });
  }
}

// Inserta los items del envío (incluye producto_id si vino).
async function insertarItems(client, envioId, items) {
  for (const item of items || []) {
    await client.query(
      `INSERT INTO envio_items (envio_id, tipo, descripcion, monto, metodo_pago, metodo_pago_id, producto_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [envioId, item.tipo, item.descripcion ?? null, item.monto, item.metodo_pago ?? null, item.metodo_pago_id ?? null, item.producto_id ?? null]
    );
  }
}


router.get('/', validate(queryEnviosSchema, 'query'), async (req, res, next) => {
  try {
    const { estado, buscar, desde, hasta } = req.query;

    // Construir cláusula WHERE compartida entre la query de datos y la de conteo
    // Evita el regex frágil que rompía si el SELECT cambiaba de formato
    const conditions = ['e.deleted_at IS NULL'];
    const params = [];
    if (estado) { params.push(estado);          conditions.push(`e.estado = $${params.length}`); }
    if (desde)  { params.push(desde);            conditions.push(`e.fecha >= $${params.length}`); }
    if (hasta)  { params.push(hasta);            conditions.push(`e.fecha <= $${params.length}`); }
    if (buscar) {
      params.push(`%${buscar}%`);
      conditions.push(`(e.cliente ILIKE $${params.length} OR e.direccion ILIKE $${params.length}
                        OR e.barrio ILIKE $${params.length} OR e.telefono ILIKE $${params.length}
                        OR e.notas ILIKE $${params.length})`);
    }
    const where = conditions.join(' AND ');

    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });

    const countQuery = `SELECT COUNT(DISTINCT e.id) FROM envios e WHERE ${where}`;
    const dataQuery  = `
      SELECT e.*,
        JSON_AGG(i ORDER BY i.tipo, i.id) FILTER (WHERE i.id IS NOT NULL) AS items
      FROM envios e
      LEFT JOIN envio_items i ON i.envio_id = e.id
      WHERE ${where}
      GROUP BY e.id
      ORDER BY e.fecha DESC, e.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const [countRes, dataRes] = await Promise.all([
      db.query(countQuery, params),
      db.query(dataQuery,  [...params, limit, offset]),
    ]);
    const total = parseInt(countRes.rows[0].count) || 0;
    res.json(paginatedResponse(dataRes.rows.map(r => ({ ...r, items: r.items || [] })), total, { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(createEnvioSchema), async (req, res, next) => {
  try {
    const {
      fecha, cliente, telefono, direccion, barrio,
      costo_envio, total_cobrado, horario, operador, notas, estado, prioridad, tc, items, registrar_venta,
    } = req.body;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO envios (fecha, cliente, telefono, direccion, barrio, costo_envio, total_cobrado, horario, operador, notas, estado, prioridad, tc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [fecha, cliente, telefono ?? null, direccion, barrio ?? null, costo_envio, total_cobrado,
         horario ?? null, operador ?? null, notas ?? null, estado, prioridad ?? null, tc ?? null]
      );
      const envio = rows[0];

      await insertarItems(client, envio.id, items);
      await syncEnvioCaja(client, envio.id, envio.fecha, envio.estado, req.user.id);

      // Registrar la venta asociada: si hay items 'producto', crea una venta real
      // que linkea producto_id (cuando se proveyó) y descuenta stock.
      let ventaCreada = null;
      if (registrar_venta) {
        ventaCreada = await crearVentaDesdeEnvio(client, envio, items, req.user.id);
        if (ventaCreada) {
          await client.query('UPDATE envios SET venta_id = $1 WHERE id = $2', [ventaCreada.id, envio.id]);
          envio.venta_id = ventaCreada.id;
        }
      }
      await client.query('COMMIT');
      await audit('envios', 'INSERT', envio.id, { despues: envio, user_id: req.user.id });
      if (ventaCreada) await audit('ventas', 'INSERT', ventaCreada.id, { despues: ventaCreada, _origen: 'envio', user_id: req.user.id });
      res.status(201).json(envio);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

router.put('/:id', validate(updateEnvioSchema), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const {
    fecha, cliente, telefono, direccion, barrio,
    costo_envio, total_cobrado, horario, operador, notas, estado, prioridad, tc, items,
  } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock de la fila dentro de la tx para serializar ediciones concurrentes
    const { rows: before } = await client.query(
      'SELECT * FROM envios WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Envío no encontrado' }); }

    const { rows } = await client.query(
        `UPDATE envios SET
          fecha         = COALESCE($1,  fecha),
          cliente       = COALESCE($2,  cliente),
          telefono      = COALESCE($3,  telefono),
          direccion     = COALESCE($4,  direccion),
          barrio        = COALESCE($5,  barrio),
          costo_envio   = COALESCE($6,  costo_envio),
          total_cobrado = COALESCE($7,  total_cobrado),
          horario       = COALESCE($8,  horario),
          operador      = COALESCE($9,  operador),
          notas         = COALESCE($10, notas),
          estado        = COALESCE($11, estado),
          prioridad     = COALESCE($12, prioridad),
          tc            = COALESCE($13, tc)
        WHERE id = $14 RETURNING *`,
        [fecha, cliente, telefono, direccion, barrio, costo_envio, total_cobrado,
         horario, operador, notas, estado, prioridad, tc, id]
      );
      const envio = rows[0];

      let ventaSincronizada = null;
      if (items !== undefined) {
        await client.query('DELETE FROM envio_items WHERE envio_id = $1', [id]);
        await insertarItems(client, id, items);
        // Si hay venta asociada y no se canceló, sincronizar venta_items (re-crear) y stock.
        if (envio.venta_id && envio.estado !== 'Cancelado') {
          ventaSincronizada = await actualizarVentaDesdeEnvio(client, envio, items, req.user.id);
        }
      }
      // Recalcular el impacto en caja (cambió la lista de pagos y/o el estado)
      await syncEnvioCaja(client, id, envio.fecha, envio.estado, req.user.id);

      // Si el envío se cancela y tenía venta asociada, revertir efectos + marcar cancelada
      let ventaCancelada = null;
      if (envio.estado === 'Cancelado' && before[0].venta_id) {
        const { rows: vrows } = await client.query('SELECT * FROM ventas WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [before[0].venta_id]);
        if (vrows[0]) {
          await revertirEfectosVenta(client, vrows[0]);
          await client.query("UPDATE ventas SET estado = 'cancelado' WHERE id = $1 AND deleted_at IS NULL", [before[0].venta_id]);
          ventaCancelada = vrows[0];
        }
      }
      await client.query('COMMIT');
      await audit('envios', 'UPDATE', id, { antes: before[0], despues: envio, user_id: req.user.id });
      if (ventaSincronizada) await audit('ventas', 'UPDATE', ventaSincronizada.id, { despues: ventaSincronizada, _origen: 'envio', user_id: req.user.id });
      if (ventaCancelada)    await audit('ventas', 'UPDATE', ventaCancelada.id,    { antes: ventaCancelada, despues: { ...ventaCancelada, estado: 'cancelado' }, _origen: 'envio', user_id: req.user.id });
      res.json(envio);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query(
      'SELECT * FROM envios WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Envío no encontrado' }); }

    // Revertir los ingresos de caja del envío
    await reverseCajaMovimientos(client, 'envios', id);

    // Si tiene venta asociada, hacer rollback financiero completo + soft-delete venta
    let ventaBorrada = null;
    if (before[0].venta_id) {
      const { rows: vrows } = await client.query('SELECT * FROM ventas WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [before[0].venta_id]);
      if (vrows[0]) {
        await revertirEfectosVenta(client, vrows[0]);
        await client.query('UPDATE ventas SET deleted_at = NOW() WHERE id = $1', [before[0].venta_id]);
        ventaBorrada = vrows[0];
      }
    }
    await client.query('UPDATE envios SET deleted_at = NOW() WHERE id = $1', [id]);
    await client.query('COMMIT');
    await audit('envios', 'DELETE', id, { antes: before[0], user_id: req.user.id });
    if (ventaBorrada) await audit('ventas', 'DELETE', ventaBorrada.id, { antes: ventaBorrada, _origen: 'envio', user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
