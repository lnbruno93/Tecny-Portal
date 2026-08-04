/**
 * detalleXlsx — helper compartido para descargar como XLSX el detalle de un
 * movimiento (venta B2B, compra a proveedor, operación Red B2B, etc.).
 *
 * Consume writeXlsx (lib/xlsx.js, implementación propia sin deps externas)
 * + downloadBlob (lib/downloadBlob.js). Genera un aoa (array-of-arrays)
 * con este layout:
 *
 *   Fila 1..N  — Header metadata (Fecha | Cliente | Monto USD | Descripción...)
 *                Formato "Label: value" en 2 columnas para lectura rápida
 *   Fila vacía separadora
 *   Fila M     — Nombres de columnas de items (Producto, Modelo, Color, IMEI, Valor USD...)
 *   Fila M+1..K — Rows de items
 *   Fila vacía
 *   Fila final — "Total: X" con la suma (opcional)
 *
 * @example
 *   downloadDetalleXlsx({
 *     filename: `venta-b2b-2026-08-04-#123`,
 *     sheetName: 'Detalle',
 *     header: [
 *       { label: 'Fecha',        value: '04/08/2026' },
 *       { label: 'Cliente',      value: 'pato VIP' },
 *       { label: 'Monto USD',    value: 1390 },
 *       { label: 'Descripción',  value: 'Venta ORD-26-73a1370acc6e' },
 *     ],
 *     columns: ['Producto', 'Modelo', 'Cap.', 'Color', 'IMEI/Serial', 'Valor USD', 'Verificado'],
 *     rows: items.map(it => [it.producto, it.modelo, it.tamano, it.color, it.imei, it.valor, it.verificado ? '✓' : '']),
 *     sumaTotal: items.reduce((s,it) => s + (Number(it.valor)||0), 0),
 *   });
 */
import { writeXlsx } from './xlsx';
import { downloadBlob } from './downloadBlob';

/**
 * @param {Object} params
 * @param {string} params.filename - Nombre base del archivo (sin extensión .xlsx)
 * @param {string} [params.sheetName='Detalle'] - Nombre de la hoja Excel (máx 31 chars)
 * @param {Array<{label:string, value:any}>} [params.header=[]] - Filas de metadata
 * @param {Array<string>} params.columns - Nombres de columnas de items
 * @param {Array<Array<any>>} params.rows - Filas de items
 * @param {number|null} [params.sumaTotal=null] - Suma opcional para fila final
 */
export function downloadDetalleXlsx({
  filename,
  sheetName = 'Detalle',
  header = [],
  columns,
  rows,
  sumaTotal = null,
}) {
  const aoa = [];
  // Header key-value: 2 columnas por fila. Value pasado tal cual — si es
  // number Excel lo trata como number (útil para monto sumable).
  header.forEach(({ label, value }) => {
    aoa.push([String(label ?? '') + ':', value ?? '']);
  });
  if (header.length > 0) aoa.push([]); // separador visual entre metadata e items
  // Columnas + rows
  aoa.push(columns);
  rows.forEach(r => aoa.push(r));
  // Total opcional en fila final
  if (sumaTotal != null && Number.isFinite(Number(sumaTotal))) {
    aoa.push([]);
    // Label "Total" en primera columna, blank en intermedias, número en la
    // columna donde va "Valor USD" (asumimos posición según el # de columnas).
    const totalRow = new Array(columns.length).fill('');
    totalRow[0] = 'Total';
    // Colocar la suma en la MISMA columna donde estarían los valores
    // (una columna antes del final si la última es "Verificado" o "✓").
    // Fallback: última columna.
    const valorIdx = columns.findIndex(c => /valor|monto|precio|subtotal/i.test(c));
    totalRow[valorIdx >= 0 ? valorIdx : columns.length - 1] = Number(sumaTotal);
    aoa.push(totalRow);
  }
  const blob = writeXlsx(aoa, { sheetName: sheetName.slice(0, 31) });
  // Sanitize filename: sin caracteres inválidos para Windows/macOS filesystems.
  const safeName = String(filename || 'detalle').replace(/[/\\?%*:|"<>]/g, '-');
  downloadBlob(blob, `${safeName}.xlsx`);
}
