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

async function readEntry(entries, dv, u8, name) {
  const e = entries[name];
  if (!e) return null;
  // Saltamos el local file header (los largos de nombre/extra pueden diferir del central)
  const lfnLen  = dv.getUint16(e.localOff + 26, true);
  const lextra  = dv.getUint16(e.localOff + 28, true);
  const dataStart = e.localOff + 30 + lfnLen + lextra;
  const data = u8.subarray(dataStart, dataStart + e.compSize);
  if (e.method === 0) return new TextDecoder().decode(data); // almacenado (sin comprimir)
  if (e.method !== 8) throw new Error(`xlsx: método de compresión no soportado (${e.method})`);
  // Patrón writable/readable (no usa Blob.stream(), que no existe en jsdom/tests)
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(new Uint8Array(buf));
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
    for (const cm of rm[1].matchAll(/<c\b[^>]*\br="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = cm[1];
      const attrs = cm[2];
      const inner = cm[3];
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : '';
      let val = '';
      if (type === 'inlineStr') {
        const t = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        val = t ? decodeEntities(t[1]) : '';
      } else {
        const v = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        const raw = v ? v[1] : '';
        if (type === 's') val = strings[Number(raw)] ?? '';
        else val = decodeEntities(raw);
      }
      const ci = colIndex(ref);
      cells[ci] = val;
      if (ci > maxCol) maxCol = ci;
    }
    // Rellena huecos (celdas vacías omitidas en el XML) con ''
    for (let i = 0; i <= maxCol; i++) if (cells[i] === undefined) cells[i] = '';
    out.push(cells);
  }
  return out;
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
