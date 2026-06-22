/**
 * Tests del AuthContext (regresión BLOCKER S-1 audit 2026-06-22).
 *
 * El bug fixed: el event listener `admin-session-expired` se registraba
 * DESPUÉS del fetch a `/me`. Si el token cacheado estaba expirado, el
 * wrapper api() dispara el evento durante la resolución de la promise
 * — antes de que el listener exista — y se pierde. user/token quedan
 * stale hasta que el operador refresca manualmente.
 *
 * Estos tests verifican el contrato del provider:
 *   1. mount sin cachedToken → loading=false, user=null, isAuthenticated=false.
 *   2. mount con cachedToken válido (/me OK + is_super_admin=true) → user actualizado.
 *   3. mount con cachedToken inválido (/me responde !is_super_admin) → limpia state.
 *   4. evento `admin-session-expired` durante o después del fetch → user=null.
 *   5. login() + logout() actualizan state + persisten en storage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

vi.mock('../../lib/api.js', () => ({
  adminApi: { me: vi.fn() },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

import { adminApi, getToken, saveToken, clearToken } from '../../lib/api.js';
import { AuthProvider, useAuth } from '../AuthContext.jsx';

// Componente de prueba que expone el contexto.
function Probe({ onAuth }) {
  const auth = useAuth();
  onAuth(auth);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthContext', () => {
  it('mount sin token → loading completa, user=null, isAuthenticated=false', async () => {
    getToken.mockReturnValue(null);
    let lastAuth = null;
    render(
      <AuthProvider>
        <Probe onAuth={(a) => { lastAuth = a; }} />
      </AuthProvider>
    );
    await waitFor(() => expect(lastAuth.loading).toBe(false));
    expect(lastAuth.user).toBeNull();
    expect(lastAuth.isAuthenticated).toBe(false);
    expect(adminApi.me).not.toHaveBeenCalled();
  });

  it('mount con token válido + /me OK → user merged + isAuthenticated=true', async () => {
    getToken.mockReturnValue('tok_xyz');
    localStorage.setItem('admin_user', JSON.stringify({
      id: 1, username: 'lucas.bruno', email: 'l@b.com',
    }));
    adminApi.me.mockResolvedValue({
      is_super_admin: true,
      user_id: 1,
      username: 'lucas.bruno',
    });

    let lastAuth = null;
    render(
      <AuthProvider>
        <Probe onAuth={(a) => { lastAuth = a; }} />
      </AuthProvider>
    );

    await waitFor(() => expect(lastAuth.loading).toBe(false));
    expect(lastAuth.user.is_super_admin).toBe(true);
    expect(lastAuth.user.id).toBe(1);
    expect(lastAuth.isAuthenticated).toBe(true);
  });

  it('mount con token cacheado pero /me devuelve is_super_admin=false → limpia state', async () => {
    getToken.mockReturnValue('tok_revoked');
    localStorage.setItem('admin_user', JSON.stringify({ id: 1 }));
    adminApi.me.mockResolvedValue({
      is_super_admin: false,
      user_id: 1,
      username: 'no.longer',
    });

    let lastAuth = null;
    render(
      <AuthProvider>
        <Probe onAuth={(a) => { lastAuth = a; }} />
      </AuthProvider>
    );

    await waitFor(() => expect(lastAuth.loading).toBe(false));
    expect(clearToken).toHaveBeenCalled();
    expect(lastAuth.user).toBeNull();
    expect(lastAuth.isAuthenticated).toBe(false);
  });

  // BLOCKER S-1 regresión: el listener `admin-session-expired` se debe
  // registrar ANTES del fetch a /me. Si el evento se dispara durante la
  // resolución de la promise (el wrapper api() lo hace en 401), el
  // listener debe capturarlo y limpiar state.
  it('evento admin-session-expired durante el fetch /me limpia user/token', async () => {
    getToken.mockReturnValue('tok_expired');
    localStorage.setItem('admin_user', JSON.stringify({ id: 1, is_super_admin: true }));

    // Mock que simula el wrapper api() ante 401: dispara el evento
    // ANTES de rechazar la promise (orden real del wrapper).
    adminApi.me.mockImplementation(() => {
      // Microtask para que el listener tenga tiempo de registrarse.
      return Promise.resolve().then(() => {
        window.dispatchEvent(new Event('admin-session-expired'));
        const err = new Error('NO_AUTH');
        err.status = 401;
        throw err;
      });
    });

    let lastAuth = null;
    render(
      <AuthProvider>
        <Probe onAuth={(a) => { lastAuth = a; }} />
      </AuthProvider>
    );

    await waitFor(() => expect(lastAuth.loading).toBe(false));
    // El listener capturó el evento → user/token limpios.
    expect(lastAuth.user).toBeNull();
    expect(lastAuth.isAuthenticated).toBe(false);
  });

  it('evento admin-session-expired post-mount también limpia state', async () => {
    getToken.mockReturnValue('tok_ok');
    adminApi.me.mockResolvedValue({
      is_super_admin: true, user_id: 1, username: 'lucas',
    });

    let lastAuth = null;
    render(
      <AuthProvider>
        <Probe onAuth={(a) => { lastAuth = a; }} />
      </AuthProvider>
    );

    // Esperar al mount + revalidación inicial.
    await waitFor(() => expect(lastAuth.isAuthenticated).toBe(true));

    // Disparar evento post-mount (ej. otra request devolvió 401).
    act(() => {
      window.dispatchEvent(new Event('admin-session-expired'));
    });

    await waitFor(() => expect(lastAuth.user).toBeNull());
    expect(lastAuth.isAuthenticated).toBe(false);
  });

  it('login() + logout() mutan state correctamente', async () => {
    getToken.mockReturnValue(null);

    let lastAuth = null;
    render(
      <AuthProvider>
        <Probe onAuth={(a) => { lastAuth = a; }} />
      </AuthProvider>
    );

    await waitFor(() => expect(lastAuth.loading).toBe(false));

    act(() => {
      lastAuth.login('tok_new', { id: 1, is_super_admin: true, username: 'lucas' });
    });
    expect(saveToken).toHaveBeenCalledWith('tok_new');
    await waitFor(() => expect(lastAuth.isAuthenticated).toBe(true));

    act(() => { lastAuth.logout(); });
    expect(clearToken).toHaveBeenCalled();
    await waitFor(() => expect(lastAuth.user).toBeNull());
  });
});
