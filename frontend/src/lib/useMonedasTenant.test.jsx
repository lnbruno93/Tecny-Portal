// Multi-país F3 (#469): tests del hook useMonedasTenant.
//
// Wrap el hook con AuthProvider + mock de api.me para inyectar el user que
// querramos. Replicamos el patrón de AuthContext.test.jsx para mantener
// consistencia (mock de lib/api, restore-on-mount con token+me()).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  auth: {
    login: vi.fn(),
    me: vi.fn(),
    logout: vi.fn(),
  },
  saveToken: vi.fn(),
  clearToken: vi.fn(),
}));

import { AuthProvider } from '../contexts/AuthContext';
import { auth as authApi } from '../lib/api';
import { useMonedasTenant } from './useMonedasTenant';

function wrap({ children }) {
  return <AuthProvider>{children}</AuthProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('useMonedasTenant', () => {
  it('sin user (no logueado) → fallback AR', async () => {
    const { result } = renderHook(() => useMonedasTenant(), { wrapper: wrap });
    // No token → AuthProvider no llama me() y user queda null. El hook
    // devuelve fallback AR inmediatamente.
    expect(result.current.pais).toBe('AR');
    expect(result.current.monedas).toEqual(['ARS', 'USD', 'USDT']);
    expect(result.current.monedaLocal).toBe('ARS');
  });

  it('user UY → monedas UYU + USD + USDT, monedaLocal UYU', async () => {
    localStorage.setItem('fin_token', 'tok');
    authApi.me.mockResolvedValueOnce({
      id: 1,
      username: 'op_uy',
      tenant: { id: 12, pais: 'UY', moneda_local: 'UYU' },
    });

    const { result } = renderHook(() => useMonedasTenant(), { wrapper: wrap });

    await waitFor(() => expect(result.current.pais).toBe('UY'));
    expect(result.current.monedas).toEqual(['UYU', 'USD', 'USDT']);
    expect(result.current.monedaLocal).toBe('UYU');
    expect(result.current.paisLabel).toEqual({ flag: '🇺🇾', nombre: 'Uruguay' });
  });

  it('user AR → monedas ARS + USD + USDT, monedaLocal ARS', async () => {
    localStorage.setItem('fin_token', 'tok');
    authApi.me.mockResolvedValueOnce({
      id: 2,
      username: 'op_ar',
      tenant: { id: 5, pais: 'AR', moneda_local: 'ARS' },
    });

    const { result } = renderHook(() => useMonedasTenant(), { wrapper: wrap });

    await waitFor(() => expect(result.current.pais).toBe('AR'));
    expect(result.current.monedas).toEqual(['ARS', 'USD', 'USDT']);
    expect(result.current.monedaLocal).toBe('ARS');
    expect(result.current.paisLabel).toEqual({ flag: '🇦🇷', nombre: 'Argentina' });
  });

  it('user con tenant pero sin pais (JWT legacy pre-F2) → fallback AR', async () => {
    localStorage.setItem('fin_token', 'tok');
    authApi.me.mockResolvedValueOnce({
      id: 3,
      username: 'op_legacy',
      tenant: { id: 1 /* sin pais */ },
    });

    const { result } = renderHook(() => useMonedasTenant(), { wrapper: wrap });

    await waitFor(() => expect(result.current.monedas.length).toBe(3));
    expect(result.current.pais).toBe('AR');
    expect(result.current.monedas).toEqual(['ARS', 'USD', 'USDT']);
    expect(result.current.monedaLocal).toBe('ARS');
  });
});
