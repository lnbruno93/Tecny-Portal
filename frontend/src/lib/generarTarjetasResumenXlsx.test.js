import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generarTarjetasResumenXlsx } from './generarTarjetasResumenXlsx';

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

describe('generarTarjetasResumenXlsx', () => {
  it('genera un .xlsx descargable con los KPIs ARS + detalle del período', () => {
    const movimientos = [
      { id: 1, fecha: '2026-06-10', metodo_nombre: 'Visa', tipo: 'cobro',       moneda: 'ARS', monto_bruto: 100000, monto_comision: 5000, monto_neto: 95000,  saldo_acum: 95000, venta_order_id: 1234 },
      { id: 2, fecha: '2026-06-12', metodo_nombre: 'Visa', tipo: 'liquidacion', moneda: 'ARS', monto_bruto: 0,      monto_comision: 0,    monto_neto: 50000,  saldo_acum: 45000, caja_nombre: 'Caja Pesos' },
    ];
    const totales = {
      count: 2,
      ARS: { total_count: 2, cobros_count: 1, cobros_bruto: 100000, comision: 5000, cobros_neto: 95000, liquidaciones_count: 1, liquidado: 50000, saldo_periodo: 45000 },
      USD: { total_count: 0 },
      USDT: { total_count: 0 },
    };

    let capturedFilename = null;
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'download', {
          set(v) { capturedFilename = v; },
          get() { return capturedFilename; },
          configurable: true,
        });
        el.click = () => {};
      }
      return el;
    });

    generarTarjetasResumenXlsx({ movimientos, totales, periodoLabel: 'junio 2026' });

    expect(capturedFilename).toMatch(/^tarjetas_resumen_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it('NO incluye fila de KPIs USD/USDT cuando no hay movimientos en esas monedas', () => {
    // Caso típico: el operador filtra un período con solo ARS — el XLSX queda
    // limpio sin filas vacías de USD/USDT.
    const totales = {
      count: 1,
      ARS: { total_count: 1, cobros_bruto: 100, comision: 5, saldo_periodo: 95 },
      USD: { total_count: 0 },
      USDT: { total_count: 0 },
    };
    expect(() => generarTarjetasResumenXlsx({
      movimientos: [{ fecha: '2026-06-10', metodo_nombre: 'Visa', tipo: 'cobro', moneda: 'ARS', monto_bruto: 100, monto_comision: 5, monto_neto: 95, saldo_acum: 95 }],
      totales,
      periodoLabel: 'junio 2026',
    })).not.toThrow();
  });

  it('maneja período vacío sin romper', () => {
    expect(() => generarTarjetasResumenXlsx({
      movimientos: [],
      totales: { count: 0, ARS: { total_count: 0 }, USD: { total_count: 0 }, USDT: { total_count: 0 } },
      periodoLabel: '—',
    })).not.toThrow();
  });
});
