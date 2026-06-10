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
// La moneda del pago se respeta (debe coincidir con el grupo de la caja; lo valida
// postCajaMovimiento). TC opcional, útil para calcular monto_usd cuando moneda='ARS'.
async function syncEnvioCaja(client, envioId, fecha, estado, userId) {
  await reverseCajaMovimientos(client, 'envios', envioId);
  if (estado === 'Cancelado') return;
  const { rows: pagos } = await client.query(
    `SELECT metodo_pago_id, monto, moneda, tc FROM envio_items
      WHERE envio_id = $1 AND tipo = 'pago' AND metodo_pago_id IS NOT NULL AND monto > 0`,
    [envioId]
  );
  for (const p of pagos) {
    await postCajaMovimiento(client, {
      caja_id: p.metodo_pago_id, fecha, tipo: 'ingreso',
      monto: p.monto, moneda: p.moneda || 'ARS', tc: p.tc ?? null,
      origen: 'envio', ref_tabla: 'envios', ref_id: envioId,
      concepto: `Cobro envío #${envioId}`, user_id: userId,
    });
  }
}

// Inserta los items del envío (incluye producto_id, moneda, tc y es_cuenta_corriente).
async function insertarItems(client, envioId, items) {
  for (const item of items || []) {
    await client.query(
      `INSERT INTO envio_items (envio_id, tipo, descripcion, monto, metodo_pago, metodo_pago_id, producto_id, moneda, tc, es_cuenta_corriente)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [envioId, item.tipo, item.descripcion ?? null, item.monto,
       item.metodo_pago ?? null, item.metodo_pago_id ?? null, item.producto_id ?? null,
       item.moneda || 'ARS', item.tc ?? null, !!item.es_cuenta_corriente]
    );
  }
}

// Validación de pagos: CC y financiera/tarjeta requieren registrar_venta=true
// (la venta es la única fuente de verdad para esos efectos secundarios).
async function validarPagosAvanzados(client, items, registrarVenta, clienteCcId) {
  const pagos = (items || []).filter(i => i.tipo === 'pago');
  const usaCC = pagos.some(p => p.es_cuenta_corriente);
  if (usaCC && !registrarVenta) {
    const e = new Error('Para usar Cuenta Corriente como método de pago, marcá "Registrar como venta".'); e.status = 400; throw e;
  }
  if (usaCC && !clienteCcId) {
    const e = new Error('Para un pago en cuenta corriente, elegí un cliente con cuenta corriente.'); e.status = 400; throw e;
  }
  const cajaIds = pagos.map(p => p.metodo_pago_id).filter(Boolean);
  if (cajaIds.length) {
    // Defense-in-depth: filtramos cajas borradas (soft-delete) acá
    // explícitamente — sino `usaFinTar` se calcula sobre cajas históricas
    // borradas, y aunque postCajaMovimiento rechazaría después con error
    // técnico ("la caja no existe"), preferimos detectar acá y dar mensaje
    // claro. Auditoría 2026-06-06 Sol M1.
    const { rows } = await client.query(
      'SELECT id, es_financiera, es_tarjeta FROM metodos_pago WHERE id = ANY($1::int[]) AND deleted_at IS NULL',
      [cajaIds]
    );
    const usaFinTar = rows.some(c => c.es_financiera || c.es_tarjeta);
    if (usaFinTar && !registrarVenta) {
      const e = new Error('Para usar una caja Financiera o Tarjeta, marcá "Registrar como venta".'); e.status = 400; throw e;
    }
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
      costo_envio, total_cobrado, horario, operador, notas, estado, prioridad, tc, cliente_cc_id, items, registrar_venta,
    } = req.body;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Validar combinaciones avanzadas de pagos ANTES de tocar nada.
      await validarPagosAvanzados(client, items, registrar_venta, cliente_cc_id);

      const { rows } = await client.query(
        `INSERT INTO envios (fecha, cliente, telefono, direccion, barrio, costo_envio, total_cobrado, horario, operador, notas, estado, prioridad, tc, cliente_cc_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [fecha, cliente, telefono ?? null, direccion, barrio ?? null, costo_envio, total_cobrado,
         horario ?? null, operador ?? null, notas ?? null, estado, prioridad ?? null, tc ?? null, cliente_cc_id ?? null]
      );
      const envio = rows[0];

      await insertarItems(client, envio.id, items);

      // Si NO hay registrar_venta, el envío postea directo a caja (solo cajas regulares).
      // Si SÍ hay registrar_venta, la venta auto-creada maneja TODA la sincronización
      // financiera (caja, CC, financiera, tarjeta), así no duplicamos ingresos.
      //
      // 2026-06-10 — Edge case: registrar_venta=true pero items sin productos
      // linkeados (solo pagos). crearVentaDesdeEnvio devuelve null porque la
      // venta exige al menos un 'producto'. Antes, los pagos quedaban
      // huérfanos (ni venta ni caja). Ahora caemos al syncEnvioCaja para no
      // perder el ingreso del cobro. Pasa típicamente con envíos "de cobro
      // suelto" cuando el frontend pasó a forzar siempre registrar_venta=true.
      let ventaCreada = null;
      if (registrar_venta) {
        ventaCreada = await crearVentaDesdeEnvio(client, envio, items, req.user.id);
        if (ventaCreada) {
          await client.query('UPDATE envios SET venta_id = $1 WHERE id = $2', [ventaCreada.id, envio.id]);
          envio.venta_id = ventaCreada.id;
        } else {
          // No se creó venta (sin productos linkeados) — postear pagos a caja directo.
          await syncEnvioCaja(client, envio.id, envio.fecha, envio.estado, req.user.id);
        }
      } else {
        await syncEnvioCaja(client, envio.id, envio.fecha, envio.estado, req.user.id);
      }
      await audit(client, 'envios', 'INSERT', envio.id, { despues: envio, user_id: req.user.id });
      if (ventaCreada) await audit(client, 'ventas', 'INSERT', ventaCreada.id, { despues: ventaCreada, _origen: 'envio', user_id: req.user.id });
      await client.query('COMMIT');
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
    costo_envio, total_cobrado, horario, operador, notas, estado, prioridad, tc, cliente_cc_id, items,
  } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock de la fila dentro de la tx para serializar ediciones concurrentes
    const { rows: before } = await client.query(
      'SELECT * FROM envios WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Envío no encontrado' }); }

    // Validar pagos avanzados con el estado efectivo (registrar_venta lo derivamos
    // del estado actual: si ya tiene venta_id O si se quiere crearla con CC/fin/tarj).
    if (items !== undefined) {
      const tieneVenta = !!before[0].venta_id;
      const effClienteCc = cliente_cc_id !== undefined ? cliente_cc_id : before[0].cliente_cc_id;
      await validarPagosAvanzados(client, items, tieneVenta, effClienteCc);
    }

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
          tc            = COALESCE($13, tc),
          cliente_cc_id = COALESCE($14, cliente_cc_id)
        WHERE id = $15 RETURNING *`,
        [fecha, cliente, telefono, direccion, barrio, costo_envio, total_cobrado,
         horario, operador, notas, estado, prioridad, tc, cliente_cc_id, id]
      );
      const envio = rows[0];

      let ventaSincronizada = null;
      if (items !== undefined) {
        await client.query('DELETE FROM envio_items WHERE envio_id = $1', [id]);
        await insertarItems(client, id, items);
        // Si hay venta asociada y no se canceló, sincronizar venta_items, venta_pagos y stock.
        if (envio.venta_id && envio.estado !== 'Cancelado') {
          ventaSincronizada = await actualizarVentaDesdeEnvio(client, envio, items, req.user.id);
        }
      }
      // Si NO hay venta_id (envío standalone), el envío sigue posteando directo a caja.
      // Si hay venta_id, la venta ya sincronizó (en actualizarVentaDesdeEnvio).
      if (!envio.venta_id) {
        await syncEnvioCaja(client, id, envio.fecha, envio.estado, req.user.id);
      } else {
        // Limpiar cualquier ingreso 'envios' que hubiera quedado de la era pre-venta
        await reverseCajaMovimientos(client, 'envios', id);
      }

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

      // 2026-06-10 — Sincronizar estado de la venta cuando cambia el del envío
      // (sin pasar por el endpoint /confirmar-entrega): Entregado → 'acreditado',
      // cualquier otro estado activo (Pendiente/En camino) → 'pendiente'. Cancelado
      // ya se maneja arriba. Sólo si hay venta y no estamos en el flujo Cancelado.
      let ventaEstadoSincronizado = null;
      if (
        envio.venta_id &&
        envio.estado !== 'Cancelado' &&
        before[0].estado !== envio.estado
      ) {
        const nuevoEstadoVenta = envio.estado === 'Entregado' ? 'acreditado' : 'pendiente';
        const { rows: vrows } = await client.query(
          `UPDATE ventas SET estado = $1
             WHERE id = $2 AND deleted_at IS NULL AND estado <> 'cancelado' AND estado <> $1
           RETURNING *`,
          [nuevoEstadoVenta, envio.venta_id]
        );
        if (vrows[0]) ventaEstadoSincronizado = vrows[0];
      }

      await audit(client, 'envios', 'UPDATE', id, { antes: before[0], despues: envio, user_id: req.user.id });
      if (ventaSincronizada) await audit(client, 'ventas', 'UPDATE', ventaSincronizada.id, { despues: ventaSincronizada, _origen: 'envio', user_id: req.user.id });
      if (ventaEstadoSincronizado) await audit(client, 'ventas', 'UPDATE', ventaEstadoSincronizado.id, { despues: ventaEstadoSincronizado, _origen: 'envio', user_id: req.user.id });
      if (ventaCancelada)    await audit(client, 'ventas', 'UPDATE', ventaCancelada.id,    { antes: ventaCancelada, despues: { ...ventaCancelada, estado: 'cancelado' }, _origen: 'envio', user_id: req.user.id });
      await client.query('COMMIT');
      res.json(envio);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /:id/confirmar-entrega — atajo desde el dashboard de ventas. En una TX:
//   1. Pasa el envío a estado 'Entregado'.
//   2. Si tiene venta asociada, la pasa de 'pendiente' → 'acreditado'.
//
// Idempotente: si el envío ya está 'Entregado' devuelve 200 con el estado actual.
// Si el envío fue cancelado, rechaza con 400 (no hay nada que entregar).
//
// 2026-06-10 — Pedido por Lucas: el operador quiere un click directo desde la
// grilla unificada de ventas para marcar la entrega de un envío y que, en el
// mismo movimiento, la venta entre al neto del día. Antes había que abrir el
// modal de envíos, cambiar el estado a 'Entregado' y guardar.
router.post('/:id/confirmar-entrega', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: before } = await client.query(
      'SELECT * FROM envios WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!before[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Envío no encontrado' }); }
    if (before[0].estado === 'Cancelado') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El envío está cancelado, no se puede entregar' });
    }

    let envio = before[0];
    let ventaActualizada = null;

    if (before[0].estado !== 'Entregado') {
      const { rows } = await client.query(
        `UPDATE envios SET estado = 'Entregado' WHERE id = $1 RETURNING *`, [id]
      );
      envio = rows[0];
      await audit(client, 'envios', 'UPDATE', id, { antes: before[0], despues: envio, user_id: req.user.id });
    }

    if (envio.venta_id) {
      const { rows: vrows } = await client.query(
        `UPDATE ventas SET estado = 'acreditado'
           WHERE id = $1 AND deleted_at IS NULL AND estado <> 'cancelado' AND estado <> 'acreditado'
         RETURNING *`,
        [envio.venta_id]
      );
      if (vrows[0]) {
        ventaActualizada = vrows[0];
        await audit(client, 'ventas', 'UPDATE', vrows[0].id, { despues: vrows[0], _origen: 'envio', user_id: req.user.id });
      }
    }

    await client.query('COMMIT');
    res.json({ envio, venta: ventaActualizada });
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
    await audit(client, 'envios', 'DELETE', id, { antes: before[0], user_id: req.user.id });
    if (ventaBorrada) await audit(client, 'ventas', 'DELETE', ventaBorrada.id, { antes: ventaBorrada, _origen: 'envio', user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
