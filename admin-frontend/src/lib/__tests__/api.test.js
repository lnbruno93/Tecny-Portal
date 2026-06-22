// Tests focales para lib/api.js:
//
//   · `resolveApiBase` — validación de la env var al boot (fail-loud si no
//     trae protocolo, trim, fallback).
//   · El wrapper `api()` (TANDA 5 audit 2026-06-22) — comportamiento crítico
//     que no estaba cubierto: timeout/abort, inyección de token, clamp del
//     error.message, 401 → dispatchEvent + clearToken, status attachment.
//     Estos son los caminos que rompen "silenciosamente" si regresionan:
//     un timeout sin handler congela el UI; un token mal inyectado da 401
//     sin causa visible; un error de 5000 chars rompe layout.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveApiBase, api, getToken, saveToken, clearToken, abortAllInFlight } from '../api.js';

describe('resolveApiBase', () => {
  it('acepta URL absoluta con https://', () => {
    expect(resolveApiBase('https://api.tecnyapp.com')).toBe('https://api.tecnyapp.com');
  });

  it('acepta URL absoluta con http:// (dev)', () => {
    expect(resolveApiBase('http://localhost:3000')).toBe('http://localhost:3000');
  });

  it('strippea trailing slash', () => {
    expect(resolveApiBase('https://api.tecnyapp.com/')).toBe('https://api.tecnyapp.com');
    expect(resolveApiBase('https://api.tecnyapp.com///')).toBe('https://api.tecnyapp.com');
  });

  it('throws si la URL no tiene protocolo', () => {
    // Bug clásico: sin http(s):// fetch lo trata como path relativo → fallo
    // silencioso en runtime. Acá detectamos al boot para fallar ruidoso.
    expect(() => resolveApiBase('api.tecnyapp.com')).toThrow(/inválida/);
    expect(() => resolveApiBase('//api.tecnyapp.com')).toThrow(/inválida/);
  });

  it('vuelve al fallback de prod si el input es vacío/null/undefined', () => {
    expect(resolveApiBase('')).toBe('https://tecny-backend-production.up.railway.app');
    expect(resolveApiBase(null)).toBe('https://tecny-backend-production.up.railway.app');
    expect(resolveApiBase(undefined)).toBe('https://tecny-backend-production.up.railway.app');
  });

  it('strippea whitespace del input', () => {
    expect(resolveApiBase('  https://api.tecnyapp.com  ')).toBe('https://api.tecnyapp.com');
  });
});

// ────────────────────────────────────────────────────────────────────────
// api() wrapper — fetch behavior (TANDA 5 audit 2026-06-22)
//
// Mockeamos fetch globalmente. `api()` ya leyó BASE en module-init time
// con el VITE_API_URL del entorno test, así que las URLs que vemos en
// fetch.mock.calls vienen prefijadas con esa base (o el fallback prod).
// No nos importa la URL exacta; nos importa el shape de la opciones
// (Authorization header, signal, body) y el manejo del status.
// ────────────────────────────────────────────────────────────────────────
describe('api() wrapper', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Asegurar storage limpio entre tests (jsdom mantiene state).
    try { localStorage.clear(); } catch { /* noop */ }
    // Abortar cualquier controller residual entre tests (safety).
    abortAllInFlight();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('inyecta Authorization header cuando hay token en localStorage', async () => {
    saveToken('test-token-abc');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await api('/api/super-admin/me');

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['Authorization']).toBe('Bearer test-token-abc');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('NO inyecta Authorization si no hay token (login pre-auth)', async () => {
    clearToken();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await api('/api/public/whatever');

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['Authorization']).toBeUndefined();
  });

  it('serializa body como JSON cuando se pasa', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await api('/api/x', 'POST', { foo: 'bar', n: 42 });

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ foo: 'bar', n: 42 });
  });

  it('204 No Content devuelve null sin intentar parsear JSON', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      // intencionalmente sin .json() — si lo llamara, sería un test fail
      json: async () => { throw new Error('no debería llamarse en 204'); },
    });

    const result = await api('/api/x', 'DELETE');
    expect(result).toBeNull();
  });

  it('timeout → AbortError → mensaje legible', async () => {
    // Simulamos un fetch que NUNCA resuelve, pero respeta el AbortSignal.
    // Cuando el setTimeout interno dispare controller.abort(), fetch
    // rechaza con AbortError y el wrapper traduce el mensaje.
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });

    // Timeout corto para que el test no tarde 15s.
    await expect(api('/api/slow', 'GET', null, 50))
      .rejects.toThrow(/tardó demasiado/i);
  });

  it('error de red (sin AbortError) → mensaje genérico de red', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(api('/api/x'))
      .rejects.toThrow(/sin conexión/i);
  });

  it('401 → clearToken + dispatchEvent("admin-session-expired") + throw NO_AUTH', async () => {
    saveToken('about-to-be-cleared');
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: 'token expirado' }),
    });

    const onExpired = vi.fn();
    window.addEventListener('admin-session-expired', onExpired);

    try {
      await expect(api('/api/super-admin/me'))
        .rejects.toMatchObject({ message: 'NO_AUTH', status: 401 });
      // El token debe haberse limpiado del storage.
      expect(getToken()).toBeNull();
      // El listener debe haberse disparado.
      expect(onExpired).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('admin-session-expired', onExpired);
    }
  });

  it('400/500 con error.message LARGO se clampea a 200 chars + ellipsis', async () => {
    // Bug que el clamp previene: un backend devuelve stacktrace de 10KB
    // como `error` field; sin clamp el banner renderea 10KB de texto y
    // se descalibra el layout del modal/pantalla.
    const giant = 'x'.repeat(5000);
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: giant }),
    });

    await expect(api('/api/x')).rejects.toMatchObject({
      status: 500,
      // 199 chars del clamp + el '…' final = 200 total
      message: expect.stringMatching(/^x{199}…$/),
    });
  });

  it('500 con mensaje corto NO se clampea (preserva el mensaje real)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Tenant ya está suspendido' }),
    });

    await expect(api('/api/x')).rejects.toMatchObject({
      status: 500,
      message: 'Tenant ya está suspendido',
    });
  });

  it('error sin body JSON → mensaje genérico "Error del servidor"', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json'); },
    });

    await expect(api('/api/x')).rejects.toMatchObject({
      status: 502,
      message: 'Error del servidor',
    });
  });

  it('abortAllInFlight() aborta requests en vuelo (logout race fix SEC-3)', async () => {
    // Test del fix SEC-3: una request lenta lanzada antes del logout
    // debe abortar limpiamente, no resolver después con datos del
    // super-admin previo.
    let abortedSignal = null;
    global.fetch = vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          abortedSignal = opts.signal;
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });

    const inFlight = api('/api/slow', 'GET', null, 60000);
    // Pequeña espera para que la promise corra hasta el await fetch.
    await Promise.resolve();
    abortAllInFlight();

    await expect(inFlight).rejects.toThrow(/tardó demasiado/i);
    expect(abortedSignal).not.toBeNull();
    expect(abortedSignal.aborted).toBe(true);
  });
});
