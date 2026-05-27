import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  tarjetas: {
    list: vi.fn().mockResolvedValue([
      { id: 7, nombre: 'Tarjeta de Crédito | 3 Cuotas', moneda: 'ARS', comision_pct: '23.5', saldo: '76500', comision_total: '23500', bruto_total: '100000', movimientos: 1 },
    ]),
    movimientosAll: vi.fn().mockResolvedValue({
      data: [
        { id: 1, fecha: '2026-05-10', tipo: 'cobro', moneda: 'ARS', monto_neto: '76500', saldo_acum: '76500', metodo_nombre: 'Tarjeta de Crédito | 3 Cuotas', venta_order_id: 'ORD-26-abc', caja_nombre: null },
      ],
      pagination: { page: 1, pages: 1, total: 1 },
    }),
    get: vi.fn().mockResolvedValue({
      id: 7, nombre: 'Tarjeta de Crédito | 3 Cuotas', moneda: 'ARS', comision_pct: '23.5',
      resumen: { saldo: '76500', comision_total: '23500', bruto_total: '100000', movimientos: 1 },
    }),
    movimientos: vi.fn().mockResolvedValue({
      data: [
        { id: 1, fecha: '2026-05-10', tipo: 'cobro', moneda: 'ARS', monto_bruto: '100000', monto_comision: '23500', monto_neto: '76500', venta_order_id: 'ORD-26-abc', caja_nombre: null },
      ],
      pagination: { page: 1, pages: 1, total: 1 },
    }),
    createLiquidacion: vi.fn(), deleteMovimiento: vi.fn(),
  },
  cajas: { listCajas: vi.fn().mockResolvedValue([{ id: 9, nombre: 'Caja Pesos', moneda: 'ARS', es_tarjeta: false }]) },
}));

import Tarjetas from './Tarjetas';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

const renderT = () => render(
  <ToastProvider><ConfirmProvider><PageActionsProvider><Tarjetas /></PageActionsProvider></ConfirmProvider></ToastProvider>
);

describe('Pantalla Tarjetas de Crédito', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('vista General: KPIs unificados + estado de cuenta', async () => {
    renderT();
    await waitFor(() => expect(screen.getByText('Saldo a tu favor')).toBeInTheDocument());
    expect(screen.getByText('Comisión financiera')).toBeInTheDocument();
    expect(screen.getByText('Ya recibido (liquidado)')).toBeInTheDocument();
    // El cobro automático figura en el estado de cuenta, referenciando la venta
    expect(await screen.findByText(/Venta ORD-26-abc/)).toBeInTheDocument();
  });
});
