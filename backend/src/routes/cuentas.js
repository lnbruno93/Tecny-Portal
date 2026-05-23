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
const {
  createClienteCCSchema,
  updateClienteCCSchema,
  createMovimientoCCSchema,
  TIPOS_MOVIMIENTO_CC,
} = require('../schemas/cuentas');

// Helper: SQL para calcular saldo de un cliente (subquery reutilizable)
const SALDO_SQL = `
  COALESCE((
    SELECT SUM(
      CASE WHEN tipo = 'compra'
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
    const filters = [];

    if (buscar) {
      params.push(`%${buscar}%`);
      filters.push(`(c.nombre ILIKE $${params.length} OR c.apellido ILIKE $${params.length} OR c.contacto ILIKE $${params.length})`);
    }
    if (categoria) {
      params.push(categoria);
      filters.push(`c.categoria = $${params.length}`);
    }

    const where = filters.length ? ` AND ${filters.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT c.*, ${SALDO_SQL} AS saldo
       FROM clientes_cc c
       WHERE c.deleted_at IS NULL${where}
       ORDER BY c.nombre, c.apellido
       LIMIT 500`,
      params
    );
    res.json(rows);
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
  try {
    const { nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas } = req.body;
    const { rows } = await db.query(
      `INSERT INTO clientes_cc
         (nombre, apellido, contacto, marca_redes, provincia, localidad, direccion, categoria, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [nombre, apellido ?? null, contacto ?? null, marca_redes ?? null,
       provincia ?? null, localidad ?? null, direccion ?? null, categoria, notas ?? null]
    );
    await audit('clientes_cc', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    res.status(201).json({ ...rows[0], saldo: 0 });
  } catch (err) {
    next(err);
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

    // Movimientos del cliente (sin paginación — la cuenta puede ser larga pero raramente >500)
    const { rows: movs } = await db.query(
      `SELECT * FROM movimientos_cc
       WHERE cliente_cc_id = $1 AND deleted_at IS NULL
       ORDER BY fecha DESC, id DESC
       LIMIT 500`,
      [id]
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
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/movimientos', validate(createMovimientoCCSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const {
      cliente_cc_id, fecha, tipo, descripcion, monto_total, notas,
      items = [],
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
         (cliente_cc_id, fecha, tipo, descripcion, monto_total, notas)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [cliente_cc_id, fecha, tipo, descripcion ?? null, monto_total, notas ?? null]
    );
    const mov = movRows[0];

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

    await client.query('COMMIT');

    await audit('movimientos_cc', 'INSERT', mov.id, {
      despues: { ...mov, items: insertedItems },
      user_id: req.user.id,
    });

    res.status(201).json({ ...mov, items: insertedItems });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/movimientos/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    const { rows } = await db.query(
      'UPDATE movimientos_cc SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Movimiento no encontrado' });
    await audit('movimientos_cc', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
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
         COALESCE(SUM(CASE WHEN tipo = 'compra' THEN monto_total ELSE -monto_total END), 0)  AS saldo,
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
    // Una sola query CTE: calcula saldos una vez, los agrega y extrae top-10
    const { rows } = await db.query(`
      WITH saldos AS (
        SELECT
          c.id, c.nombre, c.apellido, c.categoria,
          COALESCE(SUM(
            CASE WHEN m.tipo = 'compra' THEN m.monto_total ELSE -m.monto_total END
          ), 0) AS saldo
        FROM clientes_cc c
        LEFT JOIN movimientos_cc m
               ON m.cliente_cc_id = c.id AND m.deleted_at IS NULL
        WHERE c.deleted_at IS NULL
        GROUP BY c.id, c.nombre, c.apellido, c.categoria
      )
      SELECT
        COUNT(*)::int                                                                 AS cant_clientes,
        COALESCE(SUM(CASE WHEN saldo > 0 THEN saldo  ELSE 0 END), 0)                 AS total_deuda,
        COALESCE(SUM(CASE WHEN saldo < 0 THEN -saldo ELSE 0 END), 0)                 AS total_credito,
        COALESCE(SUM(saldo), 0)                                                       AS neto,
        COALESCE(
          (SELECT json_agg(t ORDER BY t.saldo DESC)
           FROM (SELECT id, nombre, apellido, categoria, saldo FROM saldos WHERE saldo > 0 ORDER BY saldo DESC LIMIT 10) t),
          '[]'::json
        )                                                                             AS top_deudores
      FROM saldos
    `);

    res.json(rows[0]);
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
