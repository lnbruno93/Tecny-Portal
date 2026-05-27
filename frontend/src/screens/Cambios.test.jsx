import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  cambios: {
    entidades: vi.fn().mockResolvedValue([
      { id: 1, nombre: 'El Dorado', activo: true, saldo_usd: '400', entregado_usd: '1000', recibido_usd: '600', movimientos: 2 },
    ]),
    entidad: vi.fn().mockResolvedValue({
      id: 1, nombre: 'El Dorado', activo: true,
      resumen: { saldo_usd: '400', entregado_usd: '1000', recibido_usd: '600', movimientos: 2 },
    }),
    movimientos: vi.fn().mockResolvedValue([
      { id: 5, fecha: '2026-05-01', tipo: 'entrega_ars', monto_ars: '1000000', tc: '1000', monto_usd: '1000', caja_nombre: 'Caja Pesos', comentarios: null },
    ]),
    createEntidad: vi.fn(), updateEntidad: vi.fn(), deleteEntidad: vi.fn(),
    createMovimiento: vi.fn(), deleteMovimiento: vi.fn(),
  },
  cajas: { listCajas: vi.fn().mockResolvedValue([{ id: 9, nombre: 'Caja Pesos', moneda: 'ARS' }, { id: 10, nombre: 'Caja USD', moneda: 'USD' }]) },
}));

import Cambios from './Cambios';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

describe('Pantalla Cambios de Divisa', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lista financieras y muestra el saldo del detalle', async () => {
    render(<ToastProvider><ConfirmProvider><PageActionsProvider><Cambios /></PageActionsProvider></ConfirmProvider></ToastProvider>);
    expect(await screen.findByText('El Dorado')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Te deben · USD')).toBeInTheDocument());
    expect(screen.getByText('Recibido · USD')).toBeInTheDocument();
  });
});
