import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/api', () => ({
  cuentas: {
    clientes: vi.fn().mockResolvedValue({
      data: [{ id: 1, nombre: 'Cliente', apellido: 'Test', categoria: 'A+', saldo: '1000.00' }],
      pagination: { page: 1, pages: 1, total: 1 },
    }),
    resumen: vi.fn().mockResolvedValue({ cliente: { id: 1, nombre: 'Cliente', apellido: 'Test', categoria: 'A+', notas: '' }, saldo: '1000.00', total_compras: '1000.00', total_pagos: '0', total_saldo_inicial: '0' }),
    movimientos: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, pages: 1, total: 0 } }),
    resumenGeneral: vi.fn().mockResolvedValue({ total_deuda: '1000', total_credito: '0', neto: '1000', cant_clientes: 1, top_deudores: [] }),
    createCliente: vi.fn(), updateCliente: vi.fn(), deleteCliente: vi.fn(),
    createMovimiento: vi.fn(), deleteMovimiento: vi.fn(),
  },
  cajas: { listCajas: vi.fn().mockResolvedValue([]) },
}));

import { cuentas as cuentasApi } from '../lib/api';
import CuentasCC from './CuentasCC';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

function renderScreen() {
  // MemoryRouter requerido tras 2026-06-09: CuentasCC ahora usa useSearchParams
  // para soportar deep-link /cuentas?cliente=<id> desde la grilla de Ventas.
  return render(
    <MemoryRouter><ToastProvider><ConfirmProvider><PageActionsProvider>
      <CuentasCC />
    </PageActionsProvider></ConfirmProvider></ToastProvider></MemoryRouter>
  );
}

describe('Pantalla CuentasCC (B2B)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('carga el listado paginado y muestra el cliente', async () => {
    renderScreen();
    // consume la respuesta paginada { data, pagination }
    expect(await screen.findByText(/Cliente Test/i)).toBeInTheDocument();
    await waitFor(() => expect(cuentasApi.clientes).toHaveBeenCalled());
    // pide los movimientos del cliente seleccionado (también paginado)
    await waitFor(() => expect(cuentasApi.movimientos).toHaveBeenCalled());
  });
});
