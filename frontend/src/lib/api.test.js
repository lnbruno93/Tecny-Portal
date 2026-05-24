import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, saveToken } from './api';

describe('api() — cliente HTTP', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('hace GET y agrega el header Authorization si hay token', async () => {
    saveToken('tok123');
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
    const r = await api('/api/test');
    expect(r).toEqual({ ok: 1 });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain('/api/test');
    expect(opts.headers.Authorization).toBe('Bearer tok123');
    expect(opts.method).toBe('GET');
  });

  it('serializa el body en POST', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
    await api('/api/x', 'POST', { a: 1 });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ a: 1 });
  });

  it('en 401 limpia el token, emite session-expired y lanza NO_AUTH', async () => {
    saveToken('tok');
    const handler = vi.fn();
    window.addEventListener('session-expired', handler);
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(api('/api/x')).rejects.toThrow('NO_AUTH');
    expect(localStorage.getItem('fin_token')).toBeNull();
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('session-expired', handler);
  });

  it('en 403 lanza un mensaje de permiso', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    await expect(api('/api/x')).rejects.toThrow(/permiso/i);
  });

  it('usa el campo "error" del backend en respuestas de error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'Datos inválidos' }) });
    await expect(api('/api/x')).rejects.toThrow('Datos inválidos');
  });
});
