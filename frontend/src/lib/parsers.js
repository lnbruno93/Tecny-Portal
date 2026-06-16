// Parsers de input crudo (CSV, montos, fechas) compartidos entre módulos.
// Extraídos de Conciliacion.jsx para poder testearlos en aislamiento y reusarlos.
// Mantienen la misma lógica original: cualquier ajuste acá impacta importadores.

// ──────────────────────────────────────────────────────────────────────
// parseCsv — CSV minimalista que soporta:
//   · separadores: coma O punto y coma (autodetectado por línea)
//   · escapes de comillas "" dentro de campos quoted
//   · saltos de línea CRLF o LF
//   · filas completamente vacías → se descartan
// Devuelve un array de arrays de strings (sin trim).
// No usa la lib `csv-parse` adrede: cero deps, se ejecuta en el browser.
// ──────────────────────────────────────────────────────────────────────
export function parseCsv(text) {
  // Salteamos la primera línea si es el hint `sep=,`/`sep=;` que emite
  // exportCsv para que Excel ES abra el archivo con columnas separadas —
  // no es un dato. Lo strippeamos del texto antes del parse para evitar
  // que el split lo trate como una fila.
  text = text.replace(/^﻿?sep=.\r?\n/i, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',' || c === ';') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); if (row.some(v => v.trim() !== '')) rows.push(row); }
  return rows;
}

// ──────────────────────────────────────────────────────────────────────
// parseMonto — convierte string con formato de banco/argentino a Number.
// Heurística:
//   · "1.234,56" → 1234.56  (es-AR: punto = miles, coma = decimal)
//   · "1,50"     → 1.50     (LATAM: coma como decimal)
//   · "1234.56"  → 1234.56  (en-US)
//   · "-200.00"  → -200
//   · "$ 1.234"  → 1234     (símbolos no numéricos se ignoran)
//   · "abc"      → 0        (fallback seguro)
// Edge cases con coma única (¿miles o decimal?): se asume decimal.
// ──────────────────────────────────────────────────────────────────────
export function parseMonto(s) {
  if (s == null) return 0;
  const str = String(s).trim();
  if (!str) return 0;
  let normalizado = str;
  if (str.includes(',') && str.includes('.')) {
    normalizado = str.replace(/\./g, '').replace(',', '.');
  } else if (str.includes(',')) {
    normalizado = str.replace(',', '.');
  }
  normalizado = normalizado.replace(/[^\d.-]/g, '');
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : 0;
}

// ──────────────────────────────────────────────────────────────────────
// parseFecha — devuelve YYYY-MM-DD o null si no se pudo parsear.
// Acepta:
//   · YYYY-MM-DD       → tal cual
//   · DD/MM/YYYY       → reformateado
//   · D-M-YY           → expande año a 20YY
// Notar: D/M/YYYY (ambiguo con M/D/YYYY) se asume es-AR (día primero).
// Para formatos no detectados retorna null para que el caller pueda
// filtrar/avisar al usuario.
// ──────────────────────────────────────────────────────────────────────
export function parseFecha(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}
