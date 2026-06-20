// tarjetasSaldo.js — fórmula canónica del saldo pendiente de liquidación
// por tarjeta. FUENTE ÚNICA DE VERDAD.
//
// 2026-06-21 TANDA 2 #341 DRY: pre-refactor, el `CASE WHEN tipo='cobro' ...
// ELSE -monto_neto` vivía inline en 3 lugares (chat-tools.js
// get_tarjetas_no_liquidadas, routes/tarjetas.js /saldos-resumen, y
// el resumenSql() para la lista paginada). Cualquier fix de signo o
// edge case requería actualizar las 3 copias. Centralizamos.
//
// Concepto:
//   La "tarjeta" es un método de pago marcado es_tarjeta=true (Visa,
//   Mastercard, etc.). Cuando una venta se cobra con tarjeta, se crea
//   un `tarjeta_movimientos` tipo='cobro' con `monto_neto` = bruto - comisión
//   de la procesadora. Cuando la procesadora liquida (paga al merchant),
//   se crea un `tarjeta_movimientos` tipo='liquidacion' con monto_neto
//   = lo liquidado. La diferencia (cobros pendientes - liquidados) es
//   lo que la procesadora aún nos debe.
//
// Uso:
//   const { saldoNetoCase } = require('./tarjetasSaldo');
//   const sql = `SELECT mp.id, SUM(${saldoNetoCase('tm')}) AS saldo
//                FROM metodos_pago mp
//                LEFT JOIN tarjeta_movimientos tm ON tm.metodo_pago_id = mp.id
//                WHERE mp.es_tarjeta = true ...`;

/**
 * SQL fragment que evalúa al monto neto signed (positivo si es cobro pendiente,
 * negativo si es liquidación que reduce el saldo). Para sumar dentro de un
 * SUM(...) en una agregación.
 *
 * Filtra automáticamente movimientos soft-deleteados (deleted_at IS NULL) —
 * si el caller ya filtró en su WHERE, el AND deleted_at IS NULL es no-op
 * (no perf hit), pero garantiza correctness aún cuando el caller olvida.
 *
 * @param {string} [alias='m'] alias de la tabla tarjeta_movimientos en la query.
 * @returns {string} fragmento SQL (sin SUM, sin COALESCE — los pone el caller).
 */
function saldoNetoCase(alias = 'm') {
  return `CASE
    WHEN ${alias}.tipo = 'cobro'       AND ${alias}.deleted_at IS NULL THEN  ${alias}.monto_neto
    WHEN ${alias}.tipo = 'liquidacion' AND ${alias}.deleted_at IS NULL THEN -${alias}.monto_neto
    ELSE 0
  END`;
}

module.exports = { saldoNetoCase };
