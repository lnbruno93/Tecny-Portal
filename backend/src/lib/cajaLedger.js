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

  // FOR UPDATE: lock de la fila para evitar race conditions sobre el saldo. Dos
  // egresos concurrentes podían dejarla en negativo si el saldo justo alcanzaba
  // para uno. Con el lock se serializan automáticamente.
  const { rows: cajaRows } = await client.query(
    'SELECT id, moneda, saldo_inicial FROM metodos_pago WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [caja_id]
  );
  if (!cajaRows[0]) {
    const e = new Error('La caja seleccionada no existe.'); e.status = 400; throw e;
  }
  if (grupoMoneda(cajaRows[0].moneda) !== grupoMoneda(moneda)) {
    const e = new Error(`La moneda del pago (${moneda}) no coincide con la de la caja (${cajaRows[0].moneda}).`);
    e.status = 400; throw e;
  }

  // No permitir que un egreso deje la caja en negativo. Política: las cajas
  // representan dinero real (efectivo, banco, USDT en wallet, etc.) — no
  // pueden tener saldo negativo conceptualmente. Para usar el patrón "préstamo"
  // está movimientos_deudas; para "anticipo de cliente" la cuenta corriente.
  //
  // #M-04: incluimos 'ajuste_resta' además de 'egreso'. Ambos restan saldo
  // y ambos deben respetar la regla (antes ajuste_resta podía dejar negativo
  // por la puerta de atrás).
  if (tipo === 'egreso' || tipo === 'ajuste_resta') {
    const { rows: balRows } = await client.query(
      `SELECT
         COALESCE($2::numeric, 0)
         + COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN tipo = 'egreso'  THEN monto ELSE 0 END), 0)
         AS saldo
         FROM caja_movimientos
        WHERE caja_id = $1 AND deleted_at IS NULL`,
      [caja_id, cajaRows[0].saldo_inicial || 0]
    );
    const saldoActual = Number(balRows[0]?.saldo || 0);
    const saldoFinal  = saldoActual - Number(monto);
    if (saldoFinal < 0) {
      const e = new Error(
        `Saldo insuficiente en la caja (saldo actual: ${saldoActual.toFixed(2)} ${cajaRows[0].moneda}, ` +
        `egreso pedido: ${Number(monto).toFixed(2)}). Una caja no puede quedar en negativo.`
      );
      e.status = 400; throw e;
    }
  }

  const monto_usd = round2(toUsd(monto, moneda, tc));
  const { rows } = await client.query(
    `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla ?? null, ref_id ?? null, concepto ?? null, user_id ?? null]
  );
  return rows[0];
}

/**
 * Soft-delete de los movimientos de caja generados por un registro de origen
 * (al anular/borrar). Auditoría #H-03: además del soft-delete, valida que
 * NINGUNA de las cajas afectadas quede en saldo negativo POST-reverse.
 *
 * Caso real que esto previene: cobranza B2B de USD 1000 ingresa caja vacía
 * → otro user hace un egreso de USD 1000 (proveedor) → DELETE de la cobranza
 * → la caja debería volver a -1000 (negativo virtual). Esto viola el
 * invariante de "una caja no puede quedar en negativo" por la puerta de
 * atrás. Ahora chequeamos saldo final y devolvemos 409 si rompe.
 */
async function reverseCajaMovimientos(client, ref_tabla, ref_id) {
  // Lockear las cajas afectadas en orden de id para evitar deadlock con
  // ventas / cobranzas concurrentes (mismo patrón que H-01/H-02).
  const { rows: afectadas } = await client.query(
    `SELECT DISTINCT caja_id FROM caja_movimientos
       WHERE ref_tabla = $1 AND ref_id = $2 AND deleted_at IS NULL
       ORDER BY caja_id`,
    [ref_tabla, ref_id]
  );
  for (const { caja_id } of afectadas) {
    await client.query('SELECT id FROM metodos_pago WHERE id = $1 FOR UPDATE', [caja_id]);
  }

  // Aplicar el soft-delete.
  await client.query(
    `UPDATE caja_movimientos SET deleted_at = NOW()
      WHERE ref_tabla = $1 AND ref_id = $2 AND deleted_at IS NULL`,
    [ref_tabla, ref_id]
  );

  // Validar saldo final de cada caja afectada. saldo_inicial + ingresos - egresos
  // calculado igual que en routes/cajas.js GET /cajas. Si alguna queda negativa,
  // rollback el reverse: throwear para que el caller propague.
  for (const { caja_id } of afectadas) {
    const { rows } = await client.query(
      `SELECT mp.nombre, mp.moneda,
              mp.saldo_inicial + COALESCE(SUM(
                CASE WHEN cm.tipo = 'ingreso' THEN cm.monto ELSE -cm.monto END
              ), 0) AS saldo_final
         FROM metodos_pago mp
         LEFT JOIN caja_movimientos cm
                ON cm.caja_id = mp.id AND cm.deleted_at IS NULL
        WHERE mp.id = $1
        GROUP BY mp.id, mp.nombre, mp.moneda, mp.saldo_inicial`,
      [caja_id]
    );
    const saldoFinal = Number(rows[0]?.saldo_final || 0);
    if (saldoFinal < 0) {
      const e = new Error(
        `No se puede deshacer: dejaría la caja "${rows[0].nombre}" en saldo negativo (${saldoFinal.toFixed(2)} ${rows[0].moneda}). ` +
        `Primero deshacé otros movimientos que ingresaron a esa caja después.`
      );
      e.status = 409;
      e.caja_id = caja_id;
      throw e;
    }
  }
}

module.exports = { postCajaMovimiento, reverseCajaMovimientos };
