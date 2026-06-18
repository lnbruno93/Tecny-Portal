/**
 * generarComprobantesResumenPdf — genera un PDF con el resumen del período
 * filtrado en Comprobantes (Financiera).
 *
 * Input: { comprobantes, totales, periodoLabel, generadoEn }
 *   comprobantes:   array del listado actual (mismo shape que compApi.list().data)
 *   totales:        { count, total_monto, total_financiera, total_neto }
 *   periodoLabel:   string ya formateada — ej. "Este mes" o "01/06/2026 – 30/06/2026"
 *   generadoEn:     Date opcional (default = ahora)
 *
 * Layout A4 portrait:
 *   · Header: marca + título + período
 *   · KPIs box: cantidad, bruto, retención, neto
 *   · Tabla detalle (Fecha, Cliente, Vendedor, Ref, Bruto, Retención, Neto)
 *   · Footer auto: número de página + totales repetidos en última hoja
 *
 * Lazy imports: jspdf + jspdf-autotable. Sin costo en first load.
 */

const COLOR = {
  brand:      [34, 51, 84],
  brandSoft:  [99, 110, 140],
  text:       [60, 60, 60],
  textSoft:   [120, 120, 120],
  hairline:   [220, 220, 220],
  bgKpi:      [245, 248, 252],
};

function fmtARS(n) {
  const v = Number(n) || 0;
  return '$ ' + Math.round(v).toLocaleString('es-AR');
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

export async function generarComprobantesResumenPdf({
  comprobantes = [],
  totales = { count: 0, total_monto: 0, total_financiera: 0, total_neto: 0 },
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
  const M = 15; // margen lateral

  // ── 1. Header ─────────────────────────────────────────────
  fc(doc, COLOR.brand);
  doc.rect(0, 0, PAGE_W, 26, 'F');
  tc(doc, [255, 255, 255]);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('Tecny · Comprobantes', M, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const subtitle = `Resumen ${periodoLabel ? '· ' + periodoLabel : ''}`.trim();
  doc.text(subtitle, M, 20);

  // Fecha de generación a la derecha
  doc.setFontSize(9);
  const gen = `Generado: ${fmtFecha(generadoEn.toISOString())} ${String(generadoEn.getHours()).padStart(2, '0')}:${String(generadoEn.getMinutes()).padStart(2, '0')}`;
  const genW = doc.getTextWidth(gen);
  doc.text(gen, PAGE_W - M - genW, 20);

  // ── 2. KPIs box ───────────────────────────────────────────
  const KPI_Y = 34;
  const KPI_H = 22;
  fc(doc, COLOR.bgKpi);
  dc(doc, COLOR.hairline);
  doc.roundedRect(M, KPI_Y, PAGE_W - M * 2, KPI_H, 2, 2, 'FD');

  const cellW = (PAGE_W - M * 2) / 4;
  const kpis = [
    { label: 'Cantidad',    value: String(totales.count || 0) },
    { label: 'Bruto',       value: fmtARS(totales.total_monto) },
    { label: 'Retención',   value: fmtARS(totales.total_financiera) },
    { label: 'Neto a cobrar', value: fmtARS(totales.total_neto) },
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

  // ── 3. Tabla detalle ──────────────────────────────────────
  const head = [['Fecha', 'Cliente', 'Vendedor', 'Referencia', 'Bruto', 'Retención', 'Neto']];
  const body = comprobantes.map(c => [
    fmtFecha(c.fecha),
    String(c.cliente || '').slice(0, 38),
    String(c.vendedor_nombre || c.vendedor || '—').slice(0, 18),
    String(c.referencia || '—').slice(0, 22),
    { content: fmtARS(c.monto), styles: { halign: 'right' } },
    { content: fmtARS(c.monto_financiera), styles: { halign: 'right' } },
    { content: fmtARS(c.monto_neto), styles: { halign: 'right', fontStyle: 'bold' } },
  ]);

  // Fila final de totales — la repetimos a mano (autoTable no soporta footer per-page de forma simple)
  const footRow = [
    { content: 'TOTAL', colSpan: 4, styles: { fontStyle: 'bold', halign: 'right' } },
    { content: fmtARS(totales.total_monto), styles: { halign: 'right', fontStyle: 'bold' } },
    { content: fmtARS(totales.total_financiera), styles: { halign: 'right', fontStyle: 'bold' } },
    { content: fmtARS(totales.total_neto), styles: { halign: 'right', fontStyle: 'bold' } },
  ];

  autoTable(doc, {
    head,
    body,
    foot: [footRow],
    startY: KPI_Y + KPI_H + 6,
    margin: { left: M, right: M },
    styles: { fontSize: 8.5, cellPadding: 2, textColor: COLOR.text, lineColor: COLOR.hairline },
    headStyles: { fillColor: COLOR.brand, textColor: [255, 255, 255], fontStyle: 'bold' },
    footStyles: { fillColor: COLOR.bgKpi, textColor: COLOR.brand },
    alternateRowStyles: { fillColor: [252, 253, 254] },
    columnStyles: {
      0: { cellWidth: 18 },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 24 },
      3: { cellWidth: 28 },
      4: { cellWidth: 22, halign: 'right' },
      5: { cellWidth: 22, halign: 'right' },
      6: { cellWidth: 24, halign: 'right' },
    },
    // Footer con número de página
    didDrawPage: (data) => {
      const pageCount = doc.internal.getNumberOfPages();
      const pageNum = data.pageNumber;
      tc(doc, COLOR.textSoft);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(
        `Página ${pageNum} de ${pageCount}`,
        PAGE_W / 2,
        doc.internal.pageSize.getHeight() - 8,
        { align: 'center' }
      );
    },
  });

  // ── 4. Save ───────────────────────────────────────────────
  const isoToday = generadoEn.toISOString().slice(0, 10);
  doc.save(`comprobantes_resumen_${isoToday}.pdf`);
}
