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
