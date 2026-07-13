// Módulo Movimientos de Caja (transferencias entre cajas propias del negocio).
//
// Diseño detallado en el header de la migration
// 20260704000001_caja_transferencias.js y el schema
// backend/src/schemas/cajaTransferencias.js.
//
// Diferencia con lo que ya existe:
//   - `egresos` → gasto real del negocio (proveedor, sueldos, luz).
//   - `cambio_movimientos` → 2 cajas + 2 monedas + financiera EXTERNA (cambista).
//   - `caja_transferencias` (este módulo) → 2 cajas propias, MISMA moneda, sin
//     financiera. Solo traslado interno.
//
// Montado en /api/caja-transferencias con requireAuth + requireCapability('egresos.ver')
// desde app.js (misma cap que Egresos — está en la misma pantalla en el front,
// tab separado).
//
// Al crear se postean 2 asientos al ledger `caja_movimientos`:
//   1. Egreso caja origen por (monto + costo), origen='transferencia'.
//   2. Ingreso caja destino por monto, origen='transferencia'.
// Ambos con ref_tabla='caja_transferencias' + ref_id, así el DELETE reversa
// los dos con un `reverseCajaMovimientos()` estándar.

const router   = require('express').Router();
const db       = require('../config/database');
const validate = require('../lib/validate');
const audit    = require('../lib/audit');
const parseId  = require('../lib/parseId');
const { parsePagination, paginatedResponse } = require('../lib/paginate');
const { postCajaMovimiento, reverseCajaMovimientos } = require('../lib/cajaLedger');
const { createTransferenciaSchema } = require('../schemas/cajaTransferencias');

// GET /api/caja-transferencias — listar con paginación (más recientes primero).
// Filtros opcionales: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD.
// Devuelve nombres de las cajas para que la tabla del front no necesite N+1.
router.get('/', async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50 });
    const desde = req.query.desde || null;
    const hasta = req.query.hasta || null;

    const { count, dataRows } = await db.withTenant(req.tenantId, async (client) => {
      const filters = ['t.deleted_at IS NULL'];
      const args = [];
      if (desde) { args.push(desde); filters.push(`t.fecha >= $${args.length}`); }
      if (hasta) { args.push(hasta); filters.push(`t.fecha <= $${args.length}`); }
      const where = 'WHERE ' + filters.join(' AND ');

      const countRes = await client.query(`SELECT COUNT(*) FROM caja_transferencias t ${where}`, args);
      const dataRes = await client.query(
        `SELECT t.*,
                o.nombre AS caja_origen_nombre,
                d.nombre AS caja_destino_nombre,
                u.nombre AS user_nombre
           FROM caja_transferencias t
           LEFT JOIN metodos_pago o ON o.id = t.caja_origen_id
           LEFT JOIN metodos_pago d ON d.id = t.caja_destino_id
           LEFT JOIN users        u ON u.id = t.user_id
           ${where}
           ORDER BY t.fecha DESC, t.id DESC
           LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, limit, offset]
      );
      return { count: parseInt(countRes.rows[0].count, 10), dataRows: dataRes.rows };
    });

    res.json(paginatedResponse(dataRows, count, { page, limit }));
  } catch (err) { next(err); }
});

// POST /api/caja-transferencias — crear una transferencia.
// Al crear: valida cajas distintas + monedas coincidentes + inserta la row +
// 2 asientos al ledger + audit. Todo en tx. Si algo falla, rollback.
router.post('/', validate(createTransferenciaSchema), async (req, res, next) => {
  const client = await db.connect();
  try {
    const {
      fecha, caja_origen_id, caja_destino_id, moneda, monto, costo, descripcion,
      // 2026-07-13 (cross-currency): 3 campos opcionales. Si vienen los 3,
      // la transferencia es entre monedas distintas y el operador tipeó
      // manualmente el TC + monto destino.
      moneda_destino, monto_destino, tc,
    } = req.body;
    // Cross-currency: los 3 campos presentes indican que el operador está
    // moviendo entre cajas de moneda distinta. Same-currency: todos NULL.
    // El schema garantiza "todo o nada"; acá solo derivamos.
    const isCross = !!(moneda_destino && monto_destino && tc);
    await client.query('BEGIN');
    // multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // Validar que ambas cajas existen, no están eliminadas.
    const { rows: cajas } = await client.query(
      `SELECT id, nombre, moneda FROM metodos_pago
        WHERE id IN ($1, $2) AND deleted_at IS NULL`,
      [caja_origen_id, caja_destino_id]
    );
    const origen  = cajas.find(c => c.id === caja_origen_id);
    const destino = cajas.find(c => c.id === caja_destino_id);
    if (!origen) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'La caja de origen no existe o fue eliminada.' });
    }
    if (!destino) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'La caja de destino no existe o fue eliminada.' });
    }
    // grupoMoneda: USD y USDT son 1:1 (mismo grupo); ARS y UYU son grupos
    // separados.
    const grupo = (m) => (m === 'ARS' ? 'ARS' : m === 'UYU' ? 'UYU' : 'USD');
    if (isCross) {
      // Cross-currency: origen debe matchear con `moneda`, destino con
      // `moneda_destino`. Deben ser grupos DISTINTOS (sino no tiene sentido
      // el TC — el operador está haciendo lo mismo que same-currency).
      if (grupo(origen.moneda) !== grupo(moneda)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `La caja de origen es ${origen.moneda}, no coincide con la moneda de origen declarada (${moneda}).`,
        });
      }
      if (grupo(destino.moneda) !== grupo(moneda_destino)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `La caja de destino es ${destino.moneda}, no coincide con la moneda de destino declarada (${moneda_destino}).`,
        });
      }
      if (grupo(origen.moneda) === grupo(destino.moneda)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Ambas cajas son ${grupo(origen.moneda)}. Para transferencia sin TC no cargues los campos de moneda destino.`,
        });
      }
    } else {
      // Same-currency (comportamiento pre-feature): moneda declarada coincide
      // con las 2 cajas.
      if (grupo(origen.moneda) !== grupo(moneda) || grupo(destino.moneda) !== grupo(moneda)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `La moneda del movimiento (${moneda}) debe coincidir con las cajas ` +
                 `(origen: ${origen.moneda}, destino: ${destino.moneda}). ` +
                 `Si querés mover entre monedas distintas, activá "Cambio de moneda con TC".`,
        });
      }
    }

    // Insertar la transferencia. tenant_id sale del setting local (RLS).
    // Los 3 campos cross-currency son NULL en same-currency (backward compat).
    const costoN = Number(costo) || 0;
    const { rows } = await client.query(
      `INSERT INTO caja_transferencias
         (tenant_id, fecha, caja_origen_id, caja_destino_id, moneda, monto, costo, descripcion, user_id,
          moneda_destino, monto_destino, tc)
       VALUES
         (current_setting('app.current_tenant')::integer, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [fecha, caja_origen_id, caja_destino_id, moneda, monto, costoN, descripcion ?? null, req.user.id,
       isCross ? moneda_destino : null,
       isCross ? Number(monto_destino) : null,
       isCross ? Number(tc) : null]
    );
    const nuevo = rows[0];

    // Ledger: 2 asientos, ambos con ref_tabla='caja_transferencias' + ref_id
    // para que el DELETE los reversa en bloque.
    //
    // Same-currency:
    //   · Egreso origen = monto + costo (comisión bancaria sale ADEMÁS del monto).
    //   · Ingreso destino = monto (sin costo).
    // Cross-currency (2026-07-13):
    //   · Egreso origen = monto + costo, en moneda origen, con TC (para calcular
    //     monto_usd del asiento origen).
    //   · Ingreso destino = monto_destino, en moneda destino, sin TC (si destino
    //     es USD/USDT el monto ya es USD; si fuera ARS/UYU el ingreso quedaría
    //     sin monto_usd calculado — pero el TC ya se aplicó en el origen).
    const conceptoBase = descripcion ? descripcion : `Transferencia ${origen.nombre} → ${destino.nombre}`;
    await postCajaMovimiento(client, {
      caja_id:    caja_origen_id,
      fecha,
      tipo:       'egreso',
      monto:      Number(monto) + costoN,
      moneda,
      tc:         isCross ? Number(tc) : null,
      origen:     'transferencia',
      ref_tabla:  'caja_transferencias',
      ref_id:     nuevo.id,
      concepto:   costoN > 0 ? `${conceptoBase} (incluye costo ${costoN})` : conceptoBase,
      user_id:    req.user.id,
    });
    await postCajaMovimiento(client, {
      caja_id:    caja_destino_id,
      fecha,
      tipo:       'ingreso',
      monto:      isCross ? Number(monto_destino) : Number(monto),
      moneda:     isCross ? moneda_destino : moneda,
      tc:         isCross ? Number(tc) : null,
      origen:     'transferencia',
      ref_tabla:  'caja_transferencias',
      ref_id:     nuevo.id,
      concepto:   isCross
        ? `${conceptoBase} · TC ${tc} (${moneda}→${moneda_destino})`
        : conceptoBase,
      user_id:    req.user.id,
    });

    await audit(client, 'caja_transferencias', 'INSERT', nuevo.id, { despues: nuevo, user_id: req.user.id });
    await client.query('COMMIT');
    res.status(201).json(nuevo);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
    // 2026-07-13 (cross-currency): postCajaMovimiento puede throwear 400 si
    // el egreso deja la caja origen en negativo (saldo insuficiente).
    // Propagar con mensaje claro en vez de 500 genérico.
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// DELETE /api/caja-transferencias/:id — soft delete + reverse ledger.
// Los 2 asientos al ledger se marcan como deleted_at con
// reverseCajaMovimientos (que además valida que ninguna caja quede negativa
// después de reversar).
router.delete('/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    const { rows } = await client.query(
      `UPDATE caja_transferencias SET deleted_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING *`,
      [id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }

    // Reversa los 2 asientos del ledger. Si alguna caja quedara en negativo
    // post-reverse, el helper throwea con status 409 y el catch de arriba
    // hace rollback (la fila queda undeleted).
    await reverseCajaMovimientos(client, 'caja_transferencias', id);
    await audit(client, 'caja_transferencias', 'DELETE', id, { antes: rows[0], user_id: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
