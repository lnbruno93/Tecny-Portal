import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportCsv } from './exportCsv';

describe('exportCsv()', () => {
  let captured;
  beforeEach(() => {
    captured = {};
    // 2026-07-04 audit follow-up: exportCsv delega en lib/downloadBlob que
    // hace appendChild + click + removeChild + setTimeout(revoke). Interceptamos
    // createObjectURL para capturar el Blob y click en el anchor prototype.
    // Dejamos que appendChild/removeChild corran reales sobre un anchor real
    // creado por jsdom (spy sin mockImplementation).
    global.URL.createObjectURL = vi.fn((blob) => { captured.blob = blob; return 'blob:mock'; });
    global.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      captured.download = this.download;
      captured.click = (captured.click || 0) + 1;
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('genera el CSV con headers y filas, y dispara la descarga', async () => {
    exportCsv('reporte.csv', [{ a: 'x', b: 2 }, { a: 'y', b: 3 }], [{ key: 'a', label: 'Columna A' }, { key: 'b', label: 'Columna B' }]);
    expect(captured.download).toBe('reporte.csv');
    expect(captured.click).toBeGreaterThanOrEqual(1);
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

  // 2026-06-15: hint `sep=,` para que Excel ES abra el CSV con columnas
  // separadas. Antes, abrir el archivo descargado en Excel mostraba todo
  // apretado en la columna A porque el locale ES espera `;`.
  it('incluye el hint `sep=,` en la primera línea (después del BOM)', async () => {
    exportCsv('r.csv', [{ a: 'x' }], [{ key: 'a', label: 'A' }]);
    const text = await captured.blob.text();
    // Removemos el BOM (U+FEFF) antes de assertar.
    const noBom = text.replace(/^\uFEFF/, '');
    expect(noBom.startsWith('sep=,\n')).toBe(true);
  });
});
