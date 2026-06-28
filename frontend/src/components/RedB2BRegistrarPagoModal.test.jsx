// Tests para RedB2BRegistrarPagoModal — PR-A audit Red B2B (UX-2 BLOCKER).
//
// Foco: verificar que el chrome del modal usa las clases CORRECTAS del
// design system (`modal-overlay > modal` con `modal-hd / modal-body /
// modal-ft`). Antes el modal usaba `modal-backdrop / modal-content` que
// no existían en styles.css → render roto (modal sin overlay ni padding).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ToastProvider } from '../contexts/ToastContext';

vi.mock('../lib/api', () => ({
  redB2b: {
    pagos: {
      register: vi.fn(() => Promise.resolve({ ok: true })),
    },
  },
  cajas: {
    listMetodosPago: vi.fn(() => Promise.resolve([
      { id: 1, nombre: 'USD Efectivo', moneda: 'USD' },
      { id: 2, nombre: 'Banco ARS',    moneda: 'ARS' },
    ])),
  },
}));

import RedB2BRegistrarPagoModal from './RedB2BRegistrarPagoModal';

const OPERATION = {
  id: 42,
  total_usd: 1000,
  tc_used: 1100,
  my_side: 'seller',
};

function renderModal(props = {}) {
  return render(
    <ToastProvider>
      <RedB2BRegistrarPagoModal
        operation={OPERATION}
        restanteUsd={1000}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
        {...props}
      />
    </ToastProvider>
  );
}

beforeEach(() => {
  cleanup();
});

describe('RedB2BRegistrarPagoModal — PR-A audit Red B2B', () => {
  it('renderiza con clases del design system (modal-overlay/modal/modal-hd/modal-body/modal-ft)', () => {
    const { container } = renderModal();
    // El chrome viejo usaba `modal-backdrop` y `modal-content`. Si esas
    // clases siguen presentes en el DOM, el modal se ve roto en producción
    // porque no existen en styles.css.
    expect(container.querySelector('.modal-overlay')).toBeTruthy();
    expect(container.querySelector('.modal')).toBeTruthy();
    expect(container.querySelector('.modal-hd')).toBeTruthy();
    expect(container.querySelector('.modal-body')).toBeTruthy();
    expect(container.querySelector('.modal-ft')).toBeTruthy();
    // Regression guard: las clases legacy no deben volver a aparecer.
    expect(container.querySelector('.modal-backdrop')).toBeNull();
    expect(container.querySelector('.modal-content')).toBeNull();
  });

  it('renderiza el header con el id de la operación', () => {
    const { container } = renderModal();
    expect(container.textContent).toContain('Registrar pago');
    expect(container.textContent).toContain('#42');
  });

  it('expone los inputs principales (monto, moneda, tc, caja, fecha, notas)', () => {
    const { container } = renderModal();
    expect(container.querySelector('#monto-usd')).toBeTruthy();
    expect(container.querySelector('#tc-pago')).toBeTruthy();
    expect(container.querySelector('#caja-id')).toBeTruthy();
    expect(container.querySelector('#fecha-pago')).toBeTruthy();
    expect(container.querySelector('#notas-pago')).toBeTruthy();
    expect(container.querySelector('input[name="moneda_pago"][value="USD"]')).toBeTruthy();
    expect(container.querySelector('input[name="moneda_pago"][value="ARS"]')).toBeTruthy();
  });

  it('click en overlay (fuera del modal) cierra', () => {
    const onClose = vi.fn();
    const { container } = renderModal({ onClose });
    const overlay = container.querySelector('.modal-overlay');
    // Click directo en el overlay (no en el modal anidado) dispara onClose.
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it('click adentro del modal NO cierra', () => {
    const onClose = vi.fn();
    const { container } = renderModal({ onClose });
    const modal = container.querySelector('.modal');
    fireEvent.click(modal);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('botón Cancelar dispara onClose', () => {
    const onClose = vi.fn();
    const { getByText } = renderModal({ onClose });
    fireEvent.click(getByText('Cancelar'));
    expect(onClose).toHaveBeenCalled();
  });
});
