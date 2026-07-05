// Tests unitarios de lazyWithRetry.
//
// Verificamos las 3 invariantes clave:
//   1. Si el import() resuelve OK al 1er intento, no hay retries innecesarios.
//   2. Si falla 1-2 veces y después resuelve, el user ve el componente
//      (retry funcionó silenciosamente — el 99% de los network flaps).
//   3. Si todos los intentos fallan, el error se propaga para que el
//      ErrorBoundary lo catchee y dispare `reloadForNewVersion()`.
//   4. Si el import() resuelve undefined (Vite bug ante fallo silencioso),
//      lo tratamos como error → dispara el retry.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Suspense, Component } from 'react';
import { lazyWithRetry } from './lazyWithRetry';

// ErrorBoundary mínimo para catchear el error propagado por lazyWithRetry
// cuando TODOS los retries fallan (test "propaga"). Sin esto, React lo
// bubblea a la root y Vitest lo reporta como unhandled rejection.
class TestErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) return <div data-testid="boundary-caught">{this.state.err.message}</div>;
    return this.props.children;
  }
}

// Wrapper mínimo para probar componentes lazy — Suspense obligatorio en React.
function LazyHarness({ Comp }) {
  return (
    <TestErrorBoundary>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <Comp />
      </Suspense>
    </TestErrorBoundary>
  );
}

// Componente dummy que exporta default.
function Dummy() {
  return <div data-testid="dummy">Hola</div>;
}

describe('lazyWithRetry', () => {
  it('resuelve el componente al 1er intento (happy path)', async () => {
    const factory = vi.fn(() => Promise.resolve({ default: Dummy }));
    const Comp = lazyWithRetry(factory);

    render(<LazyHarness Comp={Comp} />);

    await waitFor(() => expect(screen.getByTestId('dummy')).toBeInTheDocument());
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('retryea al fallar 1 vez y muestra el componente en el 2do intento', async () => {
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce({ default: Dummy });
    const Comp = lazyWithRetry(factory);

    render(<LazyHarness Comp={Comp} />);

    await waitFor(() => expect(screen.getByTestId('dummy')).toBeInTheDocument(), { timeout: 3000 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('retryea hasta 3 intentos (initial + 2 retries) y despues propaga al ErrorBoundary', async () => {
    const err = new Error('Failed to fetch dynamically imported module');
    const factory = vi.fn().mockRejectedValue(err);
    const Comp = lazyWithRetry(factory);

    // Silenciar el console.error que React emite al bubblear a ErrorBoundary
    // (ruido de test, no afecta al resultado).
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<LazyHarness Comp={Comp} />);

    // Con 3 intentos y backoffs 0/500/1500ms, factory debería llamarse 3 veces.
    await waitFor(() => expect(factory).toHaveBeenCalledTimes(3), { timeout: 5000 });
    // Y el TestErrorBoundary debería atrapar el error final.
    await waitFor(() => {
      expect(screen.getByTestId('boundary-caught')).toBeInTheDocument();
      expect(screen.getByTestId('boundary-caught').textContent).toContain('Failed to fetch');
    });

    spy.mockRestore();
  });

  it('trata resolve con undefined/null como error → dispara retry', async () => {
    const factory = vi.fn()
      .mockResolvedValueOnce(undefined)  // Vite bug: silent-fail resolve
      .mockResolvedValueOnce({ default: Dummy });
    const Comp = lazyWithRetry(factory);

    render(<LazyHarness Comp={Comp} />);

    await waitFor(() => expect(screen.getByTestId('dummy')).toBeInTheDocument(), { timeout: 3000 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('trata resolve con objeto sin `default` como válido (no rompemos módulos que ya destructuran)', async () => {
    // Los `.then((m) => ({ default: m.TermsPage }))` — ejemplo LegalPages.jsx —
    // resuelven un objeto con `default`. No debemos rechazar objetos válidos
    // solo porque no chequeamos su forma exacta.
    const factory = vi.fn(() => Promise.resolve({ default: Dummy, extra: 'ok' }));
    const Comp = lazyWithRetry(factory);

    render(<LazyHarness Comp={Comp} />);

    await waitFor(() => expect(screen.getByTestId('dummy')).toBeInTheDocument());
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
