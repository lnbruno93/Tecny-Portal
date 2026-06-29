import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// PR-X2 Red B2B: useNavigate se mockea para verificar que el click en una row
// cross-tenant redirige a /red-b2b/operaciones/:id (detalle de la operación
// cross-tenant con contexto completo: partner, pagos multidivisa, historial).
const navigateMock = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig();
  return { ...actual, useNavigate: () => navigateMock };
});

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
  beforeEach(() => {
    vi.clearAllMocks();
    navigateMock.mockReset();
    // Default: sin movimientos. Cada test que necesite movimientos sobrescribe.
    cuentasApi.movimientos.mockResolvedValue({ data: [], pagination: { page: 1, pages: 1, total: 0 } });
  });

  it('carga el listado paginado y muestra el cliente', async () => {
    renderScreen();
    // consume la respuesta paginada { data, pagination }
    expect(await screen.findByText(/Cliente Test/i)).toBeInTheDocument();
    await waitFor(() => expect(cuentasApi.clientes).toHaveBeenCalled());
    // pide los movimientos del cliente seleccionado (también paginado)
    await waitFor(() => expect(cuentasApi.movimientos).toHaveBeenCalled());
  });

  // ─── PR-X2 Red B2B: filas cross-tenant ─────────────────────────────────────
  // Una fila de movimiento_cc con cross_tenant_operation_id != null fue
  // generada por Red B2B F3+ (cross_tenant_operations) — visualmente muestra
  // un badge "RED B2B" para diferenciarse de las B2B normales del tenant, y
  // al click navega al detalle completo de la operación cross-tenant.

  it('PR-X2: muestra badge "RED B2B" en fila con cross_tenant_operation_id', async () => {
    cuentasApi.movimientos.mockResolvedValueOnce({
      data: [{
        id: 100,
        tipo: 'compra',
        fecha: '2026-06-29',
        descripcion: 'Venta cross-tenant',
        monto_total: '500.00',
        cross_tenant_operation_id: 42,
        items: [],
      }],
      pagination: { page: 1, pages: 1, total: 1 },
    });
    renderScreen();
    expect(await screen.findByText('RED B2B')).toBeInTheDocument();
  });

  it('PR-X2: NO muestra badge "RED B2B" en filas sin cross_tenant_operation_id', async () => {
    cuentasApi.movimientos.mockResolvedValueOnce({
      data: [{
        id: 101,
        tipo: 'compra',
        fecha: '2026-06-29',
        descripcion: 'Venta normal',
        monto_total: '300.00',
        cross_tenant_operation_id: null,
        items: [],
      }],
      pagination: { page: 1, pages: 1, total: 1 },
    });
    renderScreen();
    // Esperar a que termine de pintar la tabla (descripcion del mov visible)
    await screen.findByText('Venta normal');
    expect(screen.queryByText('RED B2B')).not.toBeInTheDocument();
  });

  it('PR-X2: click en fila cross-tenant navega a /red-b2b/operaciones/:id', async () => {
    cuentasApi.movimientos.mockResolvedValueOnce({
      data: [{
        id: 100,
        tipo: 'compra',
        fecha: '2026-06-29',
        descripcion: 'Venta cross-tenant',
        monto_total: '500.00',
        cross_tenant_operation_id: 42,
        items: [],
      }],
      pagination: { page: 1, pages: 1, total: 1 },
    });
    renderScreen();
    const row = await screen.findByTestId('mov-row-cross-tenant-100');
    // Click en cualquier celda no-botón de la fila: aprovechamos la celda de
    // fecha (primer <td>) que no es un botón ni input — los handlers internos
    // (Trash + chevron expand) tienen sus propios onClick y el row delega
    // ignorando clicks que provengan de un button (closest('button')).
    const fechaCell = within(row).getAllByRole('cell')[0];
    fireEvent.click(fechaCell);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/red-b2b/operaciones/42'));
  });
});
