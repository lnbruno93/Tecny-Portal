/**
 * Tests del FeatureFlagsContext (M-08 GRAN auditoría 2026-06-10).
 *
 * 2026-07-20 F3 Rec proactiva #3: el context cambió consumer a
 * `features.resolved()` (endpoint /api/features per-tenant con overrides)
 * en vez de `featureFlags.list()` (endpoint /api/feature-flags global).
 * Shape del response nuevo: `{ features: {...}, resolved_at }` — el context
 * guarda `data.features` como `flags` en el state para no romper consumers.
 *
 * Cubre:
 *  - Provider monta y fetch a features.resolved() al inicio cuando hay user.
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
  features: {
    resolved: vi.fn(),
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
import { features as featuresApi } from '../lib/api';
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

// Helper que replica el shape del response de /api/features (F3).
// Facilita cambiar el shape en un solo lugar si el backend evoluciona.
const resolvedResponse = (features) => ({
  features,
  resolved_at: '2026-07-20T18:45:00.000Z',
});

describe('FeatureFlagsProvider', () => {
  it('al mount, llama a features.resolved() y expone los flags', async () => {
    featuresApi.resolved.mockResolvedValueOnce(resolvedResponse({ foo: true, bar: false }));

    const { result } = renderHook(() => useFeatureFlags(), { wrapper: wrap });
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(featuresApi.resolved).toHaveBeenCalledTimes(1);
    expect(result.current.flags).toEqual({ foo: true, bar: false });
    expect(result.current.error).toBe(null);
  });

  it('useFeatureFlag("foo") === true cuando el flag está prendido', async () => {
    featuresApi.resolved.mockResolvedValueOnce(resolvedResponse({ foo: true, bar: false }));

    const { result } = renderHook(() => useFeatureFlag('foo'), { wrapper: wrap });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('useFeatureFlag("bar") === false cuando el flag está apagado', async () => {
    featuresApi.resolved.mockResolvedValueOnce(resolvedResponse({ foo: true, bar: false }));

    const { result } = renderHook(() => useFeatureFlag('bar'), { wrapper: wrap });
    // Esperamos a que termine el load (sino podríamos leer el default false
    // pre-fetch y dar un falso positivo).
    await waitFor(() => {
      expect(featuresApi.resolved).toHaveBeenCalled();
    });
    // Tras settle, bar es false.
    expect(result.current).toBe(false);
  });

  it('useFeatureFlag("inexistente") === false (default seguro)', async () => {
    featuresApi.resolved.mockResolvedValueOnce(resolvedResponse({ foo: true }));

    const { result } = renderHook(() => useFeatureFlag('inexistente'), { wrapper: wrap });
    await waitFor(() => {
      expect(featuresApi.resolved).toHaveBeenCalled();
    });
    expect(result.current).toBe(false);
  });

  it('fail-safe: si la API rompe, flags queda en {} y se reporta', async () => {
    const apiError = new Error('Network error');
    featuresApi.resolved.mockRejectedValueOnce(apiError);

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
    expect(featuresApi.resolved).not.toHaveBeenCalled();
    expect(result.current.flags).toEqual({});
  });

  it('renderiza children sin errores', () => {
    featuresApi.resolved.mockResolvedValueOnce(resolvedResponse({}));
    const { container } = render(
      <FeatureFlagsProvider><div>contenido</div></FeatureFlagsProvider>
    );
    expect(container.textContent).toContain('contenido');
  });
});
