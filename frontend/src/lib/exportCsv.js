// exportCsv(filename, rows, columns)
// columns: [{ key, label }]
// Generates a UTF-8 BOM CSV and triggers a browser download.
//
// La primera línea `sep=,` es un hint que leen Excel (Win/Mac/Online),
// LibreOffice Calc y Numbers para abrir el archivo con columnas separadas
// aún cuando el locale del sistema (ej. es-AR) espera `;` como separador
// por default. Sin esto, abrir el CSV en Excel ES mostraba todo apretado
// en la columna A — el usuario tenía que hacer "Texto en columnas" a mano.
// Google Sheets no respeta el hint y lo ve como una fila extra; nuestros
// importers (`parseCsv` en Inventario.jsx y en lib/parsers.js) saltean
// esa línea explícitamente.
import { downloadBlob } from './downloadBlob';

export function exportCsv(filename, rows, columns) {
  const header = columns.map(c => `"${c.label}"`).join(',');
  const body = rows.map(r =>
    columns.map(c => {
      const v = r[c.key] ?? '';
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(',')
  ).join('\n');
  const blob = new Blob(['\uFEFF' + 'sep=,\n' + header + '\n' + body], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename);
}
