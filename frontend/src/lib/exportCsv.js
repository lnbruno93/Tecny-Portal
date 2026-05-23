// exportCsv(filename, rows, columns)
// columns: [{ key, label }]
// Generates a UTF-8 BOM CSV and triggers a browser download.
export function exportCsv(filename, rows, columns) {
  const header = columns.map(c => `"${c.label}"`).join(',');
  const body = rows.map(r =>
    columns.map(c => {
      const v = r[c.key] ?? '';
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(',')
  ).join('\n');
  const blob = new Blob(['﻿' + header + '\n' + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
