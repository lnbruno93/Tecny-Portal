import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  proyectos: {
    list: vi.fn().mockResolvedValue([
      { id: 1, nombre: 'App iPro', objetivo: 'v2', fecha_creacion: '2026-01-15', total_ars: '142500', total_usd: '100', cant_movimientos: 1 },
    ]),
    get: vi.fn().mockResolvedValue({
      id: 1, nombre: 'App iPro', objetivo: 'v2', fecha_creacion: '2026-01-15',
      participantes: [{ id: 9, nombre: 'Inversor', apellido: 'Uno' }],
      resumen: { total_ars: '142500', total_usd: '100', cant_movimientos: 1, desde: '2026-02-01', hasta: '2026-02-01' },
    }),
    movimientos: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, pages: 1, total: 0 } }),
    create: vi.fn(), update: vi.fn(), delete: vi.fn(),
    createMovimiento: vi.fn(), deleteMovimiento: vi.fn(),
  },
  contactos: { list: vi.fn().mockResolvedValue([{ id: 9, nombre: 'Inversor', apellido: 'Uno' }]) },
}));

import { proyectos as proyApi } from '../lib/api';
import Proyectos from './Proyectos';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

describe('Pantalla Proyectos', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lista proyectos y abre el detalle con totales', async () => {
    render(
      <ToastProvider><ConfirmProvider><PageActionsProvider>
        <Proyectos />
      </PageActionsProvider></ConfirmProvider></ToastProvider>
    );
    expect(await screen.findByText('App iPro')).toBeInTheDocument();
    await waitFor(() => expect(proyApi.get).toHaveBeenCalledWith(1));
    await waitFor(() => expect(proyApi.movimientos).toHaveBeenCalled());
    // KPIs del detalle
    expect(await screen.findByText(/Invertido · USD/i)).toBeInTheDocument();
  });
});
