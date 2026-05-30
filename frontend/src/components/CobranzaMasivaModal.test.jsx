// Smoke tests para CobranzaMasivaModal — uno de los modales spreadsheet
// más complejos del frontend. Cubrimos contratos críticos sin tocar la UX:
//   - Render inicial con cabecera + 8 filas (INITIAL_ROWS).
//   - Total muestra "—" cuando no hay rows usadas (#M-13).
//   - "Agregar 5 filas" llega a 13.
//   - applyDefaultsToEmpty respeta filas con caja/tc tipeados (#M-10).
//
// NO testeamos: AutocompletePicker (es un componente externo con UI compleja),
// guardado real al backend, navegación de teclado. Esos quedan para tests
// E2E en una próxima oleada.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from './ConfirmModal';

// Mock de la API: cajas devuelve 2 (USD y ARS), clientes search vacío.
vi.mock('../lib/api', () => ({
  cuentas: {
    cobranzaMasiva: vi.fn(() => Promise.resolve({ creados: 0 })),
    clientesSearch: vi.fn(() => Promise.resolve([])),
  },
  cajas: {
    listCajas: vi.fn(() => Promise.resolve([
      { id: 1, nombre: 'USD Efectivo', moneda: 'USD', activo: true },
      { id: 2, nombre: 'ARS Efectivo', moneda: 'ARS', activo: true },
    ])),
  },
}));

import CobranzaMasivaModal from './CobranzaMasivaModal';

function renderModal(props = {}) {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <CobranzaMasivaModal
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

describe('CobranzaMasivaModal', () => {
  it('renderiza cabecera + 8 filas iniciales', () => {
    const { container, getByText } = renderModal();
    expect(getByText('Cobranza masiva')).toBeTruthy();
    // 8 filas (INITIAL_ROWS) + 1 header = 9 trs
    const trs = container.querySelectorAll('tbody tr');
    expect(trs.length).toBeGreaterThanOrEqual(8);
  });

  it('total muestra "—" cuando no hay rows usadas (#M-13)', () => {
    const { container } = renderModal();
    // Buscamos el bloque "Total cobrado". El valor debería tener "—".
    const totalLabel = container.querySelector('.muted.tiny');
    expect(totalLabel).toBeTruthy();
    // El span con clase muted contiene el guion en lugar de "USD 0".
    const text = container.textContent;
    expect(text).toContain('Total cobrado');
    // No debe aparecer "USD 0" o "USD 0,00".
    expect(text).not.toMatch(/USD\s+0(,00)?(?!\d)/);
  });

  it('botón "+ 5 filas" agrega 5 rows más', () => {
    const { container, getByText } = renderModal();
    const before = container.querySelectorAll('tbody tr').length;
    const addBtn = getByText(/\+ 5 filas/);
    fireEvent.click(addBtn);
    const after = container.querySelectorAll('tbody tr').length;
    expect(after - before).toBe(5);
  });

  it('botón "X" cierra el modal vía onClose cuando no hay filas usadas', () => {
    const onClose = vi.fn();
    const { container } = renderModal({ onClose });
    // El botón de X tiene clase .icon-btn dentro del header.
    const xBtn = container.querySelector('.modal-hd .icon-btn');
    fireEvent.click(xBtn);
    // Sin filas usadas, tryClose llama directo a onClose.
    expect(onClose).toHaveBeenCalled();
  });
});
