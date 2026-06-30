/**
 * Generador de PDF del comprobante de venta retail (#475).
 *
 * Decisiones técnicas:
 *   - Usamos `pdfkit` (no puppeteer/chrome-headless). Razones:
 *     (a) Lightweight — sin chromium download (~150MB) ni runtime overhead.
 *         Esto importa porque Railway tiene cap de RAM/CPU y armar un
 *         chromium por request mata el tier económico.
 *     (b) Output determinístico: el mismo input siempre da el mismo bytecount.
 *         Útil para tests con snapshot del size.
 *     (c) Streaming-first: pdfkit emite chunks, los acumulamos en un Buffer
 *         del lado nuestro y lo pasamos a Resend como attachment binario.
 *
 * Layout (A5, 1 página):
 *   ┌──────────────────────────────────────┐
 *   │ {tenant.nombre}               #ORD-…│  ← header
 *   │ Comprobante de venta · {fecha}      │
 *   ├──────────────────────────────────────┤
 *   │ Cliente: {cliente_nombre}            │
 *   │                                       │
 *   │ Items                                │
 *   │ ─────────                            │
 *   │ Descripción         Cant  Precio    │
 *   │ iPhone 15 Pro …      1   USD 950.00 │
 *   │ ─────────                            │
 *   │                Total: USD 950.00     │
 *   │                                       │
 *   │ Pagos:                                │
 *   │ - USD | Efectivo: USD 950.00         │
 *   ├──────────────────────────────────────┤
 *   │ {tenant_footer_custom_o_default}     │  ← footer
 *   └──────────────────────────────────────┘
 *
 * El layout es deliberadamente CONSERVADOR — sin imágenes, sin colores fuertes,
 * sin fonts custom (Helvetica viene built-in con pdfkit, no requiere asset
 * extra). Razón: maximizar compatibilidad con clients de email + viewers PDF
 * antiguos que el cliente final pueda usar.
 */

const PDFDocument = require('pdfkit');

const FOOTER_DEFAULT = 'Gracias por tu compra. Generado con Tecny.';

/**
 * Helper para formatear moneda. Usa Intl.NumberFormat para AR/UY locale.
 * Acepta numeros con coma o punto; output: "USD 950.00" / "$ 1.234.567,89".
 */
function fmtMoney(monto, moneda, pais = 'AR') {
  const n = Number(monto);
  if (!Number.isFinite(n)) return `${moneda} —`;
  // Intl.NumberFormat con locale fijo para que la salida sea reproducible
  // (no depende del locale del runtime). UY usa es-UY (mismo formato pero
  // moneda local UYU; AR usa es-AR con ARS).
  const locale = pais === 'UY' ? 'es-UY' : 'es-AR';
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  // Prefix la moneda explícita (no usamos style:'currency' porque mete
  // símbolos que confunden cross-divisa: el cliente final puede no saber
  // qué moneda usa "$").
  return `${moneda} ${formatted}`;
}

function fmtFecha(fecha) {
  if (!fecha) return '';
  // Acepta tanto 'YYYY-MM-DD' como Date object. Output: 'DD/MM/YYYY'.
  const s = String(fecha).slice(0, 10);
  const [y, m, d] = s.split('-');
  if (!y || !m || !d) return s;
  return `${d}/${m}/${y}`;
}

/**
 * Genera el PDF del comprobante como Buffer.
 *
 * @param {object} opts
 * @param {object} opts.venta - { id, order_id, fecha, total_usd, tc_venta, cliente_nombre, notas, items[], pagos[] }
 * @param {object} opts.tenant - { nombre, comprobante_email_footer, pais }
 * @returns {Promise<Buffer>}
 */
async function generarComprobantePdf({ venta, tenant, _compress = true }) {
  if (!venta) throw new Error('generarComprobantePdf: venta requerida');
  if (!tenant) throw new Error('generarComprobantePdf: tenant requerido');

  const pais = tenant.pais || 'AR';
  const items = Array.isArray(venta.items) ? venta.items : [];
  const pagos = Array.isArray(venta.pagos) ? venta.pagos : [];

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A5',
      margin: 36,
      // Por default pdfkit zlib-comprime los text streams del PDF. En tests
      // que inspeccionan el buffer (e.g. assertar footer custom) eso vuelve
      // el texto invisible al `.toString()`. Param interno `_compress=false`
      // permite a los tests pasar texto plano. Prod siempre usa `true` (PDFs
      // más livianos para el adjunto del email).
      compress: _compress,
      info: {
        Title:    `Comprobante ${venta.order_id || `#${venta.id}`}`,
        Author:   tenant.nombre || 'Tecny',
        Subject:  'Comprobante de venta retail',
        Creator:  'Tecny Portal',
        Producer: 'Tecny Portal · pdfkit',
      },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header: nombre del tenant + n° de orden ────────────────────────
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#0d1220');
    doc.text(tenant.nombre || 'Tecny', { continued: false });
    doc.moveDown(0.2);

    doc.font('Helvetica').fontSize(10).fillColor('#76705c');
    const orderTxt = venta.order_id ? `Comprobante ${venta.order_id}` : `Comprobante #${venta.id}`;
    const fechaTxt = venta.fecha ? ` · ${fmtFecha(venta.fecha)}` : '';
    doc.text(`${orderTxt}${fechaTxt}`);

    // Divisor horizontal sutil.
    doc.moveDown(0.5);
    const xStart = doc.page.margins.left;
    const xEnd   = doc.page.width - doc.page.margins.right;
    doc.strokeColor('#e0d8c4').lineWidth(0.5).moveTo(xStart, doc.y).lineTo(xEnd, doc.y).stroke();
    doc.moveDown(0.5);

    // ── Cliente ─────────────────────────────────────────────────────────
    if (venta.cliente_nombre) {
      doc.font('Helvetica').fontSize(10).fillColor('#3f3a2c');
      doc.text(`Cliente: ${venta.cliente_nombre}`);
      doc.moveDown(0.5);
    }

    // ── Items table ─────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0d1220');
    doc.text('Detalle');
    doc.moveDown(0.3);

    // Header de columnas. Layout simple: 3 cols (Descripción, Cant, Precio).
    // Sin "tabla" real (pdfkit obliga a calcular x manual) — usamos columns
    // text-aligned: descripción left, cant + precio right.
    const colDescX  = xStart;
    const colCantX  = xEnd - 130;
    const colPrecX  = xEnd - 80;
    const colWidth  = xEnd - xStart;
    const descWidth = colCantX - colDescX - 4;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#76705c');
    doc.text('Descripción', colDescX, doc.y, { width: descWidth, continued: false });
    const headerY = doc.y - 11; // pdfkit avanzó y; volvemos para alinear cant + precio
    doc.text('Cant.',     colCantX, headerY, { width: 40, align: 'right' });
    doc.text('Precio',    colPrecX, headerY, { width: 80, align: 'right' });
    doc.moveDown(0.2);

    // Línea divisor de header.
    doc.strokeColor('#e0d8c4').lineWidth(0.3).moveTo(xStart, doc.y).lineTo(xEnd, doc.y).stroke();
    doc.moveDown(0.3);

    // Rows
    doc.font('Helvetica').fontSize(10).fillColor('#1c1a14');
    for (const it of items) {
      const desc = String(it.descripcion || '(sin descripción)');
      const cant = Number(it.cantidad) || 1;
      const moneda = it.moneda || 'USD';
      const precioUnit = Number(it.precio_vendido) || 0;
      const precioTotal = precioUnit * cant;
      const yBeforeRow = doc.y;

      doc.text(desc, colDescX, yBeforeRow, { width: descWidth });
      const yAfterDesc = doc.y;

      // Volver al y de la row (puede que la descripción wrappeara) para alinear
      // cant + precio.
      doc.text(String(cant), colCantX, yBeforeRow, { width: 40, align: 'right' });
      doc.text(fmtMoney(precioTotal, moneda, pais), colPrecX, yBeforeRow, {
        width: 80, align: 'right',
      });

      // Avanzar al máximo de las 3 cols (la descripción puede ser la más
      // alta si wrappeó).
      doc.y = Math.max(yAfterDesc, doc.y);
      doc.moveDown(0.15);

      // IMEI debajo si aplica (línea fina).
      if (it.imei) {
        doc.font('Helvetica').fontSize(8).fillColor('#76705c');
        doc.text(`  IMEI: ${it.imei}`, colDescX, doc.y, { width: descWidth });
        doc.font('Helvetica').fontSize(10).fillColor('#1c1a14');
        doc.moveDown(0.1);
      }
    }
    doc.moveDown(0.3);
    doc.strokeColor('#e0d8c4').lineWidth(0.3).moveTo(xStart, doc.y).lineTo(xEnd, doc.y).stroke();
    doc.moveDown(0.4);

    // ── Total ───────────────────────────────────────────────────────────
    // El total siempre se muestra en USD (es el invariante del portal — la
    // venta puede tener items en ARS pero `ventas.total_usd` está siempre
    // computado al TC de la venta).
    const totalUsd = Number(venta.total_usd) || 0;
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#0d1220');
    const totalLabel = 'Total';
    const totalValue = fmtMoney(totalUsd, 'USD', pais);
    doc.text(`${totalLabel}: ${totalValue}`, xStart, doc.y, {
      width: colWidth, align: 'right',
    });

    // TC info (opcional): si la venta tuvo items en moneda local, mostrar TC.
    if (venta.tc_venta && items.some(i => i.moneda !== 'USD' && i.moneda !== 'USDT')) {
      doc.font('Helvetica').fontSize(8).fillColor('#76705c');
      doc.text(`TC de la venta: ${Number(venta.tc_venta).toLocaleString(pais === 'UY' ? 'es-UY' : 'es-AR')}`,
        xStart, doc.y + 2, { width: colWidth, align: 'right' });
      doc.font('Helvetica').fontSize(10).fillColor('#1c1a14');
    }
    doc.moveDown(0.6);

    // ── Pagos ───────────────────────────────────────────────────────────
    if (pagos.length > 0) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0d1220');
      doc.text('Pagos', xStart, doc.y);
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(9).fillColor('#3f3a2c');
      for (const p of pagos) {
        const metodo = p.metodo_nombre || '(sin método)';
        const monto = Number(p.monto) || 0;
        const moneda = p.moneda || 'USD';
        doc.text(`· ${metodo}: ${fmtMoney(monto, moneda, pais)}`, xStart, doc.y);
      }
      doc.moveDown(0.5);
    }

    // ── Notas (opcional) ────────────────────────────────────────────────
    if (venta.notas) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#76705c');
      doc.text(`Notas: ${venta.notas}`, xStart, doc.y, { width: colWidth });
      doc.moveDown(0.4);
    }

    // ── Footer ──────────────────────────────────────────────────────────
    // El footer va al final del page area (no fixed-position absoluto —
    // pdfkit hace mas robusto fluir desde el bottom). Si el contenido ya
    // pasó el bottom area, el footer se acomoda inline.
    const footerY = Math.max(doc.y + 20, doc.page.height - doc.page.margins.bottom - 50);
    doc.y = footerY;
    doc.strokeColor('#e0d8c4').lineWidth(0.3).moveTo(xStart, doc.y).lineTo(xEnd, doc.y).stroke();
    doc.moveDown(0.4);

    const footerCustom = (tenant.comprobante_email_footer || '').trim();
    const footerText = footerCustom || `Gracias por tu compra en ${tenant.nombre || 'Tecny'}.`;
    doc.font('Helvetica').fontSize(8).fillColor('#76705c');
    doc.text(footerText, xStart, doc.y, { width: colWidth, align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(7).fillColor('#9c957f');
    doc.text(FOOTER_DEFAULT, xStart, doc.y, { width: colWidth, align: 'center' });

    doc.end();
  });
}

module.exports = {
  generarComprobantePdf,
  // Exportados para tests / debugging.
  _fmtMoney: fmtMoney,
  _fmtFecha: fmtFecha,
  _FOOTER_DEFAULT: FOOTER_DEFAULT,
};
