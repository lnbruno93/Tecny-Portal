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
  // SEC-3 fix (audit 2026-06-22): logout() ahora llama abortAllInFlight()
  // ANTES de limpiar state, para abortar requests in-flight que podrían
  // resolver post-logout con datos del super-admin. El mock necesita
  // exportarlo o el test de logout crashea con "is not a function".
  abortAllInFlight: vi.fn(),
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

  // S-8 regresión (audit 2026-06-22): localStorage con JSON válido pero
  // shape inválida (array, number, string, null) → loadUser devuelve null
  // en vez de propagar la basura.
  it('loadUser sanitiza localStorage con JSON inválido (array)', async () => {
    localStorage.setItem('admin_user', JSON.stringify([1, 2, 3]));
    getToken.mockReturnValue(null);
    let lastAuth = null;
    render(
      <AuthProvider>
        <Probe onAuth={(a) => { lastAuth = a; }} />
      </AuthProvider>
    );
    await waitFor(() => expect(lastAuth.loading).toBe(false));
    expect(lastAuth.user).toBeNull();
  });

  it('loadUser sanitiza localStorage con JSON corrupto', async () => {
    localStorage.setItem('admin_user', '{not valid json}');
    getToken.mockReturnValue(null);
    let lastAuth = null;
    render(
      <AuthProvider>
        <Probe onAuth={(a) => { lastAuth = a; }} />
      </AuthProvider>
    );
    await waitFor(() => expect(lastAuth.loading).toBe(false));
    expect(lastAuth.user).toBeNull();
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

  // TANDA 5 audit 2026-06-22 — edge cases del listener `admin-session-expired`
  // que no estaban cubiertos. El bug clase: si el provider se desmonta sin
  // limpiar listener, hay memory leak (importante en CI con muchos mount/
  // unmount) y comportamientos raros si dos events caen seguidos.

  it('unmount del provider remueve el listener (no memory leak)', async () => {
    getToken.mockReturnValue(null);
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { unmount } = render(
      <AuthProvider>
        <Probe onAuth={() => {}} />
      </AuthProvider>
    );

    // Esperar mount completo (incluido useEffect).
    await waitFor(() => {
      expect(addSpy.mock.calls.some((c) => c[0] === 'admin-session-expired')).toBe(true);
    });
    const addedCount = addSpy.mock.calls.filter((c) => c[0] === 'admin-session-expired').length;

    unmount();

    // Después del unmount, el cleanup del useEffect debe haber removido
    // exactamente el mismo número de listeners que se agregaron.
    const removedCount = removeSpy.mock.calls.filter((c) => c[0] === 'admin-session-expired').length;
    expect(removedCount).toBe(addedCount);
  });

  it('dos eventos admin-session-expired consecutivos ambos limpian state', async () => {
    // Bug clase: si dos 401s caen casi simultáneamente (ej. batch de
    // requests in-flight cuando el token expira), el segundo evento
    // dispara sobre state ya null. No debe crashear ni re-renderear raro.
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

    await waitFor(() => expect(lastAuth.isAuthenticated).toBe(true));

    // Dos eventos seguidos — simula dos 401s casi simultáneos.
    act(() => {
      window.dispatchEvent(new Event('admin-session-expired'));
      window.dispatchEvent(new Event('admin-session-expired'));
    });

    await waitFor(() => expect(lastAuth.user).toBeNull());
    expect(lastAuth.isAuthenticated).toBe(false);
    // No crashea: el Probe sigue rindiendo correctamente con state limpio.
  });

  it('listener se registra ANTES del fetch /me (orden importa para race S-1)', async () => {
    // Test del orden literal: cuando llega el mount, addEventListener
    // debe llamarse antes que adminApi.me. Sin esto, si /me dispara el
    // evento sincrónicamente (en una microtask), se pierde.
    // Usamos un spy NO-override que solo cuenta calls — el listener real
    // sigue funcionando vía addEventListener nativo.
    const callOrder = [];

    getToken.mockReturnValue('tok_xyz');

    // Wrap window.addEventListener sin reemplazar la impl.
    const origAddEventListener = window.addEventListener.bind(window);
    const addEventSpy = vi.spyOn(window, 'addEventListener');
    addEventSpy.mockImplementation((evt, handler, opts) => {
      if (evt === 'admin-session-expired') callOrder.push('addEventListener');
      return origAddEventListener(evt, handler, opts);
    });

    adminApi.me.mockImplementation(() => {
      callOrder.push('me');
      return Promise.resolve({ is_super_admin: true, user_id: 1, username: 'l' });
    });

    render(
      <AuthProvider>
        <Probe onAuth={() => {}} />
      </AuthProvider>
    );

    await waitFor(() => expect(callOrder).toContain('me'));
    const addIdx = callOrder.indexOf('addEventListener');
    const meIdx = callOrder.indexOf('me');
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(meIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeLessThan(meIdx);

    addEventSpy.mockRestore();
  });
});
