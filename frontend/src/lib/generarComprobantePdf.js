/**
 * generarComprobantePdf — recibe una venta y descarga un PDF estilo recibo.
 *
 * Lazy import de jspdf para no inflar el bundle inicial: el módulo solo se
 * carga cuando el operador clickea "Descargar comprobante". A primera carga,
 * la app no paga el costo (~80kb gz).
 *
 * Layout (A4 portrait):
 *   1. Cabecera con marca + order_id + fecha
 *   2. Bloque Cliente
 *   3. Tabla de items (descripción / cant / precio / subtotal)
 *   4. Resumen: total venta, total cobrado, diferencia (si la hay)
 *   5. Detalle de pagos
 *   6. Pie con notas
 */

function fmtMoney(n, moneda = 'USD') {
  const sym = moneda === 'ARS' ? '$' : 'u$s';
  const num = Math.abs(Number(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (Number(n) < 0 ? '-' : '') + sym + ' ' + num;
}

function fmtFecha(s) {
  if (!s) return '';
  // s puede ser '2026-05-29' o ISO; tomamos la fecha cruda en AR
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : s;
}

export async function generarComprobantePdf(venta) {
  // Lazy import: solo cargar jspdf al usar
  const { jsPDF } = await import('jspdf');
  const autoTableMod = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod.autoTable;

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = 50;

  // ── 1. Cabecera ──────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(34, 51, 84);
  doc.text('iPro', margin, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text('Comprobante de venta', margin, y + 14);

  // Order ID + Fecha (alineados a la derecha)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(34, 51, 84);
  doc.text(venta.order_id || `#${venta.id}`, pageWidth - margin, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(fmtFecha(venta.fecha), pageWidth - margin, y + 14, { align: 'right' });

  y += 36;
  doc.setDrawColor(220);
  doc.line(margin, y, pageWidth - margin, y);
  y += 20;

  // ── 2. Cliente ───────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(60);
  doc.text('Cliente', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(34, 51, 84);
  doc.text(venta.cliente_nombre || 'Consumidor final', margin + 60, y);
  y += 24;

  // ── 3. Tabla de items ────────────────────────────────────
  const items = venta.items || [];
  const itemRows = items.map(it => [
    it.descripcion || '',
    String(it.cantidad || 1),
    fmtMoney(it.precio_vendido, it.moneda || 'USD'),
    fmtMoney(Number(it.precio_vendido || 0) * Number(it.cantidad || 1), it.moneda || 'USD'),
  ]);

  autoTable(doc, {
    startY: y,
    head: [['Descripción', 'Cant.', 'Precio', 'Subtotal']],
    body: itemRows,
    theme: 'striped',
    headStyles: { fillColor: [34, 51, 84], textColor: 255, fontSize: 10 },
    bodyStyles: { fontSize: 10, textColor: 60 },
    columnStyles: {
      1: { halign: 'right', cellWidth: 50 },
      2: { halign: 'right', cellWidth: 80 },
      3: { halign: 'right', cellWidth: 80 },
    },
    margin: { left: margin, right: margin },
  });
  y = doc.lastAutoTable.finalY + 20;

  // ── 4. Resumen ──────────────────────────────────────────
  const totalVenta = Number(venta.total_usd || 0);
  const pagos = venta.pagos || [];
  const totalCobrado = pagos.reduce((s, p) => s + Number(p.monto_usd || 0), 0);
  const dif = totalCobrado - totalVenta;

  const resumenX = pageWidth - margin - 220;
  doc.setFontSize(10);

  doc.setTextColor(60);
  doc.text('Total venta:', resumenX, y);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(34, 51, 84);
  doc.text(fmtMoney(totalVenta, 'USD'), pageWidth - margin, y, { align: 'right' });
  y += 16;

  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60);
  doc.text('Total cobrado:', resumenX, y);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(76, 175, 80);
  doc.text(fmtMoney(totalCobrado, 'USD'), pageWidth - margin, y, { align: 'right' });
  y += 16;

  if (Math.abs(dif) > 0.005) {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(60);
    doc.text(dif > 0 ? 'Diferencia (a favor):' : 'Diferencia (en contra):', resumenX, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(dif > 0 ? [76, 175, 80] : [220, 53, 69]);
    doc.text(fmtMoney(dif, 'USD'), pageWidth - margin, y, { align: 'right' });
    y += 16;
  }
  y += 12;

  // ── 5. Pagos ─────────────────────────────────────────────
  if (pagos.length) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(60);
    doc.text('Medios de pago', margin, y);
    y += 10;

    const pagoRows = pagos.map(p => [
      p.metodo_nombre || (p.es_cuenta_corriente ? 'Cuenta corriente' : 'Pago'),
      fmtMoney(p.monto, p.moneda || 'USD'),
      p.moneda === 'ARS' && p.tc ? `(TC ${Number(p.tc).toLocaleString('es-AR')})` : '',
      fmtMoney(p.monto_usd, 'USD'),
    ]);

    autoTable(doc, {
      startY: y,
      head: [['Método', 'Monto', '', 'USD']],
      body: pagoRows,
      theme: 'plain',
      headStyles: { fontSize: 9, textColor: 120, fontStyle: 'normal' },
      bodyStyles: { fontSize: 10, textColor: 60 },
      columnStyles: {
        1: { halign: 'right' },
        2: { halign: 'right', textColor: 150, fontSize: 9 },
        3: { halign: 'right', fontStyle: 'bold' },
      },
      margin: { left: margin, right: margin },
    });
    y = doc.lastAutoTable.finalY + 20;
  }

  // ── 6. Notas y pie ───────────────────────────────────────
  if (venta.notas) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120);
    const notasLines = doc.splitTextToSize(`Notas: ${venta.notas}`, pageWidth - margin * 2);
    doc.text(notasLines, margin, y);
    y += notasLines.length * 12 + 10;
  }

  // Pie con marca de tiempo
  doc.setFontSize(8);
  doc.setTextColor(160);
  doc.text(
    `Generado el ${new Date().toLocaleString('es-AR')} · iPro Portal`,
    margin,
    doc.internal.pageSize.getHeight() - 30
  );

  // Descarga
  const filename = `comprobante-${venta.order_id || venta.id || 'venta'}.pdf`;
  doc.save(filename);
}

export default generarComprobantePdf;
