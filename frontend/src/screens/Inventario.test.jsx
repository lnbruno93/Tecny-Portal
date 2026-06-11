import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Smoke tests T-02 — verificamos monte + carga de catálogos + apertura modal.
vi.mock('../lib/api', () => {
  const paginated = { data: [], pagination: { page: 1, pages: 1, total: 0 } };
  return {
    inventario: {
      productos:        vi.fn().mockResolvedValue(paginated),
      metricas:         vi.fn().mockResolvedValue({ total: 0 }),
      categorias:       vi.fn().mockResolvedValue([]),
      depositos:        vi.fn().mockResolvedValue([]),
      proveedoresList:  vi.fn().mockResolvedValue([]),
      createProducto:   vi.fn(),
      updateProducto:   vi.fn(),
      deleteProducto:   vi.fn(),
      bulkProductos:    vi.fn(),
      bulkCategorias:   vi.fn(),
      bulkDeleteDisponibles: vi.fn(),
      createCategoria:  vi.fn(),
      deleteCategoria:  vi.fn(),
      createDeposito:   vi.fn(),
      deleteDeposito:   vi.fn(),
    },
    proveedores: {
      list: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, pages: 1, total: 0 } }),
    },
  };
});

import { inventario as inventarioApi } from '../lib/api';
import Inventario from './Inventario';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider, usePageActions } from '../contexts/PageActionsContext';

function ActionTrigger() {
  const { primaryAction } = usePageActions();
  return primaryAction ? <button onClick={primaryAction.onClick}>__abrir__</button> : null;
}

function renderInventario() {
  return render(
    <MemoryRouter>
      <ToastProvider><ConfirmProvider><PageActionsProvider>
        <Inventario />
        <ActionTrigger />
      </PageActionsProvider></ConfirmProvider></ToastProvider>
    </MemoryRouter>
  );
}

describe('Pantalla Inventario', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('monta sin crashear y carga catálogos + grilla', async () => {
    renderInventario();
    await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
    await waitFor(() => expect(inventarioApi.categorias).toHaveBeenCalled());
    await waitFor(() => expect(inventarioApi.depositos).toHaveBeenCalled());
  });

  it('con 1 producto, lo renderiza en la grilla', async () => {
    inventarioApi.productos.mockResolvedValueOnce({
      data: [{
        id: 1, nombre: 'iPhone 13 test', clase: 'celular', estado: 'disponible',
        costo: 0, precio_venta: 0, costo_moneda: 'USD', precio_moneda: 'USD',
        cantidad: 1, gb: null, color: null, bateria: null, imei: null,
        tipo_carga: 'unitario', categoria_id: null, deposito_id: null,
        proveedor: null, observaciones: null, condicion: 'nuevo', oculto: false,
        categoria_nombre: null, deposito_nombre: null,
      }],
      pagination: { page: 1, pages: 1, total: 1 },
    });
    renderInventario();
    expect(await screen.findByText('iPhone 13 test')).toBeInTheDocument();
  });

  it('abre modal "Agregar producto" sin crashear', async () => {
    renderInventario();
    await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('__abrir__'));
    // El header del modal es "Agregar producto" cuando editId=null.
    expect(await screen.findByRole('heading', { name: 'Agregar producto' })).toBeInTheDocument();
    // El campo Nombre es obligatorio → siempre renderizado.
    expect(await screen.findByText(/Nombre/)).toBeInTheDocument();
  });
});
