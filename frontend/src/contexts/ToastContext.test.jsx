/**
 * Regresión: `toast` debe tener referencia ESTABLE entre renders del provider.
 *
 * Bug histórico (28-05-2026): el objeto `toast` se creaba inline en cada render
 * del ToastProvider. Componentes que tenían `toast` en deps de useEffect entraban
 * en loop cuando su effect disparaba errores → toast.error → re-render → nueva
 * ref → effect → error → loop. Se vio en Desglose 360 cuando el endpoint del
 * backend aún no estaba desplegado.
 *
 * Fix: memoizar `toast` con useMemo. Estos tests garantizan que la ref persiste.
 */
import { describe, it, expect, act } from 'vitest';
import { render, renderHook } from '@testing-library/react';
import { ToastProvider, useToast } from './ToastContext';

function wrap({ children }) {
  return <ToastProvider>{children}</ToastProvider>;
}

describe('ToastContext — estabilidad de referencia', () => {
  it('toast tiene la MISMA referencia tras múltiples renders', () => {
    const { result, rerender } = renderHook(() => useToast(), { wrapper: wrap });
    const ref1 = result.current.toast;
    rerender();
    const ref2 = result.current.toast;
    rerender();
    const ref3 = result.current.toast;
    // Toda la API debe ser estable: success, error, info, warn, dismiss
    expect(ref1).toBe(ref2);
    expect(ref2).toBe(ref3);
    expect(ref1.error).toBe(ref2.error);
    expect(ref1.success).toBe(ref2.success);
  });

  it('toast.error existe y es invocable sin romper', () => {
    const { result } = renderHook(() => useToast(), { wrapper: wrap });
    expect(typeof result.current.toast.error).toBe('function');
    // No tira (silencioso porque no hay DOM listener)
    expect(() => result.current.toast.error('test')).not.toThrow();
  });

  it('renderiza children sin errores', () => {
    const { container } = render(<ToastProvider><div>contenido</div></ToastProvider>);
    expect(container.textContent).toContain('contenido');
  });
});
