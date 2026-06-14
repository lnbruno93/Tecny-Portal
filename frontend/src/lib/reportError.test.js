/**
 * Tests del filtro de ruido en reportError. Detectado 2026-06-14 mirando
 * Sentry NODE-F: el handler global de unhandledrejection estaba apilando
 * mensajes de UI ("Sin conexión con el servidor", timeouts, NO_AUTH) en la
 * cola de Sentry. Estos no son bugs sino errores transient ya manejados;
 * el filtro evita que ensucien la cola.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('reportError — filtro de ruido (NOISE_PATTERNS)', () => {
  let mockFetch;
  let mockSendBeacon;

  beforeEach(() => {
    // En vitest `import.meta.env.DEV` está en true por default → el módulo
    // sale antes de chequear el filtro. Forzamos DEV=false con stubEnv para
    // que se ejecute el path real de producción (ahí vive el filtro).
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_URL', 'http://test-backend');
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    mockSendBeacon = vi.fn().mockReturnValue(false); // forzamos al fallback fetch
    global.fetch = mockFetch;
    Object.defineProperty(global.navigator, 'sendBeacon', {
      value: mockSendBeacon, configurable: true, writable: true,
    });
    // Reset módulo entre tests para que el throttle counter empiece en 0.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('NO reporta "Sin conexión con el servidor" (error transient de red)', async () => {
    const { reportError } = await import('./reportError.js');
    reportError(new Error('Sin conexión con el servidor. Verificá tu red e intentá de nuevo.'));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSendBeacon).not.toHaveBeenCalled();
  });

  it('NO reporta "La solicitud tardó demasiado" (AbortError de timeout)', async () => {
    const { reportError } = await import('./reportError.js');
    reportError(new Error('La solicitud tardó demasiado. Verificá tu conexión e intentá de nuevo.'));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('NO reporta "NO_AUTH" (sesión expirada — ya manejado vía event)', async () => {
    const { reportError } = await import('./reportError.js');
    reportError(new Error('NO_AUTH'));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('NO reporta "No tenés permiso" (403 mostrado al usuario)', async () => {
    const { reportError } = await import('./reportError.js');
    reportError(new Error('No tenés permiso para realizar esta acción.'));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('NO reporta "Failed to fetch" (network failure genérico del browser)', async () => {
    const { reportError } = await import('./reportError.js');
    reportError(new TypeError('Failed to fetch'));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('NO reporta "Load failed" (Safari network failure)', async () => {
    const { reportError } = await import('./reportError.js');
    reportError(new TypeError('Load failed'));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('SÍ reporta un error de bug real (ej. TypeError sobre prop undefined)', async () => {
    const { reportError } = await import('./reportError.js');
    reportError(new TypeError("Cannot read properties of undefined (reading 'id')"));
    // Como sendBeacon mockeado devuelve false, cae al fetch fallback.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/client-errors');
    expect(opts.method).toBe('POST');
  });
});
