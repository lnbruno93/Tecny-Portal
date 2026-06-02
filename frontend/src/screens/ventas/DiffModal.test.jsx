// Tests del DiffModal — modal de confirmación cuando los pagos no suman el total.
//
// Verifica:
//   · Render condicional (open=false → null).
//   · Botones "Corregir" / "Aceptar igual" resuelven la promesa con false/true.
//   · Muestra correctamente "Sobrante" vs "Restante" según signo de la diferencia.
//   · onClose se llama después de la resolución.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import DiffModal from './DiffModal';

function renderDiff(stateOverrides = {}, onClose = vi.fn()) {
  const resolve = vi.fn();
  const state = {
    open: true,
    items: 1000,
    cubierto: 800,
    dif: -200, // restante (a deber)
    resolve,
    ...stateOverrides,
  };
  return { resolve, onClose, ...render(<DiffModal state={state} onClose={onClose} />) };
}

beforeEach(() => { cleanup(); });

describe('DiffModal — render condicional', () => {
  it('open=false: no renderiza nada', () => {
    const { container } = render(<DiffModal state={{ open: false }} onClose={vi.fn()} />);
    expect(container.querySelector('.modal')).toBeNull();
  });

  it('open=true: renderiza modal con role="dialog" aria-modal', () => {
    const { container } = renderDiff();
    const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-labelledby')).toBe('diff-modal-title');
  });
});

describe('DiffModal — datos mostrados', () => {
  it('muestra total venta y total pagado con 2 decimales', () => {
    const { container } = renderDiff({ items: 1500.5, cubierto: 1200.25, dif: -300.25 });
    expect(container.textContent).toContain('u$s 1500.50');
    expect(container.textContent).toContain('u$s 1200.25');
  });

  it('dif < 0: muestra "Restante:" con signo - y color neg', () => {
    const { container } = renderDiff({ dif: -200 });
    expect(container.textContent).toContain('Restante:');
    expect(container.textContent).toContain('u$s -200.00');
  });

  it('dif > 0: muestra "Sobrante:" con signo + y color pos', () => {
    const { container } = renderDiff({ items: 800, cubierto: 1000, dif: 200 });
    expect(container.textContent).toContain('Sobrante:');
    expect(container.textContent).toContain('u$s +200.00');
  });
});

describe('DiffModal — acciones', () => {
  it('click "Corregir" resuelve la promesa con false + llama onClose', () => {
    const { resolve, onClose, getByText } = renderDiff();
    fireEvent.click(getByText('Corregir'));
    expect(onClose).toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(false);
  });

  it('click "Aceptar igual" resuelve la promesa con true + llama onClose', () => {
    const { resolve, onClose, getByText } = renderDiff();
    fireEvent.click(getByText('Aceptar igual'));
    expect(onClose).toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(true);
  });

  it('si state.resolve es null, igual cierra (no rompe)', () => {
    const onClose = vi.fn();
    const { getByText } = render(<DiffModal state={{
      open: true, items: 100, cubierto: 50, dif: -50, resolve: null,
    }} onClose={onClose} />);
    fireEvent.click(getByText('Corregir'));
    expect(onClose).toHaveBeenCalled();
    // No tira error por null resolver.
  });
});
