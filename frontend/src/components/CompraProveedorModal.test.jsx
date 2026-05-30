// Smoke tests para CompraProveedorModal — modal de carga de compras a
// proveedor, el más complejo de los 3 spreadsheets (defaults editables,
// stock auto-create, pegado desde clipboard).
//
// Tests mínimos sin profundizar en el dataset de Inventario.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from './ConfirmModal';

vi.mock('../lib/api', () => ({
  proveedores: {
    createMovimiento: vi.fn(() => Promise.resolve({ id: 1 })),
  },
  inventario: {
    categorias: vi.fn(() => Promise.resolve([
      { id: 1, nombre: 'iPhone Nuevo' },
      { id: 2, nombre: 'Accesorios' },
    ])),
    depositos: vi.fn(() => Promise.resolve([{ id: 1, nombre: 'Principal' }])),
  },
  cajas: {
    listCajas: vi.fn(() => Promise.resolve([
      { id: 1, nombre: 'USD Efectivo', moneda: 'USD', activo: true },
    ])),
  },
}));

import CompraProveedorModal from './CompraProveedorModal';

function renderModal(props = {}) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <CompraProveedorModal
          proveedor={{ id: 1, nombre: 'Proveedor Test' }}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          {...props}
        />
      </ConfirmProvider>
    </ToastProvider>
  );
}

beforeEach(() => {
  cleanup();
});

describe('CompraProveedorModal', () => {
  it('renderiza header con el nombre del proveedor', () => {
    const { container } = renderModal();
    expect(container.textContent).toContain('Proveedor Test');
  });

  it('arranca con 10 filas iniciales (INITIAL_ROWS)', () => {
    const { container } = renderModal();
    const trs = container.querySelectorAll('tbody tr');
    expect(trs.length).toBeGreaterThanOrEqual(10);
  });

  it('total muestra "—" cuando no hay rows usadas (#M-13)', () => {
    const { container } = renderModal();
    expect(container.textContent).toContain('Total compra');
    expect(container.textContent).not.toMatch(/USD\s+0(,00)?(?!\d)/);
  });

  it('botón "+ 10 filas" agrega filas', () => {
    const { container, getByText } = renderModal();
    const before = container.querySelectorAll('tbody tr').length;
    fireEvent.click(getByText(/\+ 10 filas/));
    const after = container.querySelectorAll('tbody tr').length;
    expect(after - before).toBe(10);
  });
});
