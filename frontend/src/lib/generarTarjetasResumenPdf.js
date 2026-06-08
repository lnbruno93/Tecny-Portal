/**
 * generarTarjetasResumenPdf — genera un PDF con el resumen del estado de
 * cuenta de Tarjetas en el período filtrado.
 *
 * Input: { movimientos, totales, periodoLabel, generadoEn }
 *   movimientos:    array del estado de cuenta (tarjetasApi.movimientosAll().data)
 *   totales:        { count, ARS:{...}, USD:{...}, USDT:{...} } — shape de
 *                   tarjetasApi.movimientosTotales(); ver backend para detalle.
 *   periodoLabel:   string ya formateada — ej. "Este mes" o "01/06 – 30/06"
 *   generadoEn:     Date opcional (default = ahora)
 *
 * Layout A4 portrait:
 *   · Header con marca + título + período + fecha de generación
 *   · KPIs box en ARS (la moneda dominante). Si hay USD/USDT, una nota chica
 *     bajo el header indica los montos extra (mantiene el header compacto).
 *   · Tabla detalle: Fecha | Tarjeta | Tipo | Moneda | Bruto | Comisión | Neto
 *   · Footer con número de página
 *
 * Lazy imports: jspdf + jspdf-autotable.
 */

const COLOR = {
  brand:      [34, 51, 84],
  text:       [60, 60, 60],
  textSoft:   [120, 120, 120],
  hairline:   [220, 220, 220],
  bgKpi:      [245, 248, 252],
  pos:        [76, 175, 80],
  neg:        [220, 53, 69],
};

function fmtMoney(n, moneda = 'ARS') {
  const v = Number(n) || 0;
  const sym = moneda === 'USD' ? 'u$s ' : moneda === 'USDT' ? 'USDT ' : '$ ';
  return sym + Math.round(Math.abs(v)).toLocaleString('es-AR');
}
function fmtFecha(s) {
  if (!s) return '';
  const iso = String(s).slice(0, 10);
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}
function tc(doc, [r, g, b]) { doc.setTextColor(r, g, b); }
function fc(doc, [r, g, b]) { doc.setFillColor(r, g, b); }
function dc(doc, [r, g, b]) { doc.setDrawColor(r, g, b); }

export async function generarTarjetasResumenPdf({
  movimientos = [],
  totales = { count: 0, ARS: {}, USD: {}, USDT: {} },
  periodoLabel = '',
  generadoEn = new Date(),
} = {}) {
  const { jsPDF } = await import('jspdf');
  const autoTableImport = await import('jspdf-autotable');
  const autoTable =
    typeof autoTableImport.default === 'function' ? autoTableImport.default :
    typeof autoTableImport.autoTable === 'function' ? autoTableImport.autoTable :
    typeof autoTableImport === 'function' ? autoTableImport :
    null;
  if (!autoTable) throw new Error('jspdf-autotable no disponible');

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const M = 15;

  // ── 1. Header ─────────────────────────────────────────────
  fc(doc, COLOR.brand);
  doc.rect(0, 0, PAGE_W, 26, 'F');
  tc(doc, [255, 255, 255]);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('iPro · Tarjetas', M, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const subtitle = `Estado de cuenta ${periodoLabel ? '· ' + periodoLabel : ''}`.trim();
  doc.text(subtitle, M, 20);

  doc.setFontSize(9);
  const gen = `Generado: ${fmtFecha(generadoEn.toISOString())} ${String(generadoEn.getHours()).padStart(2, '0')}:${String(generadoEn.getMinutes()).padStart(2, '0')}`;
  doc.text(gen, PAGE_W - M - doc.getTextWidth(gen), 20);

  // ── 2. KPIs box (en ARS — moneda dominante) ───────────────
  const ars = totales.ARS || {};
  const usd = totales.USD || {};
  const usdt = totales.USDT || {};

  const KPI_Y = 34;
  const KPI_H = 22;
  fc(doc, COLOR.bgKpi);
  dc(doc, COLOR.hairline);
  doc.roundedRect(M, KPI_Y, PAGE_W - M * 2, KPI_H, 2, 2, 'FD');

  const cellW = (PAGE_W - M * 2) / 4;
  const kpis = [
    { label: 'Movimientos',     value: String(totales.count || 0) },
    { label: 'Cobrado bruto',   value: fmtMoney(ars.cobros_bruto, 'ARS') },
    { label: 'Comisión',        value: fmtMoney(ars.comision, 'ARS') },
    { label: 'Neto a recibir',  value: fmtMoney(ars.saldo_periodo, 'ARS') },
  ];
  kpis.forEach((k, i) => {
    const x = M + cellW * i + cellW / 2;
    tc(doc, COLOR.textSoft);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(k.label.toUpperCase(), x, KPI_Y + 7, { align: 'center' });
    tc(doc, COLOR.brand);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(k.value, x, KPI_Y + 16, { align: 'center' });
  });

  // Nota multi-moneda — solo si hay movimientos USD o USDT.
  let nextY = KPI_Y + KPI_H + 6;
  const tieneUsd  = (usd.total_count  || 0) > 0;
  const tieneUsdt = (usdt.total_count || 0) > 0;
  if (tieneUsd || tieneUsdt) {
    tc(doc, COLOR.textSoft);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8.5);
    const parts = [];
    if (tieneUsd)  parts.push(`USD: ${usd.total_count} movs · neto ${fmtMoney(usd.saldo_periodo, 'USD')}`);
    if (tieneUsdt) parts.push(`USDT: ${usdt.total_count} movs · neto ${fmtMoney(usdt.saldo_periodo, 'USDT')}`);
    const nota = `KPIs en ARS · ${parts.join(' · ')} (detalle abajo)`;
    doc.text(nota, M, nextY);
    nextY += 6;
  }

  // ── 3. Tabla detalle ──────────────────────────────────────
  const head = [['Fecha', 'Tarjeta', 'Tipo', 'Mon.', 'Bruto', 'Comisión', 'Neto']];
  const body = movimientos.map(m => {
    const esCobro = m.tipo === 'cobro';
    return [
      fmtFecha(m.fecha),
      String(m.metodo_nombre || '—').slice(0, 16),
      esCobro ? 'Cobro' : 'Liquidación',
      String(m.moneda || 'ARS'),
      { content: esCobro ? fmtMoney(m.monto_bruto, m.moneda) : '—', styles: { halign: 'right' } },
      { content: esCobro ? fmtMoney(m.monto_comision, m.moneda) : '—', styles: { halign: 'right' } },
      {
        content: (esCobro ? '+' : '−') + fmtMoney(m.monto_neto, m.moneda),
        styles: { halign: 'right', fontStyle: 'bold', textColor: esCobro ? COLOR.pos : COLOR.neg },
      },
    ];
  });

  const footRow = [
    { content: 'TOTAL ARS', colSpan: 4, styles: { fontStyle: 'bold', halign: 'right' } },
    { content: fmtMoney(ars.cobros_bruto, 'ARS'), styles: { halign: 'right', fontStyle: 'bold' } },
    { content: fmtMoney(ars.comision, 'ARS'),     styles: { halign: 'right', fontStyle: 'bold' } },
    { content: fmtMoney(ars.saldo_periodo, 'ARS'),styles: { halign: 'right', fontStyle: 'bold' } },
  ];

  autoTable(doc, {
    head,
    body,
    foot: [footRow],
    startY: nextY,
    margin: { left: M, right: M },
    styles: { fontSize: 8.5, cellPadding: 2, textColor: COLOR.text, lineColor: COLOR.hairline },
    headStyles: { fillColor: COLOR.brand, textColor: [255, 255, 255], fontStyle: 'bold' },
    footStyles: { fillColor: COLOR.bgKpi, textColor: COLOR.brand },
    alternateRowStyles: { fillColor: [252, 253, 254] },
    columnStyles: {
      0: { cellWidth: 20 },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 22 },
      3: { cellWidth: 12, halign: 'center' },
      4: { cellWidth: 24, halign: 'right' },
      5: { cellWidth: 24, halign: 'right' },
      6: { cellWidth: 28, halign: 'right' },
    },
    didDrawPage: (data) => {
      const pageCount = doc.internal.getNumberOfPages();
      tc(doc, COLOR.textSoft);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(
        `Página ${data.pageNumber} de ${pageCount}`,
        PAGE_W / 2,
        doc.internal.pageSize.getHeight() - 8,
        { align: 'center' }
      );
    },
  });

  const isoToday = generadoEn.toISOString().slice(0, 10);
  doc.save(`tarjetas_resumen_${isoToday}.pdf`);
}
