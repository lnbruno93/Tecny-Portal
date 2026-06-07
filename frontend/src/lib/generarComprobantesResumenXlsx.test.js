import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generarComprobantesResumenXlsx } from './generarComprobantesResumenXlsx';

// Mock minimal de URL + anchor para que el download no rompa en jsdom.
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

describe('generarComprobantesResumenXlsx', () => {
  it('genera un .xlsx descargable con los KPIs + detalle del período', async () => {
    const comprobantes = [
      { fecha: '2026-05-10', cliente: 'Acme SRL', vendedor_nombre: 'Juan', referencia: 'REF-1', monto: 100, monto_financiera: 5, monto_neto: 95 },
      { fecha: '2026-05-20', cliente: 'Beta',    vendedor_nombre: null,    referencia: '',      monto: 200, monto_financiera: 10, monto_neto: 190 },
    ];
    const totales = { count: 2, total_monto: 300, total_financiera: 15, total_neto: 285 };

    // Intercepta el click del anchor para capturar el filename.
    let capturedFilename = null;
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        // El helper setea href + download y dispara click(). El download es
        // el nombre del archivo que queremos verificar.
        const desc = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'download');
        Object.defineProperty(el, 'download', {
          set(v) { capturedFilename = v; },
          get() { return capturedFilename; },
          configurable: true,
        });
        el.click = () => {};
      }
      return el;
    });

    generarComprobantesResumenXlsx({ comprobantes, totales, periodoLabel: 'mayo 2026' });

    expect(capturedFilename).toMatch(/comprobantes_resumen_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it('maneja período vacío (sin filas de detalle) sin romper', () => {
    expect(() => generarComprobantesResumenXlsx({
      comprobantes: [],
      totales: { count: 0, total_monto: 0, total_financiera: 0, total_neto: 0 },
      periodoLabel: '—',
    })).not.toThrow();
  });
});
