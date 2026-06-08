import { describe, it, expect, vi } from 'vitest';

// Mocks de jspdf + jspdf-autotable. Como en generarComprobantesResumenPdf.test,
// las dependencias se mockean dentro del factory porque vi.mock es hoisteado y
// no puede ver variables del scope externo. Exponemos al test vía `calls`.
const calls = { text: [], saveFilename: null, autoTable: null };

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

import { generarTarjetasResumenPdf } from './generarTarjetasResumenPdf';

describe('generarTarjetasResumenPdf', () => {
  it('renderiza header + KPIs ARS + tabla con totales y guarda con filename del día', async () => {
    calls.text = []; calls.saveFilename = null; calls.autoTable = null;

    const movimientos = [
      { id: 1, fecha: '2026-06-10', metodo_nombre: 'Visa', tipo: 'cobro',       moneda: 'ARS', monto_bruto: 100000, monto_comision: 5000, monto_neto: 95000,  saldo_acum: 95000 },
      { id: 2, fecha: '2026-06-12', metodo_nombre: 'Visa', tipo: 'liquidacion', moneda: 'ARS', monto_bruto: 0,      monto_comision: 0,    monto_neto: 50000,  saldo_acum: 45000 },
    ];
    const totales = {
      count: 2,
      ARS: { cobros_count: 1, cobros_bruto: 100000, comision: 5000, cobros_neto: 95000, liquidaciones_count: 1, liquidado: 50000, total_count: 2, saldo_periodo: 45000 },
      USD: { total_count: 0 },
      USDT: { total_count: 0 },
    };

    await generarTarjetasResumenPdf({ movimientos, totales, periodoLabel: 'junio 2026' });

    expect(calls.text.some(s => /iPro · Tarjetas/.test(s))).toBe(true);
    expect(calls.text.some(s => /junio 2026/.test(s))).toBe(true);

    expect(calls.autoTable).not.toBeNull();
    expect(calls.autoTable.body).toHaveLength(2);
    expect(calls.autoTable.foot[0][0].content).toBe('TOTAL ARS');

    expect(calls.saveFilename).toMatch(/^tarjetas_resumen_\d{4}-\d{2}-\d{2}\.pdf$/);
  });

  it('agrega nota multi-moneda si hay movimientos USD o USDT en el período', async () => {
    calls.text = []; calls.saveFilename = null; calls.autoTable = null;

    const totales = {
      count: 2,
      ARS: { total_count: 1, cobros_bruto: 100000, comision: 5000, saldo_periodo: 95000 },
      USD: { total_count: 1, cobros_bruto: 1000, comision: 50, saldo_periodo: 950 },
      USDT: { total_count: 0 },
    };

    await generarTarjetasResumenPdf({
      movimientos: [{ fecha: '2026-06-10', metodo_nombre: 'Visa', tipo: 'cobro', moneda: 'ARS', monto_bruto: 100000, monto_comision: 5000, monto_neto: 95000, saldo_acum: 95000 }],
      totales,
      periodoLabel: 'junio 2026',
    });

    // La nota multi-moneda debe haberse renderizado.
    expect(calls.text.some(s => typeof s === 'string' && /USD:.*1 movs/i.test(s))).toBe(true);
  });
});
