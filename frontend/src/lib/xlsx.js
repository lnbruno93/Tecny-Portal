// Lector mínimo de .xlsx (Excel) SIN dependencias externas.
//
// Un .xlsx es un ZIP con XML adentro. Descomprimimos las entradas que nos
// interesan con DecompressionStream('deflate-raw') (nativo del navegador,
// Chrome 103+/Safari 16.4+/Firefox 113+) y parseamos:
//   · xl/sharedStrings.xml  → tabla de textos compartidos
//   · la primera hoja        → celdas
// Devolvemos las filas como arrays de strings, igual que un CSV ya parseado.
//
// Se eligió implementación propia (en vez de SheetJS u otra lib) para no sumar
// superficie de CVE en una entrada controlada por el usuario, y mantener el
// bundle liviano. Solo necesitamos LEER planillas simples (sin fórmulas/fechas).

const SIG_EOCD = 0x06054b50; // End Of Central Directory
const SIG_CDH  = 0x02014b50; // Central Directory Header

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // & al final para no romper las otras entidades
}

// Lee el directorio central del ZIP → mapa { nombreEntrada: {method, compSize, localOff} }
function readZipEntries(dv, u8) {
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx: no se encontró el fin del ZIP (EOCD)');

  const cdOffset = dv.getUint32(eocd + 16, true);
  const cdCount  = dv.getUint16(eocd + 10, true);
  const entries = {};
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (dv.getUint32(p, true) !== SIG_CDH) break;
    const method   = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const fnLen    = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen   = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + fnLen));
    entries[name] = { method, compSize, localOff };
    p += 46 + fnLen + extraLen + cmtLen;
  }
  return entries;
}

// Tope anti-ZIP-bomb: una entrada descomprimida no puede exceder 50 MB. Suficiente
// para cualquier .xlsx de stock realista (sharedStrings de un libro grande son ~1 MB)
// y blinda contra archivos maliciosos con ratio de compresión 1000:1.
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

async function readEntry(entries, dv, u8, name) {
  const e = entries[name];
  if (!e) return null;
  // Saltamos el local file header (los largos de nombre/extra pueden diferir del central)
  const lfnLen  = dv.getUint16(e.localOff + 26, true);
  const lextra  = dv.getUint16(e.localOff + 28, true);
  const dataStart = e.localOff + 30 + lfnLen + lextra;
  const data = u8.subarray(dataStart, dataStart + e.compSize);
  if (e.method === 0) {
    if (data.length > MAX_ENTRY_BYTES) throw new Error(`xlsx: entrada ${name} demasiado grande`);
    return new TextDecoder().decode(data);
  }
  if (e.method !== 8) throw new Error(`xlsx: método de compresión no soportado (${e.method})`);
  // Patrón writable/readable (no usa Blob.stream(), que no existe en jsdom/tests)
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  // Lectura por chunks con tope acumulado: si el output crece más de MAX_ENTRY_BYTES,
  // abortamos antes de explotar la RAM.
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_ENTRY_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`xlsx: entrada ${name} excede el tope descomprimido`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return new TextDecoder().decode(out);
}

// Resuelve la ruta de la primera hoja desde workbook.xml + sus rels.
// Cae a 'xl/worksheets/sheet1.xml' si algo no cuadra.
function resolveFirstSheet(workbookXml, relsXml) {
  const FALLBACK = 'xl/worksheets/sheet1.xml';
  try {
    const sheet = workbookXml.match(/<sheet\b[^>]*\br:id="([^"]+)"/);
    if (!sheet) return FALLBACK;
    const rid = sheet[1];
    const rel = relsXml.match(new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`));
    if (!rel) return FALLBACK;
    let target = rel[1].replace(/^\//, '');
    if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\.\//, '');
    return target;
  } catch {
    return FALLBACK;
  }
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => {
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]);
    return decodeEntities(parts.join(''));
  });
}

function colIndex(ref) {
  const letters = ref.match(/^([A-Z]+)/)[1];
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1; // base 0
}

function parseSheet(xml, strings) {
  const out = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    let maxCol = -1;
    // Bug 2026-07-04: el regex anterior era `<c ...>([\s\S]*?)</c>`, que NO
    // matcheaba celdas self-closing (`<c r="B2" s="2"/>`) — el formato que usa
    // Google Sheets para celdas vacías. Cuando el regex greedy encontraba una
    // self-closing la saltaba y consumía el contenido de la SIGUIENTE celda no
    // vacía, corrompiendo el mapeo de columnas silenciosamente: el importador
    // XLSX terminaba con COSTO=0 (el valor real se pegaba a la celda anterior
    // vacía) e IMEI="16" (el índice de sharedString de "stock" se pegaba a la
    // celda IMEI vacía). Afectaba tanto accesorios como unitarios que exportaran
    // desde Google Sheets con cualquier columna vacía en el medio.
    //
    // Fix: la alternancia `(?:\/>|>([\s\S]*?)<\/c>)` matchea ambos casos.
    // Grupo 3 (inner) queda `undefined` en las self-closing → val = ''.
    const CELL_RE = /<c\b[^>]*?\br="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (const cm of rm[1].matchAll(CELL_RE)) {
      const ref = cm[1];
      const attrs = cm[2];
      const inner = cm[3]; // undefined si la celda es self-closing (vacía)
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : '';
      let val = '';
      if (inner !== undefined) {
        if (type === 'inlineStr') {
          const t = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
          val = t ? decodeEntities(t[1]) : '';
        } else {
          const v = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
          const raw = v ? v[1] : '';
          if (type === 's') val = strings[Number(raw)] ?? '';
          else val = decodeEntities(raw);
        }
      }
      // Self-closing → val queda '' (celda vacía). El resto del pipeline ya
      // trata '' como "sin valor" y no dispara false positives (costo=0, imei
      // duplicado) porque el índice de columna es el correcto.
      const ci = colIndex(ref);
      cells[ci] = val;
      if (ci > maxCol) maxCol = ci;
    }
    // Rellena huecos (celdas totalmente omitidas del XML) con ''
    for (let i = 0; i <= maxCol; i++) if (cells[i] === undefined) cells[i] = '';
    out.push(cells);
  }
  return out;
}

// ───────────────────────────── Escritor (.xlsx) ─────────────────────────────
// Genera un .xlsx mínimo (método store, sin compresión) desde un array de filas.
// Usado para la plantilla descargable. Todas las celdas como texto (inlineStr):
// alcanza para una plantilla y el importador parsea números desde texto igual.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function escXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function colLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

// aoa: array de filas (cada fila array de celdas). Devuelve un Blob .xlsx.
// Las celdas pueden ser:
//   · string / null / undefined  → texto (inlineStr)
//   · number (finito)            → número (Excel lo trata como tal — suma, ordena)
// Si necesitás un string que se ve como número (ej. ID de cliente con ceros a la
// izquierda), pásalo como string ya formateado.
//
// `opts.sheetName` (default "Sheet1") nombra la hoja — Excel lo muestra en la
// pestaña inferior. Útil cuando el archivo se llama "comprobantes" pero la
// hoja queremos que diga "Resumen junio 2026".
export function writeXlsx(aoa, opts = {}) {
  const sheetName = String(opts.sheetName || 'Sheet1').slice(0, 31); // Excel cap = 31 chars
  const sheetRows = aoa.map((row, ri) => {
    const cells = row.map((val, ci) => {
      if (val === '' || val == null) return '';
      const ref = `${colLetter(ci)}${ri + 1}`;
      // Detect number — solo finitos para evitar NaN/Infinity que Excel rechaza.
      if (typeof val === 'number' && Number.isFinite(val)) {
        return `<c r="${ref}"><v>${val}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');

  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];

  const te = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const central = [];
  for (const [name, text] of files) {
    const nameB = te.encode(name);
    const data = te.encode(text);
    const crc = crc32(data);
    const localOff = offset;
    const local = [...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(nameB.length), ...le16(0)];
    chunks.push(new Uint8Array(local), nameB, data);
    offset += local.length + nameB.length + data.length;
    central.push({ hdr: [...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(nameB.length), ...le16(0), ...le16(0),
      ...le16(0), ...le16(0), ...le32(0), ...le32(localOff)], nameB });
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { const a = new Uint8Array(c.hdr); chunks.push(a, c.nameB); cdSize += a.length + c.nameB.length; }
  chunks.push(new Uint8Array([...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(files.length),
    ...le16(files.length), ...le32(cdSize), ...le32(cdStart), ...le16(0)]));

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// API pública: ArrayBuffer del .xlsx → Promise<string[][]> (filas de celdas).
export async function readXlsxRows(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== 0x04034b50) {
    throw new Error('El archivo no parece un .xlsx válido (no es un ZIP).');
  }
  const entries = readZipEntries(dv, u8);
  const [workbook, rels, shared] = await Promise.all([
    readEntry(entries, dv, u8, 'xl/workbook.xml'),
    readEntry(entries, dv, u8, 'xl/_rels/workbook.xml.rels'),
    readEntry(entries, dv, u8, 'xl/sharedStrings.xml'),
  ]);
  const sheetPath = resolveFirstSheet(workbook || '', rels || '');
  const sheetXml = await readEntry(entries, dv, u8, sheetPath)
    || await readEntry(entries, dv, u8, 'xl/worksheets/sheet1.xml');
  if (!sheetXml) throw new Error('xlsx: no se encontró la hoja de datos.');
  return parseSheet(sheetXml, parseSharedStrings(shared));
}
