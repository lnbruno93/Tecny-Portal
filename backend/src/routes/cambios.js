// Módulo Cambios de Divisa — cuenta corriente con financieras de cambio.
// Dos lados: 'entrega_ars' (les damos pesos, egreso de una caja ARS) y
// 'recibo_usd' (nos devuelven dólares, ingreso a una caja USD). El saldo en USD
// muestra lo que la financiera todavía nos debe. Integrado al ledger (origen 'cambio').
// Montado en /api/cambios con requireAuth + requireCapability('cambios.trabajar') (app.js).
const router   = require('express').Router();
const db       = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { round2 } = require('../lib/money');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { createEntidadSchema, updateEntidadSchema, createMovimientoSchema } = require('../schemas/cambios');
const {
  parseIdempotencyKey,
  findExistingByIdempotencyKey,
  isIdempotencyConflict,
} = require('../lib/idempotency');

// saldo_usd por entidad: lo entregado (USD equiv) menos lo recibido = lo que nos deben.
const SALDO_SQL = `
  COALESCE(SUM(CASE WHEN m.tipo = 'entrega_ars' THEN m.monto_usd ELSE -m.monto_usd END), 0)`;

// Saldo agregado (USD) — consumido por 360 & Capital para sumar al patrimonio
// total lo que las financieras todavía nos deben (entregado − recibido). Una
// sola query, sin paginar.
router.get('/saldos-resumen', async (req, res, next) => {
  try {
    const saldo_usd = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${SALDO_SQL} AS saldo_usd
           FROM cambio_movimientos m
           JOIN cambio_entidades e ON e.id = m.entidad_id
          WHERE m.deleted_at IS NULL AND e.deleted_at IS NULL`
      );
      return Number(rows[0].saldo_usd || 0);
    });
    res.json({ saldo_usd });
  } catch (err) { next(err); }
});

// ─── ENTIDADES (financieras de cambio) ───────────────────────────────────────
router.get('/entidades', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT e.*,
                ${SALDO_SQL} AS saldo_usd,
                COALESCE(SUM(CASE WHEN m.tipo='entrega_ars' THEN m.monto_usd ELSE 0 END),0) AS entregado_usd,
                COALESCE(SUM(CASE WHEN m.tipo='recibo_usd'  THEN m.monto_usd ELSE 0 END),0) AS recibido_usd,
                COUNT(m.id) AS movimientos
           FROM cambio_entidades e
           LEFT JOIN cambio_movimientos m ON m.entidad_id = e.id AND m.deleted_at IS NULL
          WHERE e.deleted_at IS NULL
          GROUP BY e.id
          ORDER BY e.nombre`
      );
      return rows;
    });
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/entidades/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const data = await db.withTenant(req.tenantId, async (client) => {
      const { rows: e } = await client.query('SELECT * FROM cambio_entidades WHERE id = $1 AND deleted_at IS NULL', [id]);
      if (!e[0]) return { notFound: true };
      const { rows: tot } = await client.query(
        `SELECT ${SALDO_SQL} AS saldo_usd,
                COALESCE(SUM(CASE WHEN m.tipo='entrega_ars' THEN m.monto_usd ELSE 0 END),0) AS entregado_usd,
                COALESCE(SUM(CASE WHEN m.tipo='recibo_usd'  THEN m.monto_usd ELSE 0 END),0) AS recibido_usd,
                COUNT(m.id) AS movimientos
           FROM cambio_movimientos m WHERE m.entidad_id = $1 AND m.deleted_at IS NULL`, [id]
      );
      return { entidad: e[0], resumen: tot[0] };
    });
    if (data.notFound) return res.status(404).json({ error: 'Financiera no encontrada' });
    res.json({ ...data.entidad, resumen: data.resumen });
  } catch (err) { next(err); }
});

router.post('/entidades', validate(createEntidadSchema), async (req, res, next) => {
  try {
    const { nombre, activo } = req.body;
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'INSERT INTO cambio_entidades (nombre, activo) VALUES ($1,$2) RETURNING *', [nombre, activo]
      );
      await audit(client, 'cambio_entidades', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
      return rows[0];
    });
    res.status(201).json({ ...row, saldo_usd: 0, entregado_usd: 0, recibido_usd: 0, movimientos: 0 });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una financiera con ese nombre' });
    next(err);
  }
});

router.put('/entidades/:id', validate(updateEntidadSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { nombre, activo } = req.body;
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        `UPDATE cambio_entidades SET nombre = COALESCE($1, nombre), activo = COALESCE($2, activo)
          WHERE id = $3 AND deleted_at IS NULL RETURNING *`,
        [nombre ?? null, activo ?? null, id]
      );
      if (!rows[0]) return null;
      await audit(client, 'cambio_entidades', 'UPDATE', id, { despues: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Financiera no encontrada' });
    res.json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una financiera con ese nombre' });
    next(err);
  }
});

router.delete('/entidades/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const row = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(
        'UPDATE cambio_entidades SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
      );
      if (!rows[0]) return null;
      await audit(client, 'cambio_entidades', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
      return rows[0];
    });
    if (!row) return res.status(404).json({ error: 'Financiera no encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── MOVIMIENTOS ─────────────────────────────────────────────────────────────
router.get('/entidades/:id/movimientos', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });
    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query('SELECT COUNT(*) FROM cambio_movimientos WHERE entidad_id = $1 AND deleted_at IS NULL', [id]);
      const dataRes = await client.query(
        `SELECT m.*, mp.nombre AS caja_nombre
           FROM cambio_movimientos m
           LEFT JOIN metodos_pago mp ON mp.id = m.caja_id
          WHERE m.entidad_id = $1 AND m.deleted_at IS NULL
          ORDER BY m.fecha DESC, m.id DESC
          LIMIT $2 OFFSET $3`, [id, limit, offset]
      );
      return { count: parseInt(countRes.rows[0].count), dataRows: dataRes.rows };
    });
    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) { next(err); }
});

router.post('/movimientos', validate(createMovimientoSchema), async (req, res, next) => {
  // 2026-07-12 (auditoría TOTAL Financiero P1-1, Pattern G): Idempotency-Key.
  const idem = parseIdempotencyKey(req);
  if (idem.error) {
    return res.status(400).json({ error: idem.error, reason: 'idempotency_key_invalid' });
  }

  const client = await db.connect();
  try {
    const { entidad_id, fecha, tipo, monto_ars, tc, monto_usd, caja_id, comentarios } = req.body;
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // Idempotency replay antes de tocar entidad + caja.
    if (idem.key) {
      const existing = await findExistingByIdempotencyKey(client, 'cambio_movimientos', idem.key);
      if (existing) {
        await client.query('ROLLBACK');
        return res.status(200).json({ ...existing, idempotent_replay: true });
      }
    }

    const { rows: ent } = await client.query('SELECT id FROM cambio_entidades WHERE id = $1 AND deleted_at IS NULL', [entidad_id]);
    if (!ent[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Financiera no encontrada' }); }

    // Normaliza montos según el tipo y postea al ledger de la caja.
    //
    // 2026-07-12 (auditoría TOTAL Financiero P2-6, Pattern B multi-país UYU):
    // 4 tipos ahora — 2 pares (ARS/USD + UYU/USD). Mapping:
    //   entrega_ars   → egreso caja ARS (monto=ars, moneda=ARS, tc requerido)
    //   entrega_uyu   → egreso caja UYU (monto=ars, moneda=UYU, tc requerido)
    //                   NOTA: `monto_ars` es alias legacy — para tipos _uyu
    //                   contiene monto UYU. La columna se mantiene por compat
    //                   pero semánticamente es "monto local".
    //   recibo_usd    → ingreso caja USD (monto=usd, moneda=USD, sin tc)
    //   recibo_usd_uy → ingreso caja USD (monto=usd, moneda=USD, sin tc)
    //                   Diferenciado del recibo_usd por el par (UYU/USD vs ARS/USD)
    //                   para drilldown contable.
    let local = 0, usd = 0, ledgerMonto, ledgerMoneda, ledgerTipo;
    if (tipo === 'entrega_ars' || tipo === 'entrega_uyu') {
      local = round2(Number(monto_ars));
      usd = round2(local / Number(tc));      // USD equivalente que nos deben
      ledgerMonto = local;
      ledgerMoneda = tipo === 'entrega_ars' ? 'ARS' : 'UYU';
      ledgerTipo = 'egreso';
    } else { // recibo_usd o recibo_usd_uy
      usd = round2(Number(monto_usd));
      ledgerMonto = usd; ledgerMoneda = 'USD'; ledgerTipo = 'ingreso';
    }

    const { rows } = await client.query(
      `INSERT INTO cambio_movimientos (entidad_id, fecha, tipo, monto_ars, tc, monto_usd, caja_id, comentarios, user_id, client_generated_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [entidad_id, fecha, tipo, local, tc ?? null, usd, caja_id, comentarios ?? null, req.user.id, idem.key]
    );
    // Integrado al ledger: la moneda del movimiento debe coincidir con la de la caja
    // (postCajaMovimiento valida grupo de moneda y lanza 400 si no coincide).
    const isEntrega = (tipo === 'entrega_ars' || tipo === 'entrega_uyu');
    const conceptoMap = {
      entrega_ars:   'Cambio: entrega ARS',
      entrega_uyu:   'Cambio: entrega UYU',
      recibo_usd:    'Cambio: recibo USD',
      recibo_usd_uy: 'Cambio: recibo USD (UY)',
    };
    await postCajaMovimiento(client, {
      caja_id, fecha, tipo: ledgerTipo, monto: ledgerMonto, moneda: ledgerMoneda, tc: isEntrega ? tc : null,
      origen: 'cambio', ref_tabla: 'cambio_movimientos', ref_id: rows[0].id,
      concepto: conceptoMap[tipo] ?? `Cambio: ${tipo}`, user_id: req.user.id,
    });
    await audit(client, 'cambio_movimientos', 'INSERT', rows[0].id, { despues: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    // Race window Pattern G — UNIQUE atrapa al 2do concurrente.
    if (isIdempotencyConflict(err)) {
      return res.status(409).json({
        error: 'Otro request con la misma Idempotency-Key está en curso. Reintentá en un instante.',
        reason: 'idempotency_conflict',
      });
    }
    next(err);
  } finally { client.release(); }
});

router.delete('/movimientos/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2026-06-15 multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const { rows } = await client.query(
      'UPDATE cambio_movimientos SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *', [id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Movimiento no encontrado' }); }
    await reverseCajaMovimientos(client, 'cambio_movimientos', id);
    await audit(client, 'cambio_movimientos', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;
