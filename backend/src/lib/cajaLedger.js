// Helper del ledger de cajas (Fase 2b). Cada módulo que mueve dinero llama a
// postCajaMovimiento dentro de su transacción, y reverseCajaMovimientos al anular.
//
// Convención: `monto` se guarda en la moneda de la caja (se asume que el pago
// se hace en la moneda de la caja elegida); `monto_usd` se calcula para totales.
const { toUsd, round2 } = require('./money');

// Agrupa monedas equivalentes para el saldo nativo de una caja: USD y USDT son
// 1:1 e intercambiables; ARS es su propio grupo. El saldo de una caja suma el
// `monto` nativo, así que un movimiento solo puede mezclarse con la misma moneda.
function grupoMoneda(m) { return m === 'ARS' ? 'ARS' : 'USD'; }

/**
 * Inserta un movimiento en el ledger de una caja. Debe ejecutarse con un client
 * de transacción. No-op si falta caja_id o el monto no es positivo.
 *   tipo: 'ingreso' | 'egreso'
 *   origen: 'venta' | 'b2b' | 'financiera' | 'envio' | 'egreso' | 'proveedor' | 'transferencia' | 'cambio' | 'tarjeta'
 *
 * Valida que la moneda del movimiento coincida (por grupo) con la de la caja:
 * como el saldo se calcula sobre el `monto` nativo, mezclar monedas lo corrompe.
 */
async function postCajaMovimiento(client, { caja_id, fecha, tipo, monto, moneda, tc, origen, ref_tabla, ref_id, concepto, user_id }) {
  if (!caja_id || !(Number(monto) > 0)) return null;

  const { rows: cajaRows } = await client.query(
    'SELECT moneda FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL', [caja_id]
  );
  if (!cajaRows[0]) {
    const e = new Error('La caja seleccionada no existe.'); e.status = 400; throw e;
  }
  if (grupoMoneda(cajaRows[0].moneda) !== grupoMoneda(moneda)) {
    const e = new Error(`La moneda del pago (${moneda}) no coincide con la de la caja (${cajaRows[0].moneda}).`);
    e.status = 400; throw e;
  }

  const monto_usd = round2(toUsd(monto, moneda, tc));
  const { rows } = await client.query(
    `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla ?? null, ref_id ?? null, concepto ?? null, user_id ?? null]
  );
  return rows[0];
}

/** Soft-delete de los movimientos de caja generados por un registro de origen (al anular/borrar). */
async function reverseCajaMovimientos(client, ref_tabla, ref_id) {
  await client.query(
    `UPDATE caja_movimientos SET deleted_at = NOW()
      WHERE ref_tabla = $1 AND ref_id = $2 AND deleted_at IS NULL`,
    [ref_tabla, ref_id]
  );
}

module.exports = { postCajaMovimiento, reverseCajaMovimientos };
