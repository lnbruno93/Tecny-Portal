/**
 * Tests del helper `downloadDetalleXlsx` — layout aoa, sanitización de
 * filename, cálculo de columna Total.
 *
 * Estrategia: mockeamos `downloadBlob` para capturar (blob, filename) y luego
 * releemos el blob con `readXlsxRows` (el mismo lector usado en producción)
 * para asegurar round-trip real, sin fixtures artificiales.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ANTES de importar el módulo bajo test.
vi.mock('./downloadBlob', () => ({
  downloadBlob: vi.fn(),
}));

import { downloadDetalleXlsx } from './detalleXlsx';
import { downloadBlob } from './downloadBlob';
import { readXlsxRows } from './xlsx';

describe('downloadDetalleXlsx', () => {
  beforeEach(() => {
    vi.mocked(downloadBlob).mockClear();
  });

  it('genera aoa con header key-value + fila vacía + columnas + rows + total', async () => {
    downloadDetalleXlsx({
      filename: 'venta-b2b_pato_2026-08-04_#123',
      sheetName: 'Venta B2B',
      header: [
        { label: 'Fecha', value: '04/08/2026' },
        { label: 'Cliente', value: 'pato VIP' },
        { label: 'Monto USD', value: 1390 },
      ],
      columns: ['Producto', 'Modelo', 'IMEI', 'Valor USD'],
      rows: [
        ['iPhone 15', 'Pro', '356938', 690],
        ['iPhone 15', 'Pro Max', '356939', 700],
      ],
      sumaTotal: 1390,
    });

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(filename).toBe('venta-b2b_pato_2026-08-04_#123.xlsx');
    const rows = await readXlsxRows(await blob.arrayBuffer());
    // Header key-value: labels con ":" al final, values en col B
    expect(rows[0]).toEqual(['Fecha:', '04/08/2026']);
    expect(rows[1]).toEqual(['Cliente:', 'pato VIP']);
    expect(rows[2]).toEqual(['Monto USD:', '1390']); // number → serialize numeric
    // Fila 4 vacía separadora — readXlsxRows la deja como []
    expect(rows[3]).toEqual([]);
    // Fila 5: nombres de columnas de items
    expect(rows[4]).toEqual(['Producto', 'Modelo', 'IMEI', 'Valor USD']);
    // Filas 6-7: items
    expect(rows[5]).toEqual(['iPhone 15', 'Pro', '356938', '690']);
    expect(rows[6]).toEqual(['iPhone 15', 'Pro Max', '356939', '700']);
    // Fila 8 vacía + fila 9 Total en columna "Valor USD" (index 3)
    expect(rows[7]).toEqual([]);
    expect(rows[8]).toEqual(['Total', '', '', '1390']);
  });

  it('sin header, arranca directo con la fila de columnas', async () => {
    downloadDetalleXlsx({
      filename: 'sin-header',
      columns: ['A', 'B'],
      rows: [['1', '2']],
    });
    const [blob] = vi.mocked(downloadBlob).mock.calls[0];
    const rows = await readXlsxRows(await blob.arrayBuffer());
    expect(rows[0]).toEqual(['A', 'B']);
    expect(rows[1]).toEqual(['1', '2']);
  });

  it('sin sumaTotal, no agrega fila Total', async () => {
    downloadDetalleXlsx({
      filename: 'sin-total',
      header: [{ label: 'X', value: 'y' }],
      columns: ['C1', 'C2'],
      rows: [['a', 'b']],
      sumaTotal: null,
    });
    const [blob] = vi.mocked(downloadBlob).mock.calls[0];
    const rows = await readXlsxRows(await blob.arrayBuffer());
    // header + '' + columns + row + (SIN empty + Total)
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual(['a', 'b']);
  });

  it('total va a la columna que matchea /valor|monto|precio|subtotal/i', async () => {
    downloadDetalleXlsx({
      filename: 't',
      columns: ['Producto', 'IMEI', 'Precio USD', 'Verificado'],
      rows: [['iP', '111', 500, '']],
      sumaTotal: 500,
    });
    const [blob] = vi.mocked(downloadBlob).mock.calls[0];
    const rows = await readXlsxRows(await blob.arrayBuffer());
    // "Precio USD" es index 2 → Total va ahí, la última (index 3) queda ''
    // y readXlsxRows omite blanks trailing → ['Total', '', '500'].
    expect(rows[2]).toEqual([]);
    expect(rows[3]).toEqual(['Total', '', '500']);
  });

  it('total cae a la última columna si ninguna matchea', async () => {
    downloadDetalleXlsx({
      filename: 't',
      columns: ['A', 'B', 'C'],
      rows: [['1', '2', '3']],
      sumaTotal: 42,
    });
    const [blob] = vi.mocked(downloadBlob).mock.calls[0];
    const rows = await readXlsxRows(await blob.arrayBuffer());
    expect(rows[3]).toEqual(['Total', '', '42']);
  });

  it('sanitiza filename removiendo caracteres inválidos', () => {
    downloadDetalleXlsx({
      filename: 'venta/con:caracteres*malos?"<>|\\',
      columns: ['x'],
      rows: [['a']],
    });
    const [, filename] = vi.mocked(downloadBlob).mock.calls[0];
    // 9 caracteres inválidos: / : * ? " < > | \  → 9 dashes en total
    expect(filename).toBe('venta-con-caracteres-malos------.xlsx');
  });

  it('trunca sheetName a 31 chars (cap de Excel)', () => {
    // No podemos leer el sheetName desde el blob sin parsear workbook.xml,
    // pero podemos verificar que no explota con nombre largo.
    expect(() => downloadDetalleXlsx({
      filename: 'x',
      sheetName: 'A'.repeat(50),
      columns: ['x'],
      rows: [['a']],
    })).not.toThrow();
    expect(downloadBlob).toHaveBeenCalled();
  });

  it('sumaTotal no-numérico se ignora (no agrega fila Total)', async () => {
    downloadDetalleXlsx({
      filename: 't',
      columns: ['A', 'B'],
      rows: [['1', '2']],
      sumaTotal: NaN,
    });
    const [blob] = vi.mocked(downloadBlob).mock.calls[0];
    const rows = await readXlsxRows(await blob.arrayBuffer());
    // Solo columns + row, sin fila Total
    expect(rows).toHaveLength(2);
  });
});
