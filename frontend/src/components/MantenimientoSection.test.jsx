import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock de adminApi: el componente solo usa estos dos métodos.
const mockReport = vi.fn();
const mockApply  = vi.fn();
vi.mock('../lib/api', () => ({
  admin: {
    backfillFinancieraReport: () => mockReport(),
    backfillFinancieraApply:  () => mockApply(),
  },
}));

// Mock simple del ConfirmModal — auto-confirma para no requerir interacción.
vi.mock('./ConfirmModal', () => ({
  useConfirm: () => async () => true,
  ConfirmProvider: ({ children }) => children,
}));

import MantenimientoSection from './MantenimientoSection';
import { ToastProvider } from '../contexts/ToastContext';

const renderM = () => render(<ToastProvider><MantenimientoSection /></ToastProvider>);

describe('MantenimientoSection — backfill caja FV desde UI admin', () => {
  beforeEach(() => { mockReport.mockReset(); mockApply.mockReset(); });

  it('estado inicial: solo botón "Ver reporte" habilitado, "Aplicar" deshabilitado', () => {
    renderM();
    const verBtn = screen.getByRole('button', { name: /ver reporte/i });
    const aplicarBtn = screen.getByRole('button', { name: /aplicar/i });
    expect(verBtn).toBeEnabled();
    expect(aplicarBtn).toBeDisabled();
  });

  it('click en "Ver reporte" llama al endpoint y renderiza los totales', async () => {
    mockReport.mockResolvedValue({
      apply: false,
      comprobantes: 3, pagos: 1,
      saldoAntes: 100000, saldoProyectado: 145000,
      saldoProyectadoNegativo: false,
      totalCompromisos: 50000, totalPagos: 5000,
      caja: { id: 7, nombre: 'FV Corpo | Transferencias', moneda: 'ARS' },
      muestras: { comprobantes: [], pagos: [] },
    });

    renderM();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /ver reporte/i }));

    expect(mockReport).toHaveBeenCalled();
    await waitFor(() => {
      // El subtítulo con el nombre de la caja aparece en el resultado.
      expect(screen.getByText('FV Corpo | Transferencias')).toBeInTheDocument();
    });
    // Saldo proyectado renderizado.
    expect(screen.getByText(/\$ 145.000/)).toBeInTheDocument();
    // El botón Aplicar ahora está habilitado (hay pendientes + saldo no negativo).
    expect(screen.getByRole('button', { name: /aplicar/i })).toBeEnabled();
  });

  it('si skipped=true, muestra el mensaje "nada pendiente" y botón Aplicar queda deshabilitado', async () => {
    mockReport.mockResolvedValue({
      apply: false, skipped: true,
      comprobantes: 0, pagos: 0,
      saldoAntes: 999, saldoProyectado: 999,
      saldoProyectadoNegativo: false,
      totalCompromisos: 0, totalPagos: 0,
      caja: { id: 7, nombre: 'FV', moneda: 'ARS' },
      muestras: { comprobantes: [], pagos: [] },
    });
    renderM();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /ver reporte/i }));
    await waitFor(() => {
      expect(screen.getByText(/nada pendiente/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /aplicar/i })).toBeDisabled();
  });

  it('si saldoProyectadoNegativo, muestra warning y botón Aplicar deshabilitado', async () => {
    mockReport.mockResolvedValue({
      apply: false,
      comprobantes: 2, pagos: 5,
      saldoAntes: 10000, saldoProyectado: -5000,
      saldoProyectadoNegativo: true,
      totalCompromisos: 10000, totalPagos: 25000,
      caja: { id: 7, nombre: 'FV', moneda: 'ARS' },
      muestras: { comprobantes: [], pagos: [] },
    });
    renderM();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /ver reporte/i }));
    await waitFor(() => {
      expect(screen.getByText(/proyección quedaría negativa/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /aplicar/i })).toBeDisabled();
  });

  it('flow completo: report -> apply ejecuta el endpoint y muestra saldo final', async () => {
    mockReport.mockResolvedValue({
      apply: false,
      comprobantes: 2, pagos: 1,
      saldoAntes: 50000, saldoProyectado: 75000,
      saldoProyectadoNegativo: false,
      totalCompromisos: 30000, totalPagos: 5000,
      caja: { id: 7, nombre: 'FV', moneda: 'ARS' },
      muestras: { comprobantes: [], pagos: [] },
    });
    mockApply.mockResolvedValue({
      apply: true,
      comprobantes: 2, pagos: 1,
      saldoAntes: 50000, saldoFinal: 75000,
      totalCompromisos: 30000, totalPagos: 5000,
      caja: { id: 7, nombre: 'FV', moneda: 'ARS' },
    });

    renderM();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /ver reporte/i }));
    await waitFor(() => screen.getByText(/saldo proyectado/i));
    await user.click(screen.getByRole('button', { name: /aplicar/i }));

    expect(mockApply).toHaveBeenCalled();
    await waitFor(() => {
      // Tras apply, en el panel inferior aparece "✓ Aplicado · ..."
      // (anchorar al "✓" porque "Aplicar" también matchea /aplicado/i).
      // El texto "saldo final" matchea tanto el header del panel como un <li>
      // de la descripción superior — getAllByText devuelve los 2 (válido).
      expect(screen.getByText(/✓ Aplicado/)).toBeInTheDocument();
      expect(screen.getAllByText(/saldo final/i).length).toBeGreaterThan(0);
    });
  });
});
