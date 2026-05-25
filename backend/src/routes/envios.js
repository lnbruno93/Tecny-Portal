const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const audit = require('../lib/audit');
const { createEnvioSchema, updateEnvioSchema, queryEnviosSchema } = require('../schemas/envios');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const parseId = require('../lib/parseId');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');

// Sincroniza el impacto de un envío en el ledger de cajas: revierte los ingresos
// previos y, si el envío no está cancelado, re-postea un ingreso por cada item
// 'pago' que tenga una caja asignada (metodo_pago_id). Idempotente.
async function syncEnvioCaja(client, envioId, fecha, estado, userId) {
  await reverseCajaMovimientos(client, 'envios', envioId);
  if (estado === 'Cancelado') return;
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
    const total = parseInt(countRes.rows[0].count);
    res.json(paginatedResponse(dataRes.rows.map(r => ({ ...r, items: r.items || [] })), total, { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/', validate(createEnvioSchema), async (req, res, next) => {
  try {
    const {
      fecha, cliente, telefono, direccion, barrio,
      costo_envio, total_cobrado, horario, operador, notas, estado, prioridad, items,
    } = req.body;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO envios (fecha, cliente, telefono, direccion, barrio, costo_envio, total_cobrado, horario, operador, notas, estado, prioridad)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [fecha, cliente, telefono ?? null, direccion, barrio ?? null, costo_envio, total_cobrado,
         horario ?? null, operador ?? null, notas ?? null, estado, prioridad ?? null]
      );
      const envio = rows[0];

      for (const item of items) {
        await client.query(
          'INSERT INTO envio_items (envio_id, tipo, descripcion, monto, metodo_pago, metodo_pago_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [envio.id, item.tipo, item.descripcion ?? null, item.monto, item.metodo_pago ?? null, item.metodo_pago_id ?? null]
        );
      }
      await syncEnvioCaja(client, envio.id, envio.fecha, envio.estado, req.user.id);
      await client.query('COMMIT');
      await audit('envios', 'INSERT', envio.id, { despues: envio, user_id: req.user.id });
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
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows: before } = await db.query(
      'SELECT * FROM envios WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!before[0]) return res.status(404).json({ error: 'Envío no encontrado' });

    const {
      fecha, cliente, telefono, direccion, barrio,
      costo_envio, total_cobrado, horario, operador, notas, estado, prioridad, items,
    } = req.body;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
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
          prioridad     = COALESCE($12, prioridad)
        WHERE id = $13 RETURNING *`,
        [fecha, cliente, telefono, direccion, barrio, costo_envio, total_cobrado,
         horario, operador, notas, estado, prioridad, id]
      );

      if (items !== undefined) {
        await client.query('DELETE FROM envio_items WHERE envio_id = $1', [id]);
        for (const item of items) {
          await client.query(
            'INSERT INTO envio_items (envio_id, tipo, descripcion, monto, metodo_pago, metodo_pago_id) VALUES ($1,$2,$3,$4,$5,$6)',
            [id, item.tipo, item.descripcion ?? null, item.monto, item.metodo_pago ?? null, item.metodo_pago_id ?? null]
          );
        }
      }
      // Recalcular el impacto en caja (cambió la lista de pagos y/o el estado)
      await syncEnvioCaja(client, id, rows[0].fecha, rows[0].estado, req.user.id);
      await client.query('COMMIT');
      await audit('envios', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
      res.json(rows[0]);
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

router.delete('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE envios SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Envío no encontrado' }); }
    // Revertir los ingresos de caja asociados a este envío
    await reverseCajaMovimientos(client, 'envios', id);
    await client.query('COMMIT');
    await audit('envios', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
