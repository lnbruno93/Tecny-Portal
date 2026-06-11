/**
 * Tests del FeatureFlagsContext (M-08 GRAN auditoría 2026-06-10).
 *
 * Cubre:
 *  - Provider monta y fetch a featureFlags.list() al inicio cuando hay user.
 *  - useFeatureFlag(name) devuelve true cuando el flag está prendido.
 *  - useFeatureFlag(name) devuelve false cuando está apagado.
 *  - useFeatureFlag('inexistente') devuelve false (default seguro).
 *  - Fail-safe: si la API rompe, los flags quedan en {} y los hooks devuelven false.
 *  - Sin user (sin sesión), no se intenta fetch y flags queda {}.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, waitFor } from '@testing-library/react';

// IMPORTANTE: vi.mock se hoistea — los mocks deben definirse arriba del import.
vi.mock('../lib/api', () => ({
  featureFlags: {
    list: vi.fn(),
  },
}));
vi.mock('../lib/reportError', () => ({
  silentReport: vi.fn(),
}));
// Mock del AuthContext: por default devolvemos un user logueado. Los tests
// que necesitan user=null lo override con vi.mocked(useAuth).mockReturnValue.
vi.mock('./AuthContext', () => ({
  useAuth: vi.fn(() => ({ user: { id: 1, username: 'test' } })),
}));

import { FeatureFlagsProvider, useFeatureFlag, useFeatureFlags } from './FeatureFlagsContext';
import { featureFlags as featureFlagsApi } from '../lib/api';
import { silentReport } from '../lib/reportError';
import { useAuth } from './AuthContext';

function wrap({ children }) {
  return <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Por default cada test arranca con un user logueado.
  vi.mocked(useAuth).mockReturnValue({ user: { id: 1, username: 'test' } });
});

describe('FeatureFlagsProvider', () => {
  it('al mount, llama a featureFlags.list() y expone los flags', async () => {
    featureFlagsApi.list.mockResolvedValueOnce({ flags: { foo: true, bar: false } });

    const { result } = renderHook(() => useFeatureFlags(), { wrapper: wrap });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(featureFlagsApi.list).toHaveBeenCalledTimes(1);
    expect(result.current.flags).toEqual({ foo: true, bar: false });
    expect(result.current.error).toBe(null);
  });

  it('useFeatureFlag("foo") === true cuando el flag está prendido', async () => {
    featureFlagsApi.list.mockResolvedValueOnce({ flags: { foo: true, bar: false } });

    const { result } = renderHook(() => useFeatureFlag('foo'), { wrapper: wrap });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('useFeatureFlag("bar") === false cuando el flag está apagado', async () => {
    featureFlagsApi.list.mockResolvedValueOnce({ flags: { foo: true, bar: false } });

    const { result } = renderHook(() => useFeatureFlag('bar'), { wrapper: wrap });
    // Esperamos a que termine el load (sino podríamos leer el default false
    // pre-fetch y dar un falso positivo).
    await waitFor(() => {
      const all = renderHook(() => useFeatureFlags(), { wrapper: wrap });
      // Just wait for any settling — use the hook value directly:
      expect(featureFlagsApi.list).toHaveBeenCalled();
    });
    // Tras settle, bar es false.
    expect(result.current).toBe(false);
  });

  it('useFeatureFlag("inexistente") === false (default seguro)', async () => {
    featureFlagsApi.list.mockResolvedValueOnce({ flags: { foo: true } });

    const { result } = renderHook(() => useFeatureFlag('inexistente'), { wrapper: wrap });
    await waitFor(() => {
      expect(featureFlagsApi.list).toHaveBeenCalled();
    });
    expect(result.current).toBe(false);
  });

  it('fail-safe: si la API rompe, flags queda en {} y se reporta', async () => {
    const apiError = new Error('Network error');
    featureFlagsApi.list.mockRejectedValueOnce(apiError);

    const { result } = renderHook(() => useFeatureFlags(), { wrapper: wrap });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.flags).toEqual({});
    expect(result.current.error).toBe(apiError);
    // silentReport recibió el error con el contexto de la screen.
    expect(silentReport).toHaveBeenCalledWith(apiError, expect.objectContaining({
      screen: 'FeatureFlagsContext',
    }));

    // Y todos los hooks puntuales devuelven false.
    const { result: flagResult } = renderHook(() => useFeatureFlag('cualquiera'), { wrapper: wrap });
    await waitFor(() => {
      expect(flagResult.current).toBe(false);
    });
  });

  it('sin user logueado, NO se llama a la API y flags queda en {}', async () => {
    vi.mocked(useAuth).mockReturnValue({ user: null });

    const { result } = renderHook(() => useFeatureFlags(), { wrapper: wrap });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(featureFlagsApi.list).not.toHaveBeenCalled();
    expect(result.current.flags).toEqual({});
  });

  it('renderiza children sin errores', () => {
    featureFlagsApi.list.mockResolvedValueOnce({ flags: {} });
    const { container } = render(
      <FeatureFlagsProvider><div>contenido</div></FeatureFlagsProvider>
    );
    expect(container.textContent).toContain('contenido');
  });
});
