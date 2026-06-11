import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Smoke tests T-03 — Cajas. Monta + carga cajas/deudas/inversiones sin reventar.
// La pantalla tiene 3 tabs: 'config' (default), 'deudas', 'inversiones'.
vi.mock('../lib/api', () => {
  return {
    cajas: {
      listCajas:        vi.fn().mockResolvedValue([]),
      deudas:           vi.fn().mockResolvedValue({ data: [] }),
      inversiones:      vi.fn().mockResolvedValue({ data: [] }),
      createDeuda:      vi.fn(),
      deleteDeuda:      vi.fn(),
      createInversion:  vi.fn(),
      deleteInversion:  vi.fn(),
      createCaja:       vi.fn(),
      updateCaja:       vi.fn(),
      deleteCaja:       vi.fn(),
      cajaMovimientos:  vi.fn().mockResolvedValue({ data: [] }),
      createCajaAjuste: vi.fn(),
      deleteCajaMov:    vi.fn(),
    },
    contactos: {
      list:   vi.fn().mockResolvedValue({ data: [] }),
      create: vi.fn(),
    },
  };
});

import { cajas as cajasApi } from '../lib/api';
import Cajas from './Cajas';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

function renderCajas() {
  return render(
    <MemoryRouter>
      <ToastProvider><ConfirmProvider><PageActionsProvider>
        <Cajas />
      </PageActionsProvider></ConfirmProvider></ToastProvider>
    </MemoryRouter>
  );
}

describe('Pantalla Cajas', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('monta sin crashear y carga cajas + deudas + inversiones', async () => {
    renderCajas();
    // Default tab = 'config' → llama a listCajas. Cambiamos a deudas e
    // inversiones para verificar que esos endpoints también responden.
    await waitFor(() => expect(cajasApi.listCajas).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Deudas a cobrar'));
    await waitFor(() => expect(cajasApi.deudas).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Inversiones'));
    await waitFor(() => expect(cajasApi.inversiones).toHaveBeenCalled());
  });

  it('con 1 caja en la lista, la renderiza', async () => {
    cajasApi.listCajas.mockResolvedValueOnce([{
      id: 1, nombre: 'Caja test ARS', moneda: 'ARS',
      saldo_actual: 0, saldo_inicial: 0, activo: true,
    }]);
    renderCajas();
    expect(await screen.findByText('Caja test ARS')).toBeInTheDocument();
  });

  it('con 1 deuda en la lista, agrupa y la renderiza', async () => {
    cajasApi.deudas.mockResolvedValueOnce({
      data: [{
        id: 10, contacto_id: 5, nombre: 'Pedro', apellido: 'P',
        contacto_tipo: 'amigo', mov_tipo: 'debe',
        monto_ars: 1000, monto_usd: 0, fecha: '2026-06-11',
      }],
    });
    renderCajas();
    // El tab Deudas carga sólo cuando se selecciona — clickeamos el tab.
    fireEvent.click(screen.getByText('Deudas a cobrar'));
    await waitFor(() => expect(cajasApi.deudas).toHaveBeenCalled());
    expect(await screen.findByText(/Pedro\s+P/)).toBeInTheDocument();
  });
});
