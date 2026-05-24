import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportCsv } from './exportCsv';

describe('exportCsv()', () => {
  let captured;
  beforeEach(() => {
    captured = {};
    const anchor = { set href(v) { captured.href = v; }, set download(v) { captured.download = v; }, click: vi.fn() };
    captured.anchor = anchor;
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    let blobText = '';
    global.URL.createObjectURL = vi.fn((blob) => { captured.blob = blob; return 'blob:mock'; });
    global.URL.revokeObjectURL = vi.fn();
    void blobText;
  });

  it('genera el CSV con headers y filas, y dispara la descarga', async () => {
    exportCsv('reporte.csv', [{ a: 'x', b: 2 }, { a: 'y', b: 3 }], [{ key: 'a', label: 'Columna A' }, { key: 'b', label: 'Columna B' }]);
    expect(captured.download).toBe('reporte.csv');
    expect(captured.anchor.click).toHaveBeenCalled();
    const text = await captured.blob.text();
    expect(text).toContain('"Columna A","Columna B"');
    expect(text).toContain('"x","2"');
    expect(text).toContain('"y","3"');
  });

  it('escapa las comillas dobles en los valores', async () => {
    exportCsv('q.csv', [{ a: 'di"jo' }], [{ key: 'a', label: 'A' }]);
    const text = await captured.blob.text();
    expect(text).toContain('"di""jo"');
  });
});
