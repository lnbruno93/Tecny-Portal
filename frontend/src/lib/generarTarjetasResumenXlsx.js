/**
 * generarTarjetasResumenXlsx — genera un .xlsx con el resumen del estado de
 * cuenta de Tarjetas (Detalle) en el período filtrado. Lo descarga en browser.
 *
 * Input: { movimientos, totales, periodoLabel, generadoEn }
 *   (mismo shape que generarTarjetasResumenPdf)
 *
 * Layout una sola hoja "Resumen":
 *   Fila 1:      título
 *   Fila 2:      período
 *   Fila 3:      KPIs ARS (Movimientos | Cobrado bruto | Comisión | Neto)
 *   Fila 4:      KPIs USD (solo si hay) — misma estructura
 *   Fila 5:      KPIs USDT (solo si hay)
 *   Fila vacía
 *   Filas siguientes: header tabla + una fila por movimiento + total ARS
 *
 * Los montos se escriben como números (sin signo en el XLSX — el signo está
 * implícito en la columna Tipo). El contador puede sumar con =SUMIF(...) por
 * tipo. Negativos serían un dolor para Excel; mejor mantener positivos +
 * columna "Tipo" para discriminar.
 */

import { writeXlsx } from './xlsx';
import { downloadBlob } from './downloadBlob';

function fmtFechaCorta(s) {
  if (!s) return '';
  const iso = String(s).slice(0, 10);
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
// Audit 2026-07-04 P3: `downloadBlob` compartido en lib/downloadBlob.js.

function kpiRow(label, t) {
  return [
    label, '',
    'Movimientos',   toNum(t.total_count),
    'Cobrado bruto', toNum(t.cobros_bruto),
    'Comisión',      toNum(t.comision),
    'Neto',          toNum(t.saldo_periodo),
  ];
}

export function generarTarjetasResumenXlsx({
  movimientos = [],
  totales = { count: 0, ARS: {}, USD: {}, USDT: {} },
  periodoLabel = '',
  generadoEn = new Date(),
} = {}) {
  const ars = totales.ARS || {};
  const usd = totales.USD || {};
  const usdt = totales.USDT || {};

  const aoa = [
    ['Tecny · Tarjetas — Estado de cuenta'],
    [`Período: ${periodoLabel || '—'}`],
    kpiRow('ARS', ars),
  ];
  if ((usd.total_count  || 0) > 0) aoa.push(kpiRow('USD',  usd));
  if ((usdt.total_count || 0) > 0) aoa.push(kpiRow('USDT', usdt));
  aoa.push([]); // separador

  aoa.push(['Fecha', 'Tarjeta', 'Tipo', 'Moneda', 'Bruto', 'Comisión', 'Neto', 'Saldo acum.', 'Origen']);
  for (const m of movimientos) {
    const esCobro = m.tipo === 'cobro';
    aoa.push([
      fmtFechaCorta(m.fecha),
      String(m.metodo_nombre || ''),
      esCobro ? 'Cobro' : 'Liquidación',
      String(m.moneda || 'ARS'),
      esCobro ? toNum(m.monto_bruto)    : 0,
      esCobro ? toNum(m.monto_comision) : 0,
      toNum(m.monto_neto),
      toNum(m.saldo_acum),
      m.venta_order_id
        ? `Venta #${m.venta_order_id}`
        : (m.caja_nombre || ''),
    ]);
  }
  // Fila de totales ARS al final (no se incluyen USD/USDT en la fila — los KPIs
  // arriba ya los muestran; meterlos acá complicaría la lectura).
  aoa.push([
    'TOTAL ARS', '', '', '',
    toNum(ars.cobros_bruto),
    toNum(ars.comision),
    toNum(ars.saldo_periodo),
    '', '',
  ]);

  const isoToday = generadoEn.toISOString().slice(0, 10);
  const sheetName = `Tarjetas ${isoToday}`.slice(0, 31);
  const blob = writeXlsx(aoa, { sheetName });
  downloadBlob(blob, `tarjetas_resumen_${isoToday}.xlsx`);
}
