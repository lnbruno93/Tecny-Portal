/**
 * generarComprobantePdf — recibe una venta y descarga un PDF estilo recibo.
 *
 * Lazy import: jspdf + jspdf-autotable + qrcode solo se cargan al usar el
 * botón "Descargar comprobante". A primera carga, la app no paga el costo.
 *
 * Layout (A4 portrait):
 *   1. Cabecera con marca + número de comprobante + fecha y hora
 *   2. Bloque "Cliente" con nombre + DNI + WhatsApp + email
 *   3. Bloque "Vendedor" (si aplica)
 *   4. Tabla de items con IMEI/serial integrado
 *   5. Resumen: total venta, total cobrado, diferencia (si la hay)
 *   6. Detalle de pagos
 *   7. Notas internas (si las hay)
 *   8. Garantía (texto completo de la plantilla)
 *   9. Pie: agradecimiento + QR con el order_id + timestamp
 */

const COLOR = {
  brand:      [34, 51, 84],   // azul oscuro corporativo
  brandSoft:  [99, 110, 140], // gris azulado para subtítulos
  pos:        [76, 175, 80],
  neg:        [220, 53, 69],
  text:       [60, 60, 60],
  textSoft:   [120, 120, 120],
  hairline:   [220, 220, 220],
  pageBg:     [248, 250, 252],
};

function fmtMoney(n, moneda = 'USD') {
  const sym = moneda === 'ARS' ? '$' : 'u$s';
  const num = Math.abs(Number(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (Number(n) < 0 ? '-' : '') + sym + ' ' + num;
}

function fmtFecha(s) {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : s;
}

function fmtHora(s) {
  if (!s) return '';
  // s puede ser 'HH:MM' o 'HH:MM:SS'
  return String(s).slice(0, 5);
}

// Setter helpers — siempre usamos args separados (jsPDF v4 NO acepta arrays)
function tc(doc, [r, g, b]) { doc.setTextColor(r, g, b); }
function fc(doc, [r, g, b]) { doc.setFillColor(r, g, b); }
function dc(doc, [r, g, b]) { doc.setDrawColor(r, g, b); }

/**
 * @param {object} venta — datos de la venta a imprimir (items, cliente, pagos, garantía…)
 * @param {object} [opts]
 * @param {string} [opts.tenantNombre] — nombre del negocio del tenant (owner-set).
 *   Se usa en el brand del header y en el pie del PDF. Fallback (2026-07-11):
 *   'Tu comercio' — placeholder neutro. Antes era 'Tecny' (brand del SaaS),
 *   pero eso confundía al cliente final cuando /me devolvía tenant:null por
 *   un cache miss o hiccup (bug reportado por Tek Haus). El fix real vive en
 *   /me (fallback query directo a tenants); este string solo activa si todo falla.
 */
export async function generarComprobantePdf(venta, opts = {}) {
  const tenantNombre = (opts.tenantNombre || '').trim() || 'Tu comercio';
  const { jsPDF } = await import('jspdf');
  const autoTableImport = await import('jspdf-autotable');
  const autoTable =
    typeof autoTableImport.default === 'function' ? autoTableImport.default :
    typeof autoTableImport.autoTable === 'function' ? autoTableImport.autoTable :
    typeof autoTableImport === 'function' ? autoTableImport :
    null;
  if (!autoTable) throw new Error('jspdf-autotable no disponible');

  const QRCode = await import('qrcode');

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth  = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  let y = 0;

  // ── 1. Cabecera con banda de color ───────────────────────
  // Banda fina con el azul de la marca arriba del todo
  fc(doc, COLOR.brand);
  doc.rect(0, 0, pageWidth, 6, 'F');

  y = 50;
  // Logo de texto con el nombre del negocio del tenant.
  // 2026-07-04 (#506): antes hardcoded "Tecny" (el brand del SaaS).
  // El brand del comprobante es del negocio del owner (ej. "Celnyx").
  //
  // 2026-07-04 auditoría TANDA 0: nombres largos (ej. "Celnyx Technology
  // Solutions SRL", 34 chars) desbordaban horizontalmente el header a
  // fontSize 28. Ajustamos el tamaño en 2 tiers:
  //   ≤16 chars → 28pt (default original)
  //   17-30    → 22pt (compacto pero visible)
  //   >30      → 18pt (comprimido, aún legible)
  // Los tiers se calcularon empíricamente en A4 con margin=40pt.
  const brandLen = tenantNombre.length;
  const brandFontSize = brandLen <= 16 ? 28 : brandLen <= 30 ? 22 : 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(brandFontSize);
  tc(doc, COLOR.brand);
  doc.text(tenantNombre, margin, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  tc(doc, COLOR.brandSoft);
  doc.text('COMPROBANTE DE VENTA', margin, y + 16);

  // Order ID + Fecha alineados a la derecha
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  tc(doc, COLOR.brand);
  doc.text(venta.order_id || `#${venta.id || ''}`, pageWidth - margin, y, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  tc(doc, COLOR.textSoft);
  const fechaHora = `${fmtFecha(venta.fecha)}${venta.hora ? ' · ' + fmtHora(venta.hora) : ''}`;
  doc.text(fechaHora, pageWidth - margin, y + 16, { align: 'right' });

  y += 40;
  dc(doc, COLOR.hairline);
  doc.line(margin, y, pageWidth - margin, y);
  y += 24;

  // ── 2. Cliente ───────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  tc(doc, COLOR.brandSoft);
  doc.text('CLIENTE', margin, y);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  tc(doc, COLOR.brand);
  const clienteNombre = [venta.cliente_nombre, venta.cliente_apellido].filter(Boolean).join(' ') || 'Consumidor final';
  doc.text(clienteNombre, margin, y + 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  tc(doc, COLOR.textSoft);
  const datosCliente = [];
  if (venta.cliente_dni)      datosCliente.push(`DNI: ${venta.cliente_dni}`);
  if (venta.cliente_telefono) datosCliente.push(`WhatsApp: ${venta.cliente_telefono}`);
  if (venta.cliente_email)    datosCliente.push(`Email: ${venta.cliente_email}`);
  if (datosCliente.length) {
    doc.text(datosCliente.join('   ·   '), margin, y + 32);
    y += 50;
  } else {
    y += 36;
  }

  // ── 3. Vendedor (si aplica) ──────────────────────────────
  if (venta.vendedor_nombre) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    tc(doc, COLOR.brandSoft);
    doc.text('ATENDIDO POR', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    tc(doc, COLOR.text);
    doc.text(venta.vendedor_nombre, margin, y + 14);
    y += 32;
  }

  // ── 4. Tabla de items (con IMEI integrado a la descripción) ──
  const items = Array.isArray(venta.items) ? venta.items : [];
  const itemRows = items.length === 0
    ? [['(Sin items)', '', '', '']]
    : items.map(it => {
        // Si tiene IMEI, lo agregamos como segunda línea en gris.
        const desc = it.imei
          ? `${it.descripcion || '—'}\nIMEI/Serial: ${it.imei}`
          : (it.descripcion || '—');
        return [
          String(desc),
          String(it.cantidad || 1),
          String(fmtMoney(it.precio_vendido, it.moneda || 'USD')),
          String(fmtMoney(Number(it.precio_vendido || 0) * Number(it.cantidad || 1), it.moneda || 'USD')),
        ];
      });

  autoTable(doc, {
    startY: y,
    head: [['Descripción', 'Cant.', 'Precio', 'Subtotal']],
    body: itemRows,
    theme: 'striped',
    headStyles: {
      fillColor: COLOR.brand, textColor: 255, fontSize: 10,
      cellPadding: { top: 8, right: 10, bottom: 8, left: 10 },
    },
    bodyStyles: {
      fontSize: 10, textColor: COLOR.text,
      cellPadding: { top: 8, right: 10, bottom: 8, left: 10 },
    },
    alternateRowStyles: { fillColor: COLOR.pageBg },
    columnStyles: {
      1: { halign: 'right', cellWidth: 50 },
      2: { halign: 'right', cellWidth: 90 },
      3: { halign: 'right', cellWidth: 90 },
    },
    margin: { left: margin, right: margin },
  });
  y = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : y + 100) + 20;

  // ── 5. Resumen ──────────────────────────────────────────
  const totalVenta   = Number(venta.total_usd || 0);
  const pagos        = Array.isArray(venta.pagos) ? venta.pagos : [];
  const totalCobrado = pagos.reduce((s, p) => s + Number(p.monto_usd || 0), 0);
  const dif          = totalCobrado - totalVenta;

  const resumenX = pageWidth - margin - 220;
  doc.setFontSize(10);

  tc(doc, COLOR.text);
  doc.text('Total venta:', resumenX, y);
  doc.setFont('helvetica', 'bold');
  tc(doc, COLOR.brand);
  doc.text(fmtMoney(totalVenta, 'USD'), pageWidth - margin, y, { align: 'right' });
  y += 16;

  doc.setFont('helvetica', 'normal');
  tc(doc, COLOR.text);
  doc.text('Total cobrado:', resumenX, y);
  doc.setFont('helvetica', 'bold');
  tc(doc, COLOR.pos);
  doc.text(fmtMoney(totalCobrado, 'USD'), pageWidth - margin, y, { align: 'right' });
  y += 16;

  if (Math.abs(dif) > 0.005) {
    doc.setFont('helvetica', 'normal');
    tc(doc, COLOR.text);
    doc.text(dif > 0 ? 'Diferencia (a favor):' : 'Diferencia (en contra):', resumenX, y);
    doc.setFont('helvetica', 'bold');
    if (dif > 0) tc(doc, COLOR.pos); else tc(doc, COLOR.neg);
    doc.text(fmtMoney(dif, 'USD'), pageWidth - margin, y, { align: 'right' });
    y += 16;
  }
  y += 14;

  // ── 6. Pagos ─────────────────────────────────────────────
  if (pagos.length) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    tc(doc, COLOR.brandSoft);
    doc.text('MEDIOS DE PAGO', margin, y);
    y += 6;

    const pagoRows = pagos.map(p => [
      String(p.metodo_nombre || (p.es_cuenta_corriente ? 'Cuenta corriente' : 'Pago')),
      String(fmtMoney(p.monto, p.moneda || 'USD')),
      String(p.moneda === 'ARS' && p.tc ? `(TC ${Number(p.tc).toLocaleString('es-AR')})` : ''),
      String(fmtMoney(p.monto_usd, 'USD')),
    ]);

    autoTable(doc, {
      startY: y,
      head: [['Método', 'Monto', '', 'Equivalente USD']],
      body: pagoRows,
      theme: 'plain',
      headStyles: { fontSize: 9, textColor: COLOR.textSoft, fontStyle: 'normal' },
      bodyStyles: { fontSize: 10, textColor: COLOR.text, cellPadding: { top: 6, right: 10, bottom: 6, left: 10 } },
      columnStyles: {
        1: { halign: 'right' },
        2: { halign: 'right', textColor: COLOR.textSoft, fontSize: 9 },
        3: { halign: 'right', fontStyle: 'bold' },
      },
      margin: { left: margin, right: margin },
    });
    y = (doc.lastAutoTable && doc.lastAutoTable.finalY ? doc.lastAutoTable.finalY : y + 60) + 18;
  }

  // ── 7. Notas internas ────────────────────────────────────
  if (venta.notas) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    tc(doc, COLOR.brandSoft);
    doc.text('NOTAS', margin, y);
    y += 12;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    tc(doc, COLOR.text);
    const notasLines = doc.splitTextToSize(String(venta.notas), pageWidth - margin * 2);
    doc.text(notasLines, margin, y);
    y += notasLines.length * 12 + 14;
  }

  // ── 8. Garantía ─────────────────────────────────────────
  if (venta.garantia_texto || venta.garantia_nombre) {
    // Si llegamos cerca del final, paginamos
    if (y > pageHeight - 180) {
      doc.addPage();
      y = 50;
    }
    dc(doc, COLOR.hairline);
    doc.line(margin, y, pageWidth - margin, y);
    y += 16;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    tc(doc, COLOR.brand);
    doc.text(venta.garantia_nombre ? `Garantía — ${venta.garantia_nombre}` : 'Garantía', margin, y);
    y += 14;

    if (venta.garantia_texto) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      tc(doc, COLOR.text);
      const garLines = doc.splitTextToSize(String(venta.garantia_texto), pageWidth - margin * 2);
      // Si el texto no entra, paginamos
      if (y + garLines.length * 11 > pageHeight - 100) {
        doc.addPage();
        y = 50;
        // Re-imprimir título en la página nueva para contexto
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        tc(doc, COLOR.brand);
        doc.text(venta.garantia_nombre ? `Garantía — ${venta.garantia_nombre} (cont.)` : 'Garantía (cont.)', margin, y);
        y += 14;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        tc(doc, COLOR.text);
      }
      doc.text(garLines, margin, y);
      y += garLines.length * 11 + 18;
    }
  }

  // ── 9. Pie: agradecimiento + QR + timestamp ──────────────
  // QR con el order_id (escaneable para validar el comprobante)
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(String(venta.order_id || venta.id || ''), {
      width: 200, margin: 0, errorCorrectionLevel: 'M',
      color: { dark: '#223354', light: '#ffffff' },
    });
  } catch { /* si falla el QR, seguimos sin él */ }

  const footerY = pageHeight - 80;
  if (qrDataUrl) {
    doc.addImage(qrDataUrl, 'PNG', margin, footerY - 12, 60, 60);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    tc(doc, COLOR.textSoft);
    doc.text(`Código de verificación`, margin + 70, footerY + 4);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    tc(doc, COLOR.text);
    doc.text(venta.order_id || `#${venta.id || ''}`, margin + 70, footerY + 18);
  }

  // Agradecimiento alineado a la derecha con nombre del negocio.
  // 2026-07-04 (#506 follow-up): antes decía "¡Gracias por tu compra!" genérico,
  // ahora incluye el nombre del negocio para paridad con el backend (email PDF)
  // que ya usaba `Gracias por tu compra en ${tenant.nombre}`.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  tc(doc, COLOR.brand);
  doc.text(`¡Gracias por tu compra en ${tenantNombre}!`, pageWidth - margin, footerY + 8, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  tc(doc, COLOR.textSoft);
  doc.text(
    `Generado el ${new Date().toLocaleString('es-AR')} · ${tenantNombre}`,
    pageWidth - margin,
    footerY + 24,
    { align: 'right' }
  );

  // Línea decorativa al pie
  fc(doc, COLOR.brand);
  doc.rect(0, pageHeight - 6, pageWidth, 6, 'F');

  const filename = `comprobante-${venta.order_id || venta.id || 'venta'}.pdf`;
  doc.save(filename);
}

export default generarComprobantePdf;
