// Cobros de Tarjeta generados automáticamente desde una venta.
//
// Cuando una venta se cobra con un método marcado como tarjeta
// (metodos_pago.es_tarjeta), se registra un 'cobro' en el módulo Tarjetas con la
// comisión del propio método (metodos_pago.comision_pct). El neto queda pendiente
// de liquidación (no entra a ninguna caja hasta que el procesador deposita).
//
// syncTarjetaCobros reconcilia de forma idempotente: borra los cobros previos de
// la venta y los recrea desde los pagos actuales. Debe correr dentro de la tx.
const { computeNeto } = require('./money');
const { postCajaMovimiento, reverseCajaMovimientos } = require('./cajaLedger');

/**
 * Postea un caja_movimiento sobre la caja-tarjeta correspondiente. Wrapper
 * fino sobre postCajaMovimiento que fija origen='tarjeta' y ref_tabla=
 * 'tarjeta_movimientos' para que reverseCajaMovimientos lo revierta en bloque
 * al DELETE/cancelación.
 *
 * Trazabilidad junio 2026 (TANDA 1 Tarjetas): cada cobro de tarjeta (de venta
 * o previo) postea +ingreso en su caja-tarjeta con monto_neto; cada liquidación
 * postea −egreso por monto_neto. El saldo del libro caja queda alineado con
 * el saldo "Te deben" virtual del módulo Tarjetas (Σ neto cobros − Σ neto
 * liquidaciones).
 *
 * `metodo_pago_id` ES la caja-tarjeta (cada tarjeta es su propia caja en
 * metodos_pago con es_tarjeta=true).
 */
async function postCajaMovimientoTarjeta(client, {
  metodo_pago_id, fecha, tipo, monto, moneda,
  ref_id, concepto, user_id,
}) {
  return postCajaMovimiento(client, {
    caja_id: metodo_pago_id,
    fecha,
    tipo,
    monto,
    moneda,
    tc: null,
    origen: 'tarjeta',
    ref_tabla: 'tarjeta_movimientos',
    ref_id,
    concepto: concepto ?? null,
    user_id: user_id ?? null,
  });
}

function err400(msg) { return Object.assign(new Error(msg), { status: 400 }); }

// Pre-check: revertir un cobro de tarjeta es seguro mientras el saldo
// resultante de la tarjeta (SUM cobros activos − SUM liquidaciones) siga ≥ 0.
// Si quedaría negativo, significa que la liquidación ya recibió plata por
// este cobro y bloqueamos la cancelación pidiendo deshacer la liquidación.
//
// Hacemos el cálculo por (metodo_pago_id) — una venta puede tener cobros en
// varias tarjetas; bloqueamos si CUALQUIERA quedaría en rojo.
async function checkLiquidacionesBloqueantes(client, ventaId) {
  const { rows } = await client.query(
    `WITH cobros_revertir AS (
       SELECT metodo_pago_id, COALESCE(SUM(monto_bruto), 0) AS monto_revertir
         FROM tarjeta_movimientos
        WHERE venta_id = $1 AND tipo = 'cobro' AND deleted_at IS NULL
        GROUP BY metodo_pago_id
     ),
     saldos AS (
       SELECT cr.metodo_pago_id, cr.monto_revertir,
              COALESCE(SUM(CASE WHEN tm.tipo='cobro'        THEN tm.monto_bruto ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN tm.tipo='liquidacion' THEN tm.monto_neto  ELSE 0 END), 0) AS saldo_actual
         FROM cobros_revertir cr
         LEFT JOIN tarjeta_movimientos tm
           ON tm.metodo_pago_id = cr.metodo_pago_id
          AND tm.deleted_at IS NULL
        GROUP BY cr.metodo_pago_id, cr.monto_revertir
     )
     SELECT s.metodo_pago_id, s.monto_revertir, s.saldo_actual, mp.nombre AS metodo_nombre
       FROM saldos s
       JOIN metodos_pago mp ON mp.id = s.metodo_pago_id
      WHERE s.saldo_actual - s.monto_revertir < 0
      LIMIT 1`, [ventaId]
  );
  if (rows[0]) {
    throw err400(
      `No se puede revertir esta venta: el cobro de tarjeta "${rows[0].metodo_nombre}" ` +
      `ya fue liquidado (saldo pendiente: $${Number(rows[0].saldo_actual).toFixed(2)}, ` +
      `monto a revertir: $${Number(rows[0].monto_revertir).toFixed(2)}). ` +
      `Eliminá primero la liquidación correspondiente.`
    );
  }
}

async function syncTarjetaCobros(client, ventaId, estado) {
  // Si vamos a borrar/cancelar, validamos primero que no haya liquidaciones
  // posteriores que dependan de estos cobros. Si las hay, lanzamos err400 y
  // el caller hace ROLLBACK de la transacción entera (no se cancela nada).
  if (estado === 'cancelado') {
    await checkLiquidacionesBloqueantes(client, ventaId);
  }

  // Auditoría 2026-06-30 D-01 — Snapshot lazy de venta_pagos.comision_pct_snapshot:
  //  Antes de borrar/recrear movs (patrón legacy idempotente), levantamos los
  //  movs viejos con su pct (derivable de monto_comision/monto_bruto). Si el
  //  pago correspondiente tiene comision_pct_snapshot IS NULL, usamos el pct
  //  derivado para SELLAR el snapshot — así el método sigue inmutable aunque
  //  cambien mp.comision_pct. Esto es el sealing lazy en primer touch.
  //
  //  La lista de movs viejos se cruza por venta_id + metodo_pago_id (un pago
  //  por método: el venta_pago lleva metodo_pago_id como FK). Si hay sealing
  //  pendiente, lo aplicamos antes del soft-delete para que el snapshot
  //  refleje la histórica.
  const { rows: cobrosViejos } = await client.query(
    `SELECT id, metodo_pago_id, monto_bruto, monto_comision, pct AS pct_old
       FROM tarjeta_movimientos
      WHERE venta_id = $1 AND tipo = 'cobro' AND deleted_at IS NULL`, [ventaId]
  );

  // Sealing lazy: para los venta_pagos involucrados con comision_pct_snapshot IS NULL,
  // derivamos el % desde el mov viejo (monto_comision/monto_bruto × 100) y lo persistimos.
  for (const c of cobrosViejos) {
    const bruto = Number(c.monto_bruto);
    const comision = Number(c.monto_comision);
    if (bruto <= 0) continue;
    const pctDerivado = round3(comision * 100 / bruto);
    await client.query(
      `UPDATE venta_pagos SET comision_pct_snapshot = $1
         WHERE venta_id = $2 AND metodo_pago_id = $3 AND comision_pct_snapshot IS NULL`,
      [pctDerivado, ventaId, c.metodo_pago_id]
    );
  }

  for (const c of cobrosViejos) {
    await reverseCajaMovimientos(client, 'tarjeta_movimientos', c.id);
  }
  // Soft-delete los cobros viejos (se recrearán abajo si la venta sigue activa).
  await client.query(
    `UPDATE tarjeta_movimientos SET deleted_at = NOW()
      WHERE venta_id = $1 AND tipo = 'cobro' AND deleted_at IS NULL`, [ventaId]
  );
  if (estado === 'cancelado') return;

  // Auditoría 2026-06-30 D-01 — leemos comision_pct_snapshot del venta_pagos
  // (NO de metodos_pago) para preservar inmutabilidad histórica. Si el snapshot
  // es NULL (caso de venta_pagos pre-fix recién sellado arriba, O caso de pago
  // recién INSERTado donde el sealing al INSERT falló por algún motivo), caemos
  // al pct ACTUAL de metodos_pago — caso borde, se persiste como snapshot abajo.
  // Auditoría 2026-06-30 D-21: filtro `mp.deleted_at IS NULL` agregado al JOIN.
  // Consistente con ventaSync.js — re-syncar una venta no debe resucitar movs
  // sobre tarjeta soft-deleted. Si el método fue archivado, la venta ya no
  // genera nuevos cobros de tarjeta automáticamente (rompe contabilidad en
  // cajas-tarjeta zombi).
  const { rows: pagos } = await client.query(
    `SELECT vp.id AS vp_id, vp.monto, vp.moneda, vp.metodo_pago_id,
            vp.comision_pct_snapshot,
            COALESCE(mp.comision_pct, 0) AS mp_comision_pct
       FROM venta_pagos vp
       JOIN metodos_pago mp ON mp.id = vp.metodo_pago_id AND mp.deleted_at IS NULL
      WHERE vp.venta_id = $1 AND vp.es_cuenta_corriente = false AND mp.es_tarjeta = true`, [ventaId]
  );
  if (pagos.length === 0) return;

  const { rows: v } = await client.query('SELECT fecha FROM ventas WHERE id = $1', [ventaId]);
  const fecha = v[0]?.fecha;

  for (const p of pagos) {
    // Snapshot del % a usar: prioridad al snapshot del venta_pago; si NULL, al pct actual del método.
    const pctSnap = p.comision_pct_snapshot != null
      ? Number(p.comision_pct_snapshot)
      : Number(p.mp_comision_pct);
    const { bruto, pct, comision, neto } = computeNeto(p.monto, pctSnap);

    // Si el snapshot estaba NULL, persistirlo para que la próxima edición ya no
    // lea de metodos_pago (sealing del fallback).
    if (p.comision_pct_snapshot == null) {
      await client.query(
        `UPDATE venta_pagos SET comision_pct_snapshot = $1 WHERE id = $2`,
        [round3(pct), p.vp_id]
      );
    }

    // 2026-07-12 (auditoría TOTAL Financiero P1-5): persistir venta_pago_id
    // como FK explícito. Antes el link entre tarjeta_movimientos y venta_pagos
    // era implícito via triple JOIN (venta_id + metodo_pago_id + monto_bruto),
    // que fallaba en el edge case de 2 pagos con mismo método + mismo monto.
    // Ahora el JOIN por FK es 1-a-1 sin ambiguedad.
    const { rows } = await client.query(
      `INSERT INTO tarjeta_movimientos
         (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, venta_id, venta_pago_id)
       VALUES ($1,$2,'cobro',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [p.metodo_pago_id, fecha, p.moneda, bruto, pct, comision, neto, ventaId, p.vp_id]
    );
    // +ingreso por monto_neto en la caja-tarjeta. Si la moneda del cobro no
    // matchea el grupo de la tarjeta, postCajaMovimiento throwea 400.
    await postCajaMovimientoTarjeta(client, {
      metodo_pago_id: p.metodo_pago_id,
      fecha,
      tipo: 'ingreso',
      monto: neto,
      moneda: p.moneda,
      ref_id: rows[0].id,
      concepto: `Cobro venta #${ventaId}`,
    });
  }
}

// Auditoría 2026-06-30 D-01 — helper local para redondear a 3 decimales (tipo
// NUMERIC(6,3) de comision_pct_snapshot).
function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

module.exports = { syncTarjetaCobros, postCajaMovimientoTarjeta };
