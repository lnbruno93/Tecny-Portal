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
    const { fecha, caja_origen_id, caja_destino_id, moneda, monto, costo, descripcion } = req.body;
    await client.query('BEGIN');
    // multi-tenant: SET LOCAL para que la tx respete RLS.
    await client.query(`SET LOCAL app.current_tenant = ${req.tenantId}`);

    // Validar que ambas cajas existen, no están eliminadas y comparten moneda
    // con la que el operador declaró. El helper postCajaMovimiento vuelve a
    // validar por su cuenta (grupo de moneda), pero acá damos errores más
    // amigables antes de tocar el ledger.
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
    // separados. El helper cajaLedger lo hace igual, pero acá lo validamos para
    // dar un mensaje más claro que "no coincide con grupo".
    const grupo = (m) => (m === 'ARS' ? 'ARS' : m === 'UYU' ? 'UYU' : 'USD');
    if (grupo(origen.moneda) !== grupo(moneda) || grupo(destino.moneda) !== grupo(moneda)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `La moneda del movimiento (${moneda}) debe coincidir con las cajas ` +
               `(origen: ${origen.moneda}, destino: ${destino.moneda}). ` +
               `Para cambios de moneda usá "Cambios de Divisa".`,
      });
    }

    // Insertar la transferencia. tenant_id sale del setting local (RLS).
    const costoN = Number(costo) || 0;
    const { rows } = await client.query(
      `INSERT INTO caja_transferencias
         (tenant_id, fecha, caja_origen_id, caja_destino_id, moneda, monto, costo, descripcion, user_id)
       VALUES
         (current_setting('app.current_tenant')::integer, $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [fecha, caja_origen_id, caja_destino_id, moneda, monto, costoN, descripcion ?? null, req.user.id]
    );
    const nuevo = rows[0];

    // Ledger: 2 asientos, ambos con ref_tabla='caja_transferencias' + ref_id
    // para que el DELETE los reversa en bloque.
    //
    // Egreso origen = monto + costo (la comisión bancaria sale ADEMÁS del monto
    // que llega al destino). Si costo=0, solo sale el monto.
    // Ingreso destino = monto (sin costo — el costo se quedó en la comisión).
    const conceptoBase = descripcion ? descripcion : `Transferencia ${origen.nombre} → ${destino.nombre}`;
    await postCajaMovimiento(client, {
      caja_id:    caja_origen_id,
      fecha,
      tipo:       'egreso',
      monto:      Number(monto) + costoN,
      moneda,
      tc:         null,
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
      monto:      Number(monto),
      moneda,
      tc:         null,
      origen:     'transferencia',
      ref_tabla:  'caja_transferencias',
      ref_id:     nuevo.id,
      concepto:   conceptoBase,
      user_id:    req.user.id,
    });

    await audit(client, 'caja_transferencias', 'INSERT', nuevo.id, { despues: nuevo, user_id: req.user.id });
    await client.query('COMMIT');
    res.status(201).json(nuevo);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
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
