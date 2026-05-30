// Smoke tests para VentaB2BModal — modal de venta tipo planilla a clientes CC.
// Mismo enfoque que CobranzaMasivaModal.test: contratos críticos sin profundizar
// en AutocompletePicker o flow de save al backend.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from './ConfirmModal';

vi.mock('../lib/api', () => ({
  cuentas: {
    ventaB2B: vi.fn(() => Promise.resolve({ id: 1 })),
  },
  inventario: {
    productosSearch: vi.fn(() => Promise.resolve([])),
  },
  cajas: {
    listCajas: vi.fn(() => Promise.resolve([
      { id: 1, nombre: 'USD Efectivo', moneda: 'USD', activo: true },
    ])),
  },
}));

import VentaB2BModal from './VentaB2BModal';

function renderModal(props = {}) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <VentaB2BModal
          cliente={{ id: 1, nombre: 'Cliente Test' }}
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

describe('VentaB2BModal', () => {
  it('renderiza el header con el nombre del cliente', () => {
    const { container } = renderModal();
    expect(container.textContent).toContain('Cliente Test');
  });

  it('arranca con 10 filas iniciales (INITIAL_ROWS)', () => {
    const { container } = renderModal();
    const trs = container.querySelectorAll('tbody tr');
    expect(trs.length).toBeGreaterThanOrEqual(10);
  });

  it('total muestra "—" cuando no hay rows usadas (#M-13)', () => {
    const { container } = renderModal();
    expect(container.textContent).toContain('Total venta');
    expect(container.textContent).not.toMatch(/USD\s+0(,00)?(?!\d)/);
  });

  it('botón "+ 10 filas" agrega 10 rows más', () => {
    const { container, getByText } = renderModal();
    const before = container.querySelectorAll('tbody tr').length;
    fireEvent.click(getByText(/\+ 10 filas/));
    const after = container.querySelectorAll('tbody tr').length;
    expect(after - before).toBe(10);
  });
});
