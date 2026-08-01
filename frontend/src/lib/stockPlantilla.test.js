// Tests del schema canónico de la plantilla XLSX/CSV de stock.
// task #266: extraído de Inventario.jsx a `stockPlantilla.js` para compartir
// con CompraProveedorModal. Los tests aseguran que el schema no drifte —
// ambos módulos consumen los mismos headers y ejemplos.

import { describe, it, expect, vi } from 'vitest';
import { PLANTILLA_HEADERS, PLANTILLA_EJEMPLO } from './stockPlantilla';

// Mock los helpers de descarga porque en jsdom no hay Blob download real.
vi.mock('./xlsx', () => ({
  writeXlsx: vi.fn(() => new Blob(['fake-xlsx'])),
}));
vi.mock('./downloadBlob', () => ({
  downloadBlob: vi.fn(),
}));
vi.mock('./exportCsv', () => ({
  exportCsv: vi.fn(),
}));

describe('stockPlantilla — schema canónico compartido', () => {
  it('PLANTILLA_HEADERS tiene los 14 encabezados esperados en orden', () => {
    expect(PLANTILLA_HEADERS).toEqual([
      'Nombre',
      'GB(solo iph)',
      'BATERIA(solo iph)',
      'COLOR(solo iph)',
      'COSTO',
      'MONEDA COSTO(ARS/USD)',
      'PRECIO',
      'MONEDA PRECIO(ARS/USD)',
      'IMEI(solo iph)',
      'TIPO(unitario, stock)',
      'CATEGORIA',
      'PROVEEDOR',
      'STOCK(solo acc)',
      'DEPOSITO(nombre o ID)',
    ]);
  });

  it('PLANTILLA_EJEMPLO tiene 2 filas con el mismo número de columnas que headers', () => {
    expect(PLANTILLA_EJEMPLO).toHaveLength(2);
    for (const row of PLANTILLA_EJEMPLO) {
      expect(row).toHaveLength(PLANTILLA_HEADERS.length);
    }
  });

  it('primera fila de ejemplo es un celular (con IMEI, sin STOCK)', () => {
    const [celular] = PLANTILLA_EJEMPLO;
    const imeiIdx = PLANTILLA_HEADERS.indexOf('IMEI(solo iph)');
    const stockIdx = PLANTILLA_HEADERS.indexOf('STOCK(solo acc)');
    const tipoIdx = PLANTILLA_HEADERS.indexOf('TIPO(unitario, stock)');
    expect(celular[imeiIdx]).toMatch(/^\d{15}$/); // IMEI 15 dígitos
    expect(celular[stockIdx]).toBe('');
    expect(celular[tipoIdx].toLowerCase()).toBe('unitario');
  });

  it('segunda fila de ejemplo es un accesorio (con STOCK, sin IMEI)', () => {
    const [, accesorio] = PLANTILLA_EJEMPLO;
    const imeiIdx = PLANTILLA_HEADERS.indexOf('IMEI(solo iph)');
    const stockIdx = PLANTILLA_HEADERS.indexOf('STOCK(solo acc)');
    const tipoIdx = PLANTILLA_HEADERS.indexOf('TIPO(unitario, stock)');
    expect(accesorio[imeiIdx]).toBe('');
    expect(Number(accesorio[stockIdx])).toBeGreaterThan(0);
    expect(accesorio[tipoIdx].toLowerCase()).toBe('stock');
  });

  it('descargarPlantillaXlsx llama a writeXlsx + downloadBlob con nombre estándar', async () => {
    const { descargarPlantillaXlsx } = await import('./stockPlantilla');
    const { writeXlsx } = await import('./xlsx');
    const { downloadBlob } = await import('./downloadBlob');
    descargarPlantillaXlsx();
    expect(writeXlsx).toHaveBeenCalledWith([PLANTILLA_HEADERS, ...PLANTILLA_EJEMPLO]);
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'plantilla_stock.xlsx');
  });

  it('descargarPlantillaCsv llama a exportCsv con nombre estándar', async () => {
    const { descargarPlantillaCsv } = await import('./stockPlantilla');
    const { exportCsv } = await import('./exportCsv');
    descargarPlantillaCsv();
    expect(exportCsv).toHaveBeenCalledWith(
      'plantilla_stock.csv',
      expect.any(Array),
      expect.any(Array),
    );
    // Verificar que las cols del CSV son las mismas que PLANTILLA_HEADERS.
    const call = exportCsv.mock.calls[exportCsv.mock.calls.length - 1];
    const cols = call[2];
    expect(cols.map(c => c.label)).toEqual(PLANTILLA_HEADERS);
  });
});
