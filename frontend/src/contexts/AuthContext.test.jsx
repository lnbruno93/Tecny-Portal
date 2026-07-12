/**
 * Tests del AuthContext (TANDA 2.4 PR3).
 *
 * Métodos públicos cubiertos:
 *   - login(username, password, code)
 *   - logout()
 *   - refreshUser()
 *   - restore-on-mount: si hay token en localStorage al montar, llama
 *     authApi.me() y setea user.
 *   - listener "session-expired": limpia user.
 *
 * NOTA: `setAuthFromSignup` fue removido en TANDA 2 UX polish (auditoría
 * 2026-06-17 U5) — quedó como dead code después de TANDA 2.7 anti-enum
 * (signup ya no auto-loguea). Para tests de refreshUser que necesitan seed
 * de user state, usamos login() — el camino real que el app sigue.
 *
 * Mockeamos lib/api para inyectar respuestas controladas. saveToken / clearToken
 * son las funciones reales — usan localStorage que el test-setup.js mockea.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// IMPORTANT: vi.mock se hoistea — debe estar antes del import.
vi.mock('../lib/api', () => ({
  auth: {
    login: vi.fn(),
    me: vi.fn(),
    logout: vi.fn(),
  },
  saveToken: vi.fn((t) => { localStorage.setItem('fin_token', t); }),
  clearToken: vi.fn(() => { localStorage.removeItem('fin_token'); }),
}));

import { AuthProvider, useAuth } from './AuthContext';
import { auth as authApi, saveToken, clearToken } from '../lib/api';

function wrap({ children }) {
  return <AuthProvider>{children}</AuthProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('AuthContext', () => {
  // ── restore-on-mount ─────────────────────────────────────────────
  describe('restore on mount', () => {
    it('sin token en localStorage: NO llama me() y loading queda false', async () => {
      const { result } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(authApi.me).not.toHaveBeenCalled();
      expect(result.current.user).toBe(null);
    });

    it('con token en localStorage: llama me() y setea user si OK', async () => {
      localStorage.setItem('fin_token', 'tok-abc');
      authApi.me.mockResolvedValueOnce({
        id: 1, username: 'alice', role: 'admin', email_verified: true,
      });

      const { result } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(authApi.me).toHaveBeenCalledTimes(1);
      expect(result.current.user).toEqual(
        expect.objectContaining({ id: 1, username: 'alice' })
      );
    });

    it('con token en localStorage: si me() falla, clearToken y user queda null', async () => {
      localStorage.setItem('fin_token', 'tok-bad');
      authApi.me.mockRejectedValueOnce(new Error('NO_AUTH'));

      const { result } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(clearToken).toHaveBeenCalled();
      expect(result.current.user).toBe(null);
    });
  });

  // ── login ─────────────────────────────────────────────────────────
  describe('login', () => {
    it('login exitoso → saveToken + setUser + devuelve { user }', async () => {
      authApi.login.mockResolvedValueOnce({
        token: 'tok-xyz',
        user: { id: 2, username: 'bob', role: 'op' },
      });

      const { result } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let ret;
      await act(async () => {
        ret = await result.current.login('bob', 'pwd');
      });

      // 2026-07-12 (P0-1 Externa): 4to arg hcaptchaResponse (undefined en
      // este caso — el useAuth().login se invoca sin captcha token).
      expect(authApi.login).toHaveBeenCalledWith('bob', 'pwd', undefined, undefined);
      expect(saveToken).toHaveBeenCalledWith('tok-xyz');
      expect(result.current.user).toEqual(
        expect.objectContaining({ id: 2, username: 'bob' })
      );
      expect(ret).toEqual({ user: expect.objectContaining({ id: 2 }) });
    });

    it('login con twofa_required: NO setea user, devuelve { twofa_required: true }', async () => {
      authApi.login.mockResolvedValueOnce({ twofa_required: true });

      const { result } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let ret;
      await act(async () => {
        ret = await result.current.login('bob', 'pwd');
      });

      expect(ret).toEqual({ twofa_required: true });
      expect(saveToken).not.toHaveBeenCalled();
      expect(result.current.user).toBe(null);
    });
  });

  // ── logout ────────────────────────────────────────────────────────
  describe('logout', () => {
    it('logout llama a authApi.logout (fire-and-forget), clearToken y limpia user', async () => {
      // Arrancamos logueados.
      localStorage.setItem('fin_token', 'tok-existing');
      authApi.me.mockResolvedValueOnce({ id: 5, username: 'carol' });
      authApi.logout.mockResolvedValueOnce({});

      const { result } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => {
        expect(result.current.user).toEqual(expect.objectContaining({ id: 5 }));
      });

      act(() => {
        result.current.logout();
      });

      expect(authApi.logout).toHaveBeenCalled();
      expect(clearToken).toHaveBeenCalled();
      expect(result.current.user).toBe(null);
    });

    it('logout no rompe si authApi.logout rechaza (fire-and-forget)', async () => {
      localStorage.setItem('fin_token', 'tok-existing');
      authApi.me.mockResolvedValueOnce({ id: 6, username: 'dave' });
      authApi.logout.mockRejectedValueOnce(new Error('Server down'));

      const { result } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => {
        expect(result.current.user).toEqual(expect.objectContaining({ id: 6 }));
      });

      // No throw aún con la promise rechazada.
      expect(() => {
        act(() => { result.current.logout(); });
      }).not.toThrow();
      expect(result.current.user).toBe(null);
    });
  });

  // ── refreshUser ───────────────────────────────────────────────────
  describe('refreshUser', () => {
    it('llama a authApi.me() y actualiza el user', async () => {
      // Arrancar con user inicial via login (camino real del app).
      authApi.login.mockResolvedValueOnce({
        token: 'tok-pre',
        user: { id: 10, username: 'pre', email_verified: false },
      });
      const { result } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.login('pre', 'pwd');
      });
      expect(result.current.user.email_verified).toBe(false);

      // Refetch devuelve email_verified=true.
      authApi.me.mockResolvedValueOnce({
        id: 10, username: 'pre', email_verified: true,
      });

      let ret;
      await act(async () => {
        ret = await result.current.refreshUser();
      });

      expect(authApi.me).toHaveBeenCalled();
      expect(result.current.user.email_verified).toBe(true);
      expect(ret).toEqual(expect.objectContaining({ email_verified: true }));
    });

    it('si me() falla, no rompe — devuelve null y deja el user previo intacto', async () => {
      authApi.login.mockResolvedValueOnce({
        token: 'tok-pre',
        user: { id: 11, username: 'x', email_verified: false },
      });
      const { result } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.login('x', 'pwd');
      });

      authApi.me.mockRejectedValueOnce(new Error('NO_AUTH'));

      let ret;
      await act(async () => {
        ret = await result.current.refreshUser();
      });

      expect(ret).toBe(null);
      // El user previo no fue limpiado — refreshUser sólo loguea silenciosamente.
      expect(result.current.user).toEqual(expect.objectContaining({ id: 11 }));
    });
  });

  // ── session-expired listener ──────────────────────────────────────
  describe('session-expired event listener', () => {
    it('al dispararse window.dispatchEvent("session-expired"), limpia el user', async () => {
      localStorage.setItem('fin_token', 'tok');
      authApi.me.mockResolvedValueOnce({ id: 7, username: 'eva' });

      const { result } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => {
        expect(result.current.user).toEqual(expect.objectContaining({ id: 7 }));
      });

      act(() => {
        window.dispatchEvent(new Event('session-expired'));
      });

      expect(result.current.user).toBe(null);
    });
  });

  // ── F-21 memo del value ────────────────────────────────────────────
  // Auditoría 2026-06-30: el value del provider debe ser referencialmente
  // estable cuando los inputs no cambian. Sin useMemo, cada render del
  // provider crea un objeto nuevo y todos los consumers re-renderean.
  describe('F-21 — value memoizado', () => {
    it('el value es referencialmente estable entre re-renders sin cambios', async () => {
      authApi.login.mockResolvedValueOnce({
        token: 'tok-mem',
        user: { id: 99, username: 'memo' },
      });
      const { result, rerender } = renderHook(() => useAuth(), { wrapper: wrap });
      await waitFor(() => expect(result.current.loading).toBe(false));
      await act(async () => {
        await result.current.login('memo', 'pwd');
      });
      const beforeValue = result.current;
      // Re-render del provider sin cambios → mismo objeto.
      rerender();
      expect(result.current).toBe(beforeValue);
    });
  });
});
