// Helpers de sincronización post-venta extraídos de routes/ventas.js para poder
// reusarlos desde el flujo "envío → venta auto" (lib/ventaDesdeEnvio.js).
//
// La venta es la "fuente de verdad" de los efectos secundarios financieros:
//   · syncVentaCaja          → ingresos de caja por pagos no-CC y no-financiera/tarjeta
//   · sincronizarCuentaCorriente → deuda en movimientos_cc para pagos CC
//   · (los comprobantes de Financiera y los cobros de Tarjeta viven en sus
//      propios módulos: lib/financiera.js y lib/tarjetas.js)

const { postCajaMovimientosBulk, reverseCajaMovimientos } = require('./cajaLedger');
const { round2, convertirMonto } = require('./money');
const { retieneStock } = require('./ventaCore');
const logger = require('./logger');

// Sincroniza los ingresos de caja de una venta. Idempotente: revierte previos
// y re-postea según el estado actual. Saltea pagos CC, financiera y tarjeta.
//
// Auditoría 2026-06-30 D-21: agregado filtro `mp.deleted_at IS NULL` al JOIN.
// Sin el filtro, una venta vieja cuyo método de pago fue soft-deleted
// re-posteaba el caja_movimiento contra una caja borrada al re-syncar (por
// ejemplo: editar la venta). El postCajaMovimiento no chequea el deleted_at
// de la caja → terminaba inflando el saldo de una caja que el operador ya
// "borró" del UI. Filtrar acá rompe la sincronización para esos pagos
// huérfanos — preferimos esa señal explícita (saldo no coincide) a contabilidad
// silenciosamente incorrecta sobre cajas archivadas. El operador debe re-asignar
// el pago a una caja activa antes de editar la venta.
async function syncVentaCaja(client, venta, userId) {
  await reverseCajaMovimientos(client, 'ventas', venta.id);
  if (!retieneStock(venta.estado)) return;
  // Fix #4 audit 2026-07-07 (Fase A forward-only): también leemos mp.moneda
  // para poder convertir el monto del pago a la moneda de la caja cuando
  // difieren. Antes se copiaba `vp.monto` crudo aunque `mp.moneda` fuera
  // otra — el saldo de la caja acumulaba mezcla y quedaba contable falso.
  const { rows: pagos } = await client.query(
    `SELECT vp.metodo_pago_id, vp.monto, vp.moneda, vp.tc,
            mp.moneda AS caja_moneda, mp.es_financiera, mp.es_tarjeta
       FROM venta_pagos vp
       JOIN metodos_pago mp ON mp.id = vp.metodo_pago_id AND mp.deleted_at IS NULL
      WHERE vp.venta_id = $1 AND vp.es_cuenta_corriente = false AND vp.metodo_pago_id IS NOT NULL`, [venta.id]
  );
  // TANDA 1 Perf #4 (2026-07-05): bulk INSERT en lugar de un round-trip por
  // pago. Para una venta con 2–4 pagos eso son 6–12 round-trips a PG menos por
  // request.
  const movimientos = [];
  for (const p of pagos) {
    if (p.es_financiera || p.es_tarjeta) continue;
    // Si `pago.moneda === caja.moneda`: passthrough (comportamiento pre-fix).
    // Si difieren: convertir usando `pago.tc` para que caja_movimiento quede
    // ya en la moneda de la caja. El validador del POST venta garantiza que
    // en este punto no llegamos con mismatch sin tc — pero si por alguna
    // razón sí (ej. venta creada antes del fix, edit forzando re-sync),
    // logueamos WARN y skipeamos el mov en vez de corromper el saldo.
    const montoParaCaja = convertirMonto(p.monto, p.moneda, p.caja_moneda, p.tc);
    if (montoParaCaja === null) {
      logger.warn(
        { ventaId: venta.id, orderId: venta.order_id, cajaId: p.metodo_pago_id,
          pagoMoneda: p.moneda, cajaMoneda: p.caja_moneda, tc: p.tc, monto: p.monto },
        '[syncVentaCaja] pago mismatch de moneda sin conversión válida — skip mov para no corromper saldo'
      );
      continue;
    }
    movimientos.push({
      caja_id: p.metodo_pago_id, fecha: venta.fecha, tipo: 'ingreso',
      monto: montoParaCaja, moneda: p.caja_moneda, tc: p.tc,
      origen: 'venta', ref_tabla: 'ventas', ref_id: venta.id,
      concepto: `Venta ${venta.order_id}`, user_id: userId,
    });
  }
  await postCajaMovimientosBulk(client, movimientos);
}

// Sincroniza la deuda CC generada por la venta. Idempotente. Sólo crea
// movimiento si hay cliente_cc_id, la venta retiene stock y hay pagos CC > 0.
async function sincronizarCuentaCorriente(client, venta) {
  await client.query('UPDATE movimientos_cc SET deleted_at = NOW() WHERE venta_id = $1 AND deleted_at IS NULL', [venta.id]);
  if (!retieneStock(venta.estado) || !venta.cliente_cc_id) return;
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(monto_usd), 0) AS total FROM venta_pagos WHERE venta_id = $1 AND es_cuenta_corriente = true', [venta.id]
  );
  const total = round2(Number(rows[0].total));
  if (total <= 0) return;
  await client.query(
    `INSERT INTO movimientos_cc (cliente_cc_id, fecha, tipo, descripcion, monto_total, venta_id)
     VALUES ($1, $2, 'compra', $3, $4, $5)`,
    [venta.cliente_cc_id, venta.fecha, `Venta ${venta.order_id}`, total, venta.id]
  );
}

module.exports = { syncVentaCaja, sincronizarCuentaCorriente };
