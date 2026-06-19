import { describe, it, expect, vi } from 'vitest';

// Mock jspdf + jspdf-autotable. vi.mock factories se hoistean al top y no
// pueden referenciar variables del scope externo → todo se declara adentro,
// y exponemos al test vía variables globales en la factory.
const calls = {
  text: [],
  saveFilename: null,
  autoTable: null,
};

vi.mock('jspdf', () => {
  class MockJsPDF {
    constructor() {
      this.internal = {
        pageSize: { getWidth: () => 210, getHeight: () => 297 },
        getNumberOfPages: () => 1,
      };
    }
    setFont() {}
    setFontSize() {}
    setTextColor() {}
    setFillColor() {}
    setDrawColor() {}
    rect() {}
    roundedRect() {}
    getTextWidth() { return 30; }
    text(s) { calls.text.push(s); }
    save(name) { calls.saveFilename = name; }
  }
  return { jsPDF: MockJsPDF };
});

vi.mock('jspdf-autotable', () => ({
  default: (_doc, opts) => { calls.autoTable = opts; },
}));

import { generarComprobantesResumenPdf } from './generarComprobantesResumenPdf';

describe('generarComprobantesResumenPdf', () => {
  it('renderiza header + KPIs + tabla con totales y guarda con filename del día', async () => {
    calls.text = []; calls.saveFilename = null; calls.autoTable = null;

    const comprobantes = [
      { fecha: '2026-05-10', cliente: 'Acme', vendedor_nombre: 'Juan', referencia: 'R1', monto: 100, monto_financiera: 5, monto_neto: 95 },
      { fecha: '2026-05-20', cliente: 'Beta', vendedor_nombre: 'Ana',  referencia: 'R2', monto: 200, monto_financiera: 10, monto_neto: 190 },
    ];
    const totales = { count: 2, total_monto: 300, total_financiera: 15, total_neto: 285 };

    await generarComprobantesResumenPdf({
      comprobantes,
      totales,
      periodoLabel: 'mayo 2026',
    });

    // Verificamos los textos renderizados clave en el header.
    expect(calls.text.some(s => /Tecny · Comprobantes/.test(s))).toBe(true);
    expect(calls.text.some(s => /mayo 2026/.test(s))).toBe(true);

    // autoTable recibió body de 2 filas + footRow con TOTAL.
    expect(calls.autoTable).not.toBeNull();
    expect(calls.autoTable.body).toHaveLength(2);
    expect(calls.autoTable.foot[0][0].content).toBe('TOTAL');

    // El save() recibe el nombre con la fecha de hoy.
    expect(calls.saveFilename).toMatch(/^comprobantes_resumen_\d{4}-\d{2}-\d{2}\.pdf$/);
  });
});
