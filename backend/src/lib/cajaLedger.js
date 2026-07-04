// Helper del ledger de cajas (Fase 2b). Cada módulo que mueve dinero llama a
// postCajaMovimiento dentro de su transacción, y reverseCajaMovimientos al anular.
//
// Convención: `monto` se guarda en la moneda de la caja (se asume que el pago
// se hace en la moneda de la caja elegida); `monto_usd` se calcula para totales.
const { toUsd, round2 } = require('./money');

// Agrupa monedas equivalentes para el saldo nativo de una caja. El saldo de
// una caja suma el `monto` nativo, así que un movimiento solo puede mezclarse
// con la MISMA moneda o una equivalente 1:1.
//
//   - ARS es su propio grupo.
//   - UYU es su propio grupo (BLOCKER 2026-07-05: antes caía al else y era
//     tratada como USD, permitiendo que un pago UYU se aceptara en una caja
//     USD/USDT — el `saldo` nativo terminaba con UYU sumados como si fueran
//     dólares. Reportado por tenants UY: sus cajas USD tenían saldos absurdos
//     porque cobros UYU se estaban registrando ahí).
//   - USD y USDT son 1:1 e intercambiables (mismo grupo).
function grupoMoneda(m) {
  if (m === 'ARS') return 'ARS';
  if (m === 'UYU') return 'UYU';
  return 'USD';
}

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

/**
 * Versión bulk de `postCajaMovimiento`. Inserta N movimientos en 1 sola INSERT
 * (UNNEST) tras lockear todas las cajas afectadas en un único round-trip.
 *
 * Auditoría 2026-07-05 TANDA 1 (Performance P1 #4): `syncVentaCaja` y
 * `syncEnvioCaja` iteraban `postCajaMovimiento` en un for-loop, generando
 * 3–5 round-trips por pago (SELECT ... FOR UPDATE + posible SELECT saldo +
 * INSERT). Para un envío grande con 3 pagos eso son ~12 round-trips a PG.
 * Con el bulk son 2–3 (SELECT+lock, saldo si hay egresos, INSERT).
 *
 * Semántica preservada respecto de la versión single:
 *   · Salta movimientos sin caja_id o con monto <= 0 (no-op silencioso).
 *   · Valida existencia de la caja (soft-delete-aware) → 400 si no existe.
 *   · Valida grupo de moneda (ARS/UYU/USD) → 400 si no coincide.
 *   · Si hay egresos/ajuste_resta, valida saldo POST-batch por caja → 400.
 *   · Lockea cajas en orden ascendente de id (mismo patrón que reverse) para
 *     evitar deadlocks entre transacciones concurrentes.
 *
 * Diferencia intencional respecto de la versión single: la validación de saldo
 * es sobre el DELTA NETO del batch por caja (ingresos - egresos), no
 * movimiento-por-movimiento. Es un poco más laxa (un egreso grande puede
 * pasar si hay un ingreso en el mismo batch que lo compensa), pero el estado
 * final sigue siendo consistente. En la práctica los callers actuales
 * (syncVentaCaja, syncEnvioCaja) sólo postean ingresos, así que este camino
 * ni se activa.
 */
async function postCajaMovimientosBulk(client, movimientos) {
  if (!Array.isArray(movimientos) || movimientos.length === 0) return [];

  // Filtrar los válidos (con caja + monto positivo). Mismo criterio no-op que
  // la versión single. Preserva orden original.
  const valid = movimientos.filter((m) => m && m.caja_id && Number(m.monto) > 0);
  if (valid.length === 0) return [];

  // IDs únicos ordenados ascendente para prevenir deadlocks entre transacciones
  // concurrentes que toquen las mismas cajas (mismo patrón que reverseCajaMovimientos).
  const cajaIds = [...new Set(valid.map((m) => Number(m.caja_id)))].sort((a, b) => a - b);

  // 1 round-trip para lockear TODAS las cajas afectadas + traer moneda/saldo_inicial.
  // ORDER BY id FOR UPDATE: postgres adquiere los locks en el orden del scan
  // (ascendente por id), previniendo el patrón de deadlock A→B vs B→A.
  const { rows: cajaRows } = await client.query(
    `SELECT id, moneda, saldo_inicial FROM metodos_pago
      WHERE id = ANY($1::int[]) AND deleted_at IS NULL
      ORDER BY id FOR UPDATE`,
    [cajaIds]
  );
  const cajaById = new Map(cajaRows.map((c) => [Number(c.id), c]));

  // Validar existencia (soft-delete aware) y grupo de moneda por movimiento.
  for (const m of valid) {
    const caja = cajaById.get(Number(m.caja_id));
    if (!caja) {
      const e = new Error('La caja seleccionada no existe.'); e.status = 400; throw e;
    }
    if (grupoMoneda(caja.moneda) !== grupoMoneda(m.moneda)) {
      const e = new Error(
        `La moneda del pago (${m.moneda}) no coincide con la de la caja (${caja.moneda}).`
      );
      e.status = 400; throw e;
    }
  }

  // Si hay egresos/ajuste_resta, validar saldo POST-batch por caja.
  const hayEgresos = valid.some((m) => m.tipo === 'egreso' || m.tipo === 'ajuste_resta');
  if (hayEgresos) {
    // Delta neto del batch por caja: ingresos suman, egresos/ajuste_resta restan.
    const deltaPorCaja = new Map();
    for (const m of valid) {
      const id = Number(m.caja_id);
      const delta = m.tipo === 'ingreso' ? Number(m.monto) : -Number(m.monto);
      deltaPorCaja.set(id, (deltaPorCaja.get(id) || 0) + delta);
    }
    for (const [cajaId, delta] of deltaPorCaja) {
      // Sólo chequear si el neto del batch resta saldo. Si es >= 0 no hay riesgo.
      if (delta >= 0) continue;
      const caja = cajaById.get(cajaId);
      const { rows: balRows } = await client.query(
        `SELECT COALESCE($2::numeric, 0)
                + COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0)
                - COALESCE(SUM(CASE WHEN tipo IN ('egreso', 'ajuste_resta') THEN monto ELSE 0 END), 0)
                AS saldo
           FROM caja_movimientos
          WHERE caja_id = $1 AND deleted_at IS NULL`,
        [cajaId, caja.saldo_inicial || 0]
      );
      const saldoActual = Number(balRows[0]?.saldo || 0);
      const saldoFinal = saldoActual + delta;
      if (saldoFinal < 0) {
        const e = new Error(
          `Saldo insuficiente en la caja (saldo actual: ${saldoActual.toFixed(2)} ${caja.moneda}, ` +
          `neto del batch: ${delta.toFixed(2)}). Una caja no puede quedar en negativo.`
        );
        e.status = 400; throw e;
      }
    }
  }

  // Bulk INSERT con UNNEST — 1 round-trip para todos los movimientos.
  const { rows: inserted } = await client.query(
    `INSERT INTO caja_movimientos
       (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, user_id)
     SELECT caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, user_id
       FROM UNNEST(
         $1::int[], $2::date[], $3::text[], $4::numeric[], $5::numeric[],
         $6::text[], $7::text[], $8::int[], $9::text[], $10::int[]
       ) AS u(caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto, user_id)
     RETURNING *`,
    [
      valid.map((m) => Number(m.caja_id)),
      valid.map((m) => m.fecha),
      valid.map((m) => m.tipo),
      valid.map((m) => m.monto),
      valid.map((m) => round2(toUsd(m.monto, m.moneda, m.tc))),
      valid.map((m) => m.origen),
      valid.map((m) => m.ref_tabla ?? null),
      valid.map((m) => (m.ref_id != null ? Number(m.ref_id) : null)),
      valid.map((m) => m.concepto ?? null),
      valid.map((m) => (m.user_id != null ? Number(m.user_id) : null)),
    ]
  );
  return inserted;
}

// Exportamos `grupoMoneda` para permitir tests unitarios (regresión BLOCKER
// 2026-07-05: UYU debe ser su propio grupo, no compartido con USD).
module.exports = {
  postCajaMovimiento,
  postCajaMovimientosBulk,
  reverseCajaMovimientos,
  grupoMoneda,
};
