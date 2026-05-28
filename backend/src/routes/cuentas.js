/**
 * Rutas del módulo Cuentas Corrientes (CC)
 *
 * Clientes:
 *   GET    /clientes            — lista con saldo calculado
 *   GET    /clientes/:id        — detalle + saldo
 *   POST   /clientes            — crear
 *   PUT    /clientes/:id        — actualizar
 *   DELETE /clientes/:id        — soft delete
 *
 * Movimientos:
 *   GET    /clientes/:id/movimientos  — historial de un cliente (con items)
 *   POST   /movimientos               — crear movimiento (+ items para compra/devolucion)
 *   DELETE /movimientos/:id           — soft delete (items se eliminan en cascada)
 *
 * Saldo = SUM(compra) - SUM(pago + devolucion + parte_de_pago + entrega_mercaderia)
 * Saldo positivo → el cliente nos debe dinero.
 */

const router  = require('express').Router();
const db      = require('../config/database');
const validate  = require('../lib/validate');
const audit     = require('../lib/audit');
const parseId   = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const {
  createClienteCCSchema,
  updateClienteCCSchema,
  createMovimientoCCSchema,
} = require('../schemas/cuentas');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { syncContactoSafe } = require('../lib/contactosSync');

// Helper: SQL para calcular saldo de un cliente (subquery reutilizable — usada solo en GET /:id)
// Para el listado usamos un JOIN en lugar de subquery correlacionada (ver abajo).
const SALDO_SQL = `
  COALESCE((
    SELECT SUM(
      CASE WHEN tipo IN ('compra', 'saldo_inicial')
           THEN  monto_total
           ELSE -monto_total
      END
    )
    FROM movimientos_cc
    WHERE cliente_cc_id = c.id AND deleted_at IS NULL
  ), 0)
`;

// ─── CLIENTES ────────────────────────────────────────────────────────────────

router.get('/clientes', async (req, res, next) => {
  try {
    const { buscar, categoria } = req.query;
    const params  = [];
    const filters = ['c.deleted_at IS NULL'];

    if (buscar) {
      params.push(`%${buscar}%`);
      filters.push(`(c.nombre ILIKE $${params.length} OR c.apellido ILIKE $${params.length} OR c.contacto ILIKE $${params.length})`);
    }
    if (categoria) {
      params.push(categoria);
      filters.push(`c.categoria = $${params.length}`);
    }

    const where = filters.join(' AND ');
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    // JOIN en lugar de subquery correlacionada — calcula todos los saldos en un solo pase
    // antes: 1 + N queries (una por cliente). Ahora: siempre 1 query total.
    const [countRes, dataRes] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM clientes_cc c WHERE ${where}`, params),
      db.query(
        `SELECT c.*,
                COALESCE(s.saldo, 0) AS saldo
         FROM clientes_cc c
         LEFT JOIN (
           SELECT cliente_cc_id,
                  SUM(CASE WHEN tipo IN ('compra', 'saldo_inicial') THEN monto_total ELSE -monto_total END) AS saldo
           FROM movimientos_cc
           WHERE deleted_at IS NULL
           GROUP BY cliente_cc_id
         ) s ON s.cliente_cc_id = c.id
         WHERE ${where}
         ORDER BY c.nombre, c.apellido
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    res.json(paginatedResponse(dataRes.rows, parseInt(countRes.rows[0].count), { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.get('/clientes/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      `SELECT c.*, ${SALDO_SQL} AS saldo
       FROM clientes_cc c
       WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/clientes', validate(createClienteCCSchema), async (req, res, next) => {
  const { nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas, saldo_inicial } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO clientes_cc
         (nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [nombre, apellido ?? null, contacto ?? null, marca_redes ?? null,
       provincia ?? null, localidad ?? null, direccion ?? null, categoria, notas ?? null]
    );
    const cliente = rows[0];

    // Saldo de apertura: movimiento 'saldo_inicial' (suma como compra → el cliente nos debe)
    const saldo = Number(saldo_inicial) || 0;
    if (saldo > 0) {
      await client.query(
        `INSERT INTO movimientos_cc (cliente_cc_id, fecha, tipo, descripcion, monto_total)
         VALUES ($1, CURRENT_DATE, 'saldo_inicial', 'Saldo inicial', $2)`,
        [cliente.id, saldo]
      );
    }
    await audit(client, 'clientes_cc', 'INSERT', cliente.id, { despues: { ...cliente, saldo_inicial: saldo }, user_id: req.user.id });
    await client.query('COMMIT');
    // Agenda central (best-effort, fuera de la transacción)
    await syncContactoSafe(db, {
      origen: 'b2b', ref_tabla: 'clientes_cc', ref_id: cliente.id,
      nombre: cliente.nombre, apellido: cliente.apellido, telefono: cliente.contacto,
    });
    res.status(201).json({ ...cliente, saldo });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/clientes/:id', validate(updateClienteCCSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows: before } = await db.query(
      'SELECT * FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!before[0]) return res.status(404).json({ error: 'Cliente no encontrado' });

    const { nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas } = req.body;
    const { rows } = await db.query(
      `UPDATE clientes_cc SET
         nombre      = COALESCE($1,  nombre),
         apellido    = COALESCE($2,  apellido),
         contacto    = COALESCE($3,  contacto),
         marca_redes = COALESCE($4,  marca_redes),
         provincia   = COALESCE($5,  provincia),
         localidad   = COALESCE($6,  localidad),
         direccion   = COALESCE($7,  direccion),
         categoria   = COALESCE($8,  categoria),
         notas       = COALESCE($9,  notas)
       WHERE id = $10 RETURNING *`,
      [nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas, id]
    );
    await audit('clientes_cc', 'UPDATE', id, { antes: before[0], despues: rows[0], user_id: req.user.id });
    // Agenda central (best-effort)
    await syncContactoSafe(db, {
      origen: 'b2b', ref_tabla: 'clientes_cc', ref_id: rows[0].id,
      nombre: rows[0].nombre, apellido: rows[0].apellido, telefono: rows[0].contacto,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/clientes/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      'UPDATE clientes_cc SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
    await audit('clientes_cc', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── MOVIMIENTOS ─────────────────────────────────────────────────────────────

router.get('/clientes/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    // Verificar que el cliente existe
    const { rows: c } = await db.query(
      'SELECT id FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!c[0]) return res.status(404).json({ error: 'Cliente no encontrado' });

    // Movimientos del cliente (paginado — una cuenta activa puede tener miles)
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) FROM movimientos_cc WHERE cliente_cc_id = $1 AND deleted_at IS NULL', [id]
    );
    const { rows: movs } = await db.query(
      `SELECT * FROM movimientos_cc
       WHERE cliente_cc_id = $1 AND deleted_at IS NULL
       ORDER BY fecha DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    // Items de todos los movimientos, traídos en una sola query
    const movIds = movs.map(m => m.id);
    let items = [];
    if (movIds.length) {
      const { rows } = await db.query(
        `SELECT * FROM items_movimiento_cc
         WHERE movimiento_cc_id = ANY($1)
         ORDER BY id`,
        [movIds]
      );
      items = rows;
    }

    // Adjuntar items a cada movimiento
    const itemsByMov = {};
    items.forEach(item => {
      if (!itemsByMov[item.movimiento_cc_id]) itemsByMov[item.movimiento_cc_id] = [];
      itemsByMov[item.movimiento_cc_id].push(item);
    });

    const result = movs.map(m => ({ ...m, items: itemsByMov[m.id] || [] }));
    res.json(paginatedResponse(result, parseInt(countRows[0].count), { page, limit }));
  } catch (err) {
    next(err);
  }
});

router.post('/movimientos', validate(createMovimientoCCSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const {
      cliente_cc_id, fecha, tipo, descripcion, monto_total, notas,
      caja_id, items = [],
    } = req.body;

    await client.query('BEGIN');

    // Verificar que el cliente existe (dentro de la tx, con FOR UPDATE para evitar race condition)
    const { rows: c } = await client.query(
      'SELECT id FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [cliente_cc_id]
    );
    if (!c[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Insertar movimiento
    const { rows: movRows } = await client.query(
      `INSERT INTO movimientos_cc
         (cliente_cc_id, fecha, tipo, descripcion, monto_total, notas, caja_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [cliente_cc_id, fecha, tipo, descripcion ?? null, monto_total, notas ?? null, caja_id ?? null]
    );
    const mov = movRows[0];

    // Un PAGO del cliente mayorista (pago / parte_de_pago) ingresa a una caja.
    // monto_total ya está normalizado en USD por la UI.
    if (['pago', 'parte_de_pago'].includes(tipo) && caja_id) {
      await postCajaMovimiento(client, {
        caja_id, fecha, tipo: 'ingreso', monto: monto_total, moneda: 'USD', tc: null,
        origen: 'b2b', ref_tabla: 'movimientos_cc', ref_id: mov.id,
        concepto: `Pago B2B #${cliente_cc_id}`, user_id: req.user.id,
      });
    }

    // Insertar items solo para compra/devolucion (ignorar el resto)
    let insertedItems = [];
    const tiposConItems = ['compra', 'devolucion'];
    if (tiposConItems.includes(tipo) && items.length > 0) {
      for (const item of items) {
        const { rows: itemRows } = await client.query(
          `INSERT INTO items_movimiento_cc
             (movimiento_cc_id, producto, modelo, tamano, color, imei_serial, valor, verificado, notas)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [
            mov.id,
            item.producto    ?? null,
            item.modelo      ?? null,
            item.tamano      ?? null,
            item.color       ?? null,
            item.imei_serial ?? null,
            item.valor       ?? null,
            item.verificado  ?? false,
            item.notas       ?? null,
          ]
        );
        insertedItems.push(itemRows[0]);
      }
    }

    await audit(client, 'movimientos_cc', 'INSERT', mov.id, {
      despues: { ...mov, items: insertedItems },
      user_id: req.user.id,
    });
    await client.query('COMMIT');

    res.status(201).json({ ...mov, items: insertedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/movimientos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE movimientos_cc SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    // Revertir el ingreso de caja asociado (si lo hubo)
    await reverseCajaMovimientos(client, 'movimientos_cc', id);
    await audit(client, 'movimientos_cc', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── RESUMEN DE CUENTA ────────────────────────────────────────────────────────
// Totales desglosados por tipo para el header del detalle de cuenta

router.get('/clientes/:id/resumen', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows: c } = await db.query(
      'SELECT * FROM clientes_cc WHERE id = $1 AND deleted_at IS NULL', [id]
    );
    if (!c[0]) return res.status(404).json({ error: 'Cliente no encontrado' });

    const { rows } = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tipo = 'compra'             THEN monto_total ELSE 0 END), 0) AS total_compras,
         COALESCE(SUM(CASE WHEN tipo = 'pago'               THEN monto_total ELSE 0 END), 0) AS total_pagos,
         COALESCE(SUM(CASE WHEN tipo = 'devolucion'         THEN monto_total ELSE 0 END), 0) AS total_devoluciones,
         COALESCE(SUM(CASE WHEN tipo = 'parte_de_pago'      THEN monto_total ELSE 0 END), 0) AS total_parte_de_pago,
         COALESCE(SUM(CASE WHEN tipo = 'entrega_mercaderia' THEN monto_total ELSE 0 END), 0) AS total_entrega_mercaderia,
         COALESCE(SUM(CASE WHEN tipo = 'saldo_inicial'      THEN monto_total ELSE 0 END), 0) AS total_saldo_inicial,
         COALESCE(SUM(CASE WHEN tipo IN ('compra', 'saldo_inicial') THEN monto_total ELSE -monto_total END), 0)  AS saldo,
         COUNT(*) FILTER (WHERE tipo = 'compra') AS cant_compras,
         COUNT(*)                                AS cant_movimientos
       FROM movimientos_cc
       WHERE cliente_cc_id = $1 AND deleted_at IS NULL`,
      [id]
    );

    res.json({ cliente: c[0], ...rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /resumen-general — métricas globales de todas las CC
router.get('/resumen-general', async (req, res, next) => {
  try {
    // CTE compartida: calcula saldos una sola vez para totales y top-10
    const BASE_CTE = `
      WITH saldos AS (
        SELECT
          c.id, c.nombre, c.apellido, c.categoria,
          COALESCE(SUM(
            CASE WHEN m.tipo IN ('compra', 'saldo_inicial') THEN m.monto_total ELSE -m.monto_total END
          ), 0) AS saldo
        FROM clientes_cc c
        LEFT JOIN movimientos_cc m
               ON m.cliente_cc_id = c.id AND m.deleted_at IS NULL
        WHERE c.deleted_at IS NULL
        GROUP BY c.id, c.nombre, c.apellido, c.categoria
      )
    `;

    const [{ rows: totals }, { rows: top }] = await Promise.all([
      db.query(BASE_CTE + `
        SELECT
          COUNT(*)::int                                                   AS cant_clientes,
          COALESCE(SUM(CASE WHEN saldo > 0 THEN saldo  ELSE 0 END), 0)   AS total_deuda,
          COALESCE(SUM(CASE WHEN saldo < 0 THEN -saldo ELSE 0 END), 0)   AS total_credito,
          COALESCE(SUM(saldo), 0)                                         AS neto
        FROM saldos
      `),
      db.query(BASE_CTE + `
        SELECT id, nombre, apellido, categoria, saldo
        FROM saldos
        WHERE saldo > 0
        ORDER BY saldo DESC
        LIMIT 10
      `),
    ]);

    res.json({ ...totals[0], top_deudores: top });
  } catch (err) { next(err); }
});

// GET /calendario?mes=2026-05 — movimientos agrupados por día para el calendario
router.get('/calendario', async (req, res, next) => {
  try {
    const mes = req.query.mes || new Date().toISOString().substring(0, 7);
    // Validate mes format
    if (!/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ error: 'Formato de mes inválido (YYYY-MM)' });

    const { rows } = await db.query(`
      SELECT
        fecha::date                                                                                AS dia,
        COALESCE(SUM(CASE WHEN tipo = 'compra'                         THEN monto_total ELSE 0 END), 0) AS compras,
        COALESCE(SUM(CASE WHEN tipo IN ('pago','parte_de_pago','entrega_mercaderia') THEN monto_total ELSE 0 END), 0) AS pagos,
        COALESCE(SUM(CASE WHEN tipo = 'devolucion'                     THEN monto_total ELSE 0 END), 0) AS devoluciones,
        COUNT(*)::int                                                                              AS cant
      FROM movimientos_cc
      WHERE DATE_TRUNC('month', fecha) = DATE_TRUNC('month', ($1 || '-01')::date)
        AND deleted_at IS NULL
      GROUP BY fecha::date
      ORDER BY fecha::date
    `, [mes]);

    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
