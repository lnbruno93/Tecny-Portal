import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  tarjetas: {
    entidades: vi.fn().mockResolvedValue([
      { id: 1, nombre: 'Visa', activo: true, saldo_ars: '40000', saldo_usd: '0', comision_total: '20000', movimientos: 3 },
    ]),
    entidad: vi.fn().mockResolvedValue({
      id: 1, nombre: 'Visa', activo: true,
      planes: [{ id: 5, nombre: '3 cuotas', pct: '10' }],
      resumen: { saldo_ars: '40000', saldo_usd: '0', comision_total: '20000', movimientos: 3 },
    }),
    movimientos: vi.fn().mockResolvedValue([
      { id: 9, fecha: '2026-05-10', tipo: 'cobro', plan_nombre: '3 cuotas', moneda: 'ARS', monto_bruto: '200000', monto_comision: '20000', monto_neto: '180000', caja_nombre: null, venta_order_id: null },
    ]),
    createEntidad: vi.fn(), updateEntidad: vi.fn(), deleteEntidad: vi.fn(),
    createPlan: vi.fn(), updatePlan: vi.fn(), deletePlan: vi.fn(),
    createCobro: vi.fn(), createLiquidacion: vi.fn(), deleteMovimiento: vi.fn(),
  },
  cajas: { listCajas: vi.fn().mockResolvedValue([{ id: 9, nombre: 'Caja Pesos', moneda: 'ARS' }]) },
}));

import Tarjetas from './Tarjetas';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

describe('Pantalla Tarjetas de Crédito', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lista tarjetas, muestra planes y saldo del detalle', async () => {
    render(<ToastProvider><ConfirmProvider><PageActionsProvider><Tarjetas /></PageActionsProvider></ConfirmProvider></ToastProvider>);
    expect(await screen.findByText('Visa')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Falta cobrar · $')).toBeInTheDocument());
    expect(screen.getAllByText(/3 cuotas/).length).toBeGreaterThan(0); // plan badge + fila
  });
});
