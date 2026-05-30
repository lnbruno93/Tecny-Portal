// Smoke tests para ScrollFadeX. NO testeamos ResizeObserver/scroll detection
// (require jsdom layout que no soporta — el contrato real solo se valida en
// runtime en el navegador). Acá garantizamos:
//   - Render del wrapper + inner correctos.
//   - Sin overflow inicial: no se aplican las clases reactivas.
//   - El componente cleanup correctamente al desmontarse.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import ScrollFadeX from './ScrollFadeX';

// jsdom no tiene ResizeObserver. Stub mínimo: no observa nada y devuelve disconnect.
class ResizeObserverStub {
  constructor(cb) { this.cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub;
});
afterEach(() => {
  cleanup();
});

describe('ScrollFadeX', () => {
  it('renderiza children dentro del inner scrollable', () => {
    const { container, getByText } = render(
      <ScrollFadeX>
        <span>Tab 1</span><span>Tab 2</span>
      </ScrollFadeX>
    );
    expect(getByText('Tab 1')).toBeTruthy();
    expect(getByText('Tab 2')).toBeTruthy();
    expect(container.querySelector('.scroll-fade-rx')).toBeTruthy();
    expect(container.querySelector('.scroll-fade-rx__inner')).toBeTruthy();
  });

  it('por default no aplica clases de overflow (sin medición)', () => {
    const { container } = render(<ScrollFadeX>x</ScrollFadeX>);
    const wrapper = container.querySelector('.scroll-fade-rx');
    expect(wrapper.classList.contains('has-overflow-left')).toBe(false);
    expect(wrapper.classList.contains('has-overflow-right')).toBe(false);
  });

  it('forwardea className y style adicionales al wrapper externo', () => {
    const { container } = render(
      <ScrollFadeX className="my-extra" style={{ marginTop: 10 }}>x</ScrollFadeX>
    );
    const wrapper = container.querySelector('.scroll-fade-rx');
    expect(wrapper.classList.contains('my-extra')).toBe(true);
    expect(wrapper.style.marginTop).toBe('10px');
  });

  it('disconnect del ResizeObserver al desmontar (smoke)', () => {
    const disconnect = vi.fn();
    global.ResizeObserver = class {
      observe() {}
      disconnect() { disconnect(); }
    };
    const { unmount } = render(<ScrollFadeX>x</ScrollFadeX>);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
