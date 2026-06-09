import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock de adminApi: el componente expone 4 métodos (financiera + tarjetas).
const mockFinReport     = vi.fn();
const mockFinApply      = vi.fn();
const mockTarjReport    = vi.fn();
const mockTarjApply     = vi.fn();
vi.mock('../lib/api', () => ({
  admin: {
    backfillFinancieraReport: () => mockFinReport(),
    backfillFinancieraApply:  () => mockFinApply(),
    backfillTarjetasReport:   () => mockTarjReport(),
    backfillTarjetasApply:    () => mockTarjApply(),
    // DiagnoseStockPanel también vive en MantenimientoSection — mockeamos
    // sus dos endpoints para que el render no tire. Tests específicos del
    // panel están en DiagnoseStockPanel.test.jsx.
    diagnoseProducto: () => Promise.resolve({ productos: [], movimientos_cc: [] }),
    restoreProducto:  () => Promise.resolve({ ok: true, producto: {} }),
    // OrphanMovs panel (2026-06-09): cleanup de movs huérfanos.
    orphanMovsReport: () => Promise.resolve({ movs_count: 0, deuda_huerfana: 0, caja_movs_a_revertir: 0, muestras: [] }),
    orphanMovsApply:  () => Promise.resolve({ apply: true, movs_procesados: 0, productos_restaurados: 0, errores: [] }),
  },
}));

vi.mock('./ConfirmModal', () => ({
  useConfirm: () => async () => true,
  ConfirmProvider: ({ children }) => children,
}));

import MantenimientoSection from './MantenimientoSection';
import { ToastProvider } from '../contexts/ToastContext';

const renderM = () => render(<ToastProvider><MantenimientoSection /></ToastProvider>);

// Helpers: cada panel tiene su título único, así podemos scopear los queries.
const finPanel  = () => screen.getByRole('heading', { name: /backfill caja financiera/i }).closest('.card');
const tarjPanel = () => screen.getByRole('heading', { name: /backfill cajas tarjetas/i }).closest('.card');

describe('MantenimientoSection — dos paneles paralelos', () => {
  beforeEach(() => {
    mockFinReport.mockReset(); mockFinApply.mockReset();
    mockTarjReport.mockReset(); mockTarjApply.mockReset();
  });

  it('renderiza dos paneles independientes (Financiera + Tarjetas)', () => {
    renderM();
    expect(finPanel()).toBeInTheDocument();
    expect(tarjPanel()).toBeInTheDocument();
  });

  it('Financiera: estado inicial — "Ver reporte" habilitado, "Aplicar" deshabilitado', () => {
    renderM();
    const panel = finPanel();
    expect(within(panel).getByRole('button', { name: /ver reporte/i })).toBeEnabled();
    expect(within(panel).getByRole('button', { name: /aplicar/i })).toBeDisabled();
  });

  it('Financiera: click "Ver reporte" llama al endpoint y renderiza saldo proyectado', async () => {
    mockFinReport.mockResolvedValue({
      apply: false, comprobantes: 3, pagos: 1,
      saldoAntes: 100000, saldoProyectado: 145000, saldoProyectadoNegativo: false,
      totalCompromisos: 50000, totalPagos: 5000,
      caja: { id: 7, nombre: 'FV', moneda: 'ARS' },
      muestras: { comprobantes: [], pagos: [] },
    });
    renderM();
    const panel = finPanel();
    const user = userEvent.setup();
    await user.click(within(panel).getByRole('button', { name: /ver reporte/i }));
    expect(mockFinReport).toHaveBeenCalled();
    await waitFor(() => {
      expect(within(panel).getByText(/\$ 145.000/)).toBeInTheDocument();
    });
    expect(within(panel).getByRole('button', { name: /aplicar/i })).toBeEnabled();
  });

  it('Tarjetas: click "Ver reporte" renderiza una fila por tarjeta', async () => {
    mockTarjReport.mockResolvedValue({
      apply: false, cobros: 2, liquidaciones: 1, hayNegativos: false,
      porTarjeta: [
        { tarjeta: { id: 1, nombre: 'Visa',       moneda: 'ARS' }, saldoAntes: 0, totalCobros: 100000, totalLiq: 30000, cobros: 2, liquidaciones: 1, saldoProyectado: 70000 },
        { tarjeta: { id: 2, nombre: 'Mastercard', moneda: 'ARS' }, saldoAntes: 0, totalCobros: 50000,  totalLiq: 0,     cobros: 1, liquidaciones: 0, saldoProyectado: 50000 },
      ],
      muestras: { cobros: [], liquidaciones: [] },
    });
    renderM();
    const panel = tarjPanel();
    const user = userEvent.setup();
    await user.click(within(panel).getByRole('button', { name: /ver reporte/i }));
    await waitFor(() => {
      expect(within(panel).getByText('Visa')).toBeInTheDocument();
      expect(within(panel).getByText('Mastercard')).toBeInTheDocument();
    });
    // Saldo proyectado de cada tarjeta visible. Usamos getAllByText porque
    // los montos aparecen en varias celdas (+cobros, saldo proyectado, etc.).
    expect(within(panel).getAllByText(/\$ 70.000/).length).toBeGreaterThan(0);
    expect(within(panel).getAllByText(/\$ 50.000/).length).toBeGreaterThan(0);
  });

  it('Tarjetas: si hayNegativos, "Aplicar" queda deshabilitado', async () => {
    mockTarjReport.mockResolvedValue({
      apply: false, cobros: 1, liquidaciones: 2, hayNegativos: true,
      porTarjeta: [
        { tarjeta: { id: 1, nombre: 'Visa', moneda: 'ARS' }, saldoAntes: 0, totalCobros: 10000, totalLiq: 30000, cobros: 1, liquidaciones: 2, saldoProyectado: -20000 },
      ],
      muestras: { cobros: [], liquidaciones: [] },
    });
    renderM();
    const panel = tarjPanel();
    const user = userEvent.setup();
    await user.click(within(panel).getByRole('button', { name: /ver reporte/i }));
    await waitFor(() => expect(within(panel).getByText('Visa')).toBeInTheDocument());
    expect(within(panel).getByRole('button', { name: /aplicar/i })).toBeDisabled();
  });

  it('Tarjetas: skipped=true muestra "nada pendiente"', async () => {
    mockTarjReport.mockResolvedValue({
      apply: false, skipped: true,
      cobros: 0, liquidaciones: 0, hayNegativos: false,
      porTarjeta: [], muestras: { cobros: [], liquidaciones: [] },
    });
    renderM();
    const panel = tarjPanel();
    const user = userEvent.setup();
    await user.click(within(panel).getByRole('button', { name: /ver reporte/i }));
    await waitFor(() => {
      expect(within(panel).getByText(/nada pendiente/i)).toBeInTheDocument();
    });
    expect(within(panel).getByRole('button', { name: /aplicar/i })).toBeDisabled();
  });

  it('Tarjetas: flow completo report → apply muestra "Aplicado"', async () => {
    mockTarjReport.mockResolvedValue({
      apply: false, cobros: 1, liquidaciones: 0, hayNegativos: false,
      porTarjeta: [{ tarjeta: { id: 1, nombre: 'Visa', moneda: 'ARS' }, saldoAntes: 0, totalCobros: 50000, totalLiq: 0, cobros: 1, liquidaciones: 0, saldoProyectado: 50000 }],
      muestras: { cobros: [], liquidaciones: [] },
    });
    mockTarjApply.mockResolvedValue({
      apply: true, cobros: 1, liquidaciones: 0,
      porTarjeta: [{ tarjeta: { id: 1, nombre: 'Visa', moneda: 'ARS' }, saldoAntes: 0, totalCobros: 50000, totalLiq: 0, cobros: 1, liquidaciones: 0, saldoProyectado: 50000 }],
      muestras: { cobros: [], liquidaciones: [] },
    });
    renderM();
    const panel = tarjPanel();
    const user = userEvent.setup();
    await user.click(within(panel).getByRole('button', { name: /ver reporte/i }));
    await waitFor(() => within(panel).getByText('Visa'));
    await user.click(within(panel).getByRole('button', { name: /aplicar/i }));
    expect(mockTarjApply).toHaveBeenCalled();
    await waitFor(() => {
      // TANDA 3 trazab: "✓" emoji reemplazado por <Icons.Check/>, ahora el texto
      // del header de reporte es solo "Aplicado · HH:MM".
      expect(within(panel).getByText(/Aplicado/)).toBeInTheDocument();
    });
  });
});
