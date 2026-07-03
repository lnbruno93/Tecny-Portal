import { describe, it, expect } from 'vitest';
import { readXlsxRows, writeXlsx } from './xlsx';

// ── Constructor mínimo de .xlsx en memoria (ZIP con deflate-raw) para testear ──
// Cubre el pipeline completo: parseo del ZIP + descompresión + parseo de la hoja.
const enc = new TextEncoder();

async function deflateRaw(u8) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(u8);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

function u16(n) { return [n & 0xff, (n >> 8) & 0xff]; }
function u32(n) { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]; }

async function buildXlsx(files) {
  // files: [{ name, text }]
  const prepared = [];
  for (const f of files) {
    const raw = enc.encode(f.text);
    const comp = await deflateRaw(raw);
    prepared.push({ name: enc.encode(f.name), comp, rawLen: raw.length });
  }
  const chunks = [];
  let offset = 0;
  const central = [];
  for (const p of prepared) {
    const localOff = offset;
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0),
      ...u32(0), ...u32(p.comp.length), ...u32(p.rawLen), ...u16(p.name.length), ...u16(0),
    ];
    chunks.push(new Uint8Array(local), p.name, p.comp);
    offset += local.length + p.name.length + p.comp.length;
    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0),
      ...u32(0), ...u32(p.comp.length), ...u32(p.rawLen), ...u16(p.name.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(localOff),
    ]);
  }
  const cdStart = offset;
  let cdSize = 0;
  for (let i = 0; i < central.length; i++) {
    const arr = new Uint8Array(central[i]);
    chunks.push(arr, prepared[i].name);
    cdSize += arr.length + prepared[i].name.length;
  }
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(prepared.length),
    ...u16(prepared.length), ...u32(cdSize), ...u32(cdStart), ...u16(0)];
  chunks.push(new Uint8Array(eocd));

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out.buffer;
}

const WORKBOOK = `<?xml version="1.0"?><workbook xmlns:r="x"><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
const SHARED = `<?xml version="1.0"?><sst><si><t>Nombre</t></si><si><t>COSTO</t></si><si><t>iPhone &amp; Co</t></si></sst>`;
// Fila 2 omite C2 (celda vacía) → el lector debe rellenar el hueco con ''.
const SHEET = `<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>800</v></c></row>
</sheetData></worksheet>`;

describe('readXlsxRows', () => {
  it('lee headers, shared strings, números, decodifica entidades y rellena huecos', async () => {
    const ab = await buildXlsx([
      { name: 'xl/workbook.xml', text: WORKBOOK },
      { name: 'xl/_rels/workbook.xml.rels', text: RELS },
      { name: 'xl/sharedStrings.xml', text: SHARED },
      { name: 'xl/worksheets/sheet1.xml', text: SHEET },
    ]);
    const rows = await readXlsxRows(ab);
    expect(rows[0]).toEqual(['Nombre', 'COSTO']);
    expect(rows[1]).toEqual(['iPhone & Co', '', '800']); // B2 vacío → '', C2='800'
  });

  it('rechaza un archivo que no es ZIP', async () => {
    const notZip = enc.encode('hola, esto no es un xlsx').buffer;
    await expect(readXlsxRows(notZip)).rejects.toThrow();
  });

  // Regression test para bug de 2026-07-04. Google Sheets exporta celdas vacías
  // como self-closing (`<c r="B2" s="2"/>`), NO como `<c ...></c>`. El regex de
  // parseSheet no las manejaba: cuando encontraba una self-closing, el greedy
  // consumía la SIGUIENTE celda no vacía, corrompiendo el mapeo de columnas
  // silenciosamente. Un XLSX con headers [Nombre, GB, COSTO, IMEI, TIPO] donde
  // el usuario dejó GB e IMEI vacíos para un accesorio terminaba con COSTO
  // pegándose a GB (→ costo=0) y TIPO pegándose a IMEI (→ IMEI falso).
  //
  // Fixture: replica exacta del patrón de sheet1.xml que produce Google Sheets.
  it('maneja celdas self-closing (formato Google Sheets) sin desplazar columnas', async () => {
    const SHARED_GSHEETS = `<?xml version="1.0"?><sst>
      <si><t>Nombre</t></si><si><t>GB</t></si><si><t>COSTO</t></si>
      <si><t>IMEI</t></si><si><t>TIPO</t></si>
      <si><t>Cargador Original 20W</t></si><si><t>stock</t></si>
      <si><t>iPhone 15 Pro</t></si><si><t>Unitario</t></si>
    </sst>`;
    // Nota los `<c r="B2" s="2"/>` (self-closing) mezclados con `<c ...><v>N</v></c>`
    // — exactamente el patrón que produce Google Sheets al exportar.
    const SHEET_GSHEETS = `<?xml version="1.0"?><worksheet><sheetData>
      <row r="1">
        <c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>
        <c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c>
        <c r="E1" t="s"><v>4</v></c>
      </row>
      <row r="2">
        <c r="A2" t="s"><v>5</v></c><c r="B2" s="2"/><c r="C2"><v>14</v></c>
        <c r="D2" s="2"/><c r="E2" t="s"><v>6</v></c>
      </row>
      <row r="3">
        <c r="A3" t="s"><v>7</v></c><c r="B3"><v>256</v></c><c r="C3"><v>800</v></c>
        <c r="D3" t="s" s="2"><v>3</v></c><c r="E3" t="s"><v>8</v></c>
      </row>
    </sheetData></worksheet>`;
    const ab = await buildXlsx([
      { name: 'xl/workbook.xml', text: WORKBOOK },
      { name: 'xl/_rels/workbook.xml.rels', text: RELS },
      { name: 'xl/sharedStrings.xml', text: SHARED_GSHEETS },
      { name: 'xl/worksheets/sheet1.xml', text: SHEET_GSHEETS },
    ]);
    const rows = await readXlsxRows(ab);
    expect(rows[0]).toEqual(['Nombre', 'GB', 'COSTO', 'IMEI', 'TIPO']);
    // Accesorio: GB e IMEI vacíos, COSTO=14, TIPO=stock. ANTES del fix, COSTO
    // aparecía en la columna GB (14 pegado a B2 vacía) y TIPO en IMEI (stock
    // pegado a D2 vacía), rompiendo el importador silenciosamente.
    expect(rows[1]).toEqual(['Cargador Original 20W', '', '14', '', 'stock']);
    // Unitario: todas las columnas con valor (control — el bug no aplica).
    expect(rows[2]).toEqual(['iPhone 15 Pro', '256', '800', 'IMEI', 'Unitario']);
  });
});

describe('writeXlsx (round-trip)', () => {
  it('lo que escribe se puede volver a leer igual', async () => {
    const aoa = [
      ['Nombre', 'GB(solo iph)', 'COSTO', 'IMEI(solo iph)'],
      ['iPhone 15 Pro', '256', '800', '356938035643809'],
      ['Funda', '', '3', ''], // celda vacía intermedia
    ];
    const blob = writeXlsx(aoa);
    const rows = await readXlsxRows(await blob.arrayBuffer());
    expect(rows[0]).toEqual(['Nombre', 'GB(solo iph)', 'COSTO', 'IMEI(solo iph)']);
    expect(rows[1]).toEqual(['iPhone 15 Pro', '256', '800', '356938035643809']);
    expect(rows[2]).toEqual(['Funda', '', '3']); // hueco preservado como ''
  });
});
