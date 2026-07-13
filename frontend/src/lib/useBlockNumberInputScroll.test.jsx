import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { useBlockNumberInputScroll } from './useBlockNumberInputScroll';

// Componente de prueba: monta el hook + expone inputs de distintos tipos
// para verificar que solo intercepta type=number con focus.
function TestHarness() {
  useBlockNumberInputScroll();
  return (
    <div>
      <input data-testid="num" type="number" defaultValue="100" />
      <input data-testid="text" type="text" defaultValue="hola" />
      <input data-testid="num2" type="number" defaultValue="42" />
    </div>
  );
}

describe('useBlockNumberInputScroll', () => {
  let removeSpy;

  beforeEach(() => {
    // Espiar addEventListener / removeEventListener para verificar registro y cleanup.
    vi.spyOn(document, 'addEventListener');
    removeSpy = vi.spyOn(document, 'removeEventListener');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registra listener wheel al montar y lo quita al desmontar', () => {
    const { unmount } = render(<TestHarness />);
    expect(document.addEventListener).toHaveBeenCalledWith(
      'wheel',
      expect.any(Function),
      { passive: true }
    );
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('wheel', expect.any(Function));
  });

  it('hace blur() al input[type=number] con focus cuando llega un wheel event', () => {
    const { getByTestId } = render(<TestHarness />);
    const num = getByTestId('num');
    num.focus();
    expect(document.activeElement).toBe(num);

    // Simular wheel event que borbotea al document.
    const wheel = new WheelEvent('wheel', { bubbles: true });
    num.dispatchEvent(wheel);

    // El input debe haber perdido el foco.
    expect(document.activeElement).not.toBe(num);
  });

  it('NO toca inputs type=text aunque tengan focus', () => {
    const { getByTestId } = render(<TestHarness />);
    const text = getByTestId('text');
    text.focus();
    expect(document.activeElement).toBe(text);

    const wheel = new WheelEvent('wheel', { bubbles: true });
    text.dispatchEvent(wheel);

    // El input text sigue con focus.
    expect(document.activeElement).toBe(text);
  });

  it('NO hace blur si el input number NO tiene focus (wheel en otro lado)', () => {
    const { getByTestId } = render(<TestHarness />);
    const num = getByTestId('num');
    const num2 = getByTestId('num2');

    // Focus en num2, wheel sobre num (que no tiene focus).
    num2.focus();
    expect(document.activeElement).toBe(num2);

    const wheel = new WheelEvent('wheel', { bubbles: true });
    num.dispatchEvent(wheel);

    // num2 mantiene el focus (el wheel fue sobre num, no sobre num2).
    expect(document.activeElement).toBe(num2);
  });
});
