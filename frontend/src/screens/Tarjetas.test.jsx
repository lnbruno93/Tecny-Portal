import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  tarjetas: {
    list: vi.fn().mockResolvedValue([
      { id: 7, nombre: 'Tarjeta de Crédito | 3 Cuotas', moneda: 'ARS', comision_pct: '23.5', saldo: '76500', comision_total: '23500', bruto_total: '100000', movimientos: 1 },
    ]),
    get: vi.fn().mockResolvedValue({
      id: 7, nombre: 'Tarjeta de Crédito | 3 Cuotas', moneda: 'ARS', comision_pct: '23.5',
      resumen: { saldo: '76500', comision_total: '23500', bruto_total: '100000', movimientos: 1 },
    }),
    movimientos: vi.fn().mockResolvedValue([
      { id: 1, fecha: '2026-05-10', tipo: 'cobro', moneda: 'ARS', monto_bruto: '100000', monto_comision: '23500', monto_neto: '76500', venta_order_id: 'ORD-26-abc', caja_nombre: null },
    ]),
    createLiquidacion: vi.fn(), deleteMovimiento: vi.fn(),
  },
  cajas: { listCajas: vi.fn().mockResolvedValue([{ id: 9, nombre: 'Caja Pesos', moneda: 'ARS', es_tarjeta: false }]) },
}));

import Tarjetas from './Tarjetas';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';

describe('Pantalla Tarjetas de Crédito', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lista las tarjetas y muestra el saldo + comisión del detalle', async () => {
    render(<ToastProvider><ConfirmProvider><Tarjetas /></ConfirmProvider></ToastProvider>);
    expect(await screen.findByText('Tarjeta de Crédito | 3 Cuotas')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Te deben (falta cobrar)')).toBeInTheDocument());
    expect(screen.getByText('Comisión financiera')).toBeInTheDocument();
    // El cobro automático aparece referenciando la venta
    expect(screen.getByText(/Venta ORD-26-abc/)).toBeInTheDocument();
  });
});
