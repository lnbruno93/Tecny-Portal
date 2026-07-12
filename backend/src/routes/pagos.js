const router = require('express').Router();
const db = require('../config/database');
const validate = require('../lib/validate');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { createPagoSchema, queryPagosSchema } = require('../schemas/pagos');
const parseId = require('../lib/parseId');
const audit  = require('../lib/audit');
const { postCajaMovimiento, reverseCajaMovimientos, grupoMoneda } = require('../lib/cajaLedger');
const { postCajaMovimientoFinanciera } = require('../lib/financiera');

// 2026-07-12 (auditoría TOTAL Financiero P3-6): removida versión local
// (drift) — ahora importamos el canónico de cajaLedger que soporta UYU
// (3 grupos: ARS, UYU, USD).

// ─── Totales globales ─────────────────────────────────────────────────────────
router.get('/totales', async (req, res, next) => {
  try {
    const rows = await db.withTenant(req.tenantId, async (client) => {
      const { rows } = await client.query(`
        SELECT COUNT(*) AS count, COALESCE(SUM(monto), 0) AS total_monto
        FROM pagos WHERE deleted_at IS NULL
      `);
      return rows;
    });
    res.json({
      count:       parseInt(rows[0].count),
      total_monto: parseFloat(rows[0].total_monto),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Lista paginada ───────────────────────────────────────────────────────────
router.get('/', validate(queryPagosSchema, 'query'), async (req, res, next) => {
  try {
    const { desde, hasta, buscar } = req.query;
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 100 });

    const conditions = ['deleted_at IS NULL'];
    const params = [];

    if (desde)  { params.push(desde);          conditions.push(`fecha >= $${params.length}`); }
    if (hasta)  { params.push(hasta);           conditions.push(`fecha <= $${params.length}`); }
    if (buscar) { params.push(`%${buscar}%`);   conditions.push(`referencia ILIKE $${params.length}`); }

    const where = conditions.join(' AND ');

    const { countRes, dataRes } = await db.withTenant(req.tenantId, async (client) => {
      const countRes = await client.query(`SELECT COUNT(*) FROM pagos WHERE ${where}`, params);
      const dataRes = await client.query(
        `SELECT * FROM pagos WHERE ${where} ORDER BY fecha DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      return { countRes, dataRes };
    });

    const total = parseInt(countRes.rows[0].count);
    res.json(paginatedResponse(dataRes.rows, total, { page, limit }));
  } catch (err) {
    next(err);
  }
});

// ─── Crear ────────────────────────────────────────────────────────────────────
// Pago de financiera (junio 2026, espejo de liquidación de tarjetas):
//   · `monto` (ARS) descuenta del saldo pendiente con la financiera
//     (sum(comprobantes.neto) − sum(pagos.monto)).
//   · `caja_id` es la caja real donde entra el dinero — desde ahora es
//     obligatoria. La caja recibe ARS o USD según convertir_usd.
//   · Si convertir_usd: la caja debe ser USD/USDT, ingresa `monto_usd`
//     con tc guardado en el mov para reverso sin drift.
//   · Si NO convertir_usd: la caja debe ser ARS, ingresa `monto`.
//
// Tx atómica con audit-in-tx (patrón H6): si el INSERT en pagos commitea
// pero el audit o el cajaLedger fallan, no queremos pagos huérfanos.
router.post('/', validate(createPagoSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { fecha, monto, referencia, caja_id, convertir_usd, tc, monto_usd } = req.body;
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // 1. Validar caja destino (existe + no eliminada).
    const cajaRes = await client.query(
      'SELECT id, nombre, moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [caja_id]
    );
    if (!cajaRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La caja seleccionada no existe.' });
    }
    const caja = cajaRes.rows[0];

    // 2. Validar coherencia moneda caja ↔ flujo de conversión.
    if (convertir_usd) {
      if (grupoMoneda(caja.moneda) !== 'USD') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Si convertís a USD, la caja destino debe ser USD/USDT (es ${caja.moneda}).` });
      }
    } else {
      if (grupoMoneda(caja.moneda) !== 'ARS') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Sin conversión, la caja destino debe ser ARS (es ${caja.moneda}).` });
      }
    }

    // 3. Crear el pago. El `monto` es siempre ARS (descuenta del saldo);
    //    tc y monto_usd quedan poblados solo si convirtió.
    const { rows } = await client.query(
      `INSERT INTO pagos (fecha, monto, referencia, caja_id, tc, monto_usd)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        fecha, monto, referencia ?? null, caja_id,
        convertir_usd ? Number(tc) : null,
        convertir_usd ? Number(monto_usd) : null,
      ]
    );

    // 4. Postear ingreso a la caja real. Monto y moneda dependen del flujo.
    const montoIngresoCaja = convertir_usd ? Number(monto_usd) : Number(monto);
    await postCajaMovimiento(client, {
      caja_id, fecha, tipo: 'ingreso',
      monto: montoIngresoCaja, moneda: caja.moneda,
      tc: convertir_usd ? Number(tc) : null,
      origen: 'financiera', ref_tabla: 'pagos', ref_id: rows[0].id,
      concepto: `Pago financiera${referencia ? ' · ' + referencia : ''}`,
      user_id: req.user.id,
    });

    // 5. Egreso de la caja FV (`es_financiera=true`) por el mismo `monto` ARS
    //    que el pago descuenta del saldo Financiera. Misma ref_tabla/ref_id
    //    que el ingreso del paso 4 — reverseCajaMovimientos en el DELETE
    //    revierte LOS DOS movimientos en bloque sin tener que listarlos.
    //
    //    Trazabilidad junio 2026: antes los pagos solo creaban ingreso en la
    //    caja destino. La caja FV nunca reflejaba salidas → el saldo del libro
    //    caja crecía indefinidamente y mentía. Ahora cada pago = ingreso real
    //    en destino + egreso real en FV (transacción atómica).
    await postCajaMovimientoFinanciera(client, {
      tipo: 'egreso',
      fecha,
      monto: Number(monto), // siempre el ARS del pago (no el monto_usd convertido)
      ref_tabla: 'pagos',
      ref_id: rows[0].id,
      concepto: `Egreso por pago a vendedor → ${caja.nombre}${referencia ? ' · ' + referencia : ''}`,
      user_id: req.user.id,
    });

    await audit(client, 'pagos', 'INSERT', rows[0].id, {
      despues: rows[0], user_id: req.user.id,
    });
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    // postCajaMovimientoFinanciera y postCajaMovimiento throwean con err.status
    // (400 si falta caja FV, si moneda no coincide, si saldo insuficiente).
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally { client.release(); }
});

// ─── Eliminar (soft delete) ───────────────────────────────────────────────────
// Si el pago tiene caja_id (NUEVOS), se revierte el ingreso a la caja igual
// que en Tarjetas. Si no la tiene (legacy pre-junio 2026), solo se marca
// como eliminado — esos no impactaban cajas.
//
// reverseCajaMovimientos puede tirar 409 ("caja en negativo") si el dinero
// del pago ya fue gastado y la reversa dejaría la caja por debajo de 0.
// Ese error se propaga al frontend para que el operador sepa por qué falló.
router.delete('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);
    const { rows: before } = await client.query(
      'SELECT * FROM pagos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]
    );
    if (!before[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No encontrado' });
    }

    if (before[0].caja_id) {
      // Pago nuevo (post-junio 2026): revertir el caja_movimiento atómicamente.
      await reverseCajaMovimientos(client, 'pagos', id);
    }

    await client.query(
      'UPDATE pagos SET deleted_at = NOW() WHERE id = $1', [id]
    );
    await audit(client, 'pagos', 'DELETE', id, { antes: before[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;
