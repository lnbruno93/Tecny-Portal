/**
 * generarComprobantesResumenXlsx — genera un .xlsx con el resumen del período
 * de Comprobantes (Financiera). Lo descarga en el browser.
 *
 * Input: { comprobantes, totales, periodoLabel, generadoEn }
 *   (mismo shape que generarComprobantesResumenPdf)
 *
 * Layout una sola hoja "Resumen":
 *   Filas 1-2:   título + período
 *   Fila 3:      KPIs (Cantidad, Bruto, Retención, Neto) — numéricos
 *   Fila 4:      vacía (separador)
 *   Fila 5:      headers de la tabla
 *   Filas 6+:    una por comprobante (los montos son números, no texto)
 *   Última fila: totales (números también) — el contador puede insertar filas
 *                arriba y los totales no se recalculan solos. Lo dejamos como
 *                snapshot — si quiere sumas vivas, usa Σ a mano.
 *
 * Decisión: una sola hoja en vez de "Resumen" + "Detalle" separadas. La lib
 * propia (lib/xlsx.js) hoy escribe un libro mono-sheet; agregar multi-sheet
 * implicaría duplicar el writer. Para el uso real (mandar al contador) una
 * hoja con KPIs arriba + detalle abajo es más práctica que dos pestañas.
 */

import { writeXlsx } from './xlsx';

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
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Liberar la URL después de un tick — el browser ya disparó la descarga.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function generarComprobantesResumenXlsx({
  comprobantes = [],
  totales = { count: 0, total_monto: 0, total_financiera: 0, total_neto: 0 },
  periodoLabel = '',
  generadoEn = new Date(),
} = {}) {
  const aoa = [
    ['Tecny · Comprobantes — Resumen'],
    [`Período: ${periodoLabel || '—'}`],
    [
      'Cantidad', toNum(totales.count),
      'Bruto', toNum(totales.total_monto),
      'Retención', toNum(totales.total_financiera),
      'Neto a cobrar', toNum(totales.total_neto),
    ],
    [], // separador
    ['Fecha', 'Cliente', 'Vendedor', 'Referencia', 'Bruto', 'Retención', 'Neto'],
    ...comprobantes.map(c => [
      fmtFechaCorta(c.fecha),
      String(c.cliente || ''),
      String(c.vendedor_nombre || c.vendedor || ''),
      String(c.referencia || ''),
      toNum(c.monto),
      toNum(c.monto_financiera),
      toNum(c.monto_neto),
    ]),
    [
      'TOTAL', '', '', '',
      toNum(totales.total_monto),
      toNum(totales.total_financiera),
      toNum(totales.total_neto),
    ],
  ];

  const isoToday = generadoEn.toISOString().slice(0, 10);
  const sheetName = `Resumen ${isoToday}`.slice(0, 31);
  const blob = writeXlsx(aoa, { sheetName });
  downloadBlob(blob, `comprobantes_resumen_${isoToday}.xlsx`);
}
