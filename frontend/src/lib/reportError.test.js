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

  // Ampliación 2026-07-06 (post-rebarrer): los errores de chunk load fail se
  // manejan en `lazyWithRetry` + `ErrorBoundary.reloadForNewVersion()` y NO
  // aportan valor en Sentry (0 users mapeados, fingerprint persistente 6+
  // semanas). El fix añade patterns al NOISE_PATTERNS para silenciarlos.
  describe('chunk load errors (post-rebarrer 2026-07-06)', () => {
    it('NO reporta "_result.default" (Safari — TECNY-PORTAL-BACKEND-4)', async () => {
      const { reportError } = await import('./reportError.js');
      reportError(new TypeError("undefined is not an object (evaluating 'e._result.default')"));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('NO reporta "Cannot read properties of undefined (reading \'default\')" (Chrome)', async () => {
      const { reportError } = await import('./reportError.js');
      reportError(new TypeError("Cannot read properties of undefined (reading 'default')"));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('NO reporta "Failed to fetch dynamically imported module"', async () => {
      const { reportError } = await import('./reportError.js');
      reportError(new TypeError('Failed to fetch dynamically imported module: https://.../assets/foo.js'));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('NO reporta "Importing a module script failed" (Safari)', async () => {
      const { reportError } = await import('./reportError.js');
      reportError(new TypeError('Importing a module script failed.'));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('NO reporta "Loading chunk X failed" (Webpack legacy)', async () => {
      const { reportError } = await import('./reportError.js');
      reportError(new Error('Loading chunk 42 failed.'));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('NO reporta "Dynamic import resolved to invalid module" (guard sintético)', async () => {
      const { reportError } = await import('./reportError.js');
      reportError(new Error('Dynamic import resolved to invalid module (empty or non-object)'));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('NO reporta "valid JavaScript MIME type" (chunk devuelve HTML — variante Safari/legacy)', async () => {
      const { reportError } = await import('./reportError.js');
      // Mensaje literal que Safari/legacy emite cuando el chunk devuelve
      // text/html en lugar de application/javascript.
      reportError(new TypeError('The service worker responded with a non valid JavaScript MIME type of text/html.'));
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // Regresión: NO queremos filtrar todos los "Cannot read properties of
    // undefined" — solo los que específicamente leen 'default' (chunk load).
    // Un bug real leyendo otras props debe seguir reportándose.
    it('SÍ reporta "Cannot read properties of undefined (reading \'foo\')" (bug real, no chunk)', async () => {
      const { reportError } = await import('./reportError.js');
      reportError(new TypeError("Cannot read properties of undefined (reading 'foo')"));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});

// Auditoría 2026-06-30 Q-09: si el build sale sin VITE_API_URL, el fallback
// hard-coded a producción mandaba todos los reports a la cola de prod aunque
// el build fuera de staging. Ahora preferimos NO enviar y warnear local.
describe('reportError — sin VITE_API_URL (Q-09)', () => {
  let mockFetch;
  let mockSendBeacon;
  let warnSpy;

  beforeEach(() => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_URL', ''); // no seteada
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    mockSendBeacon = vi.fn().mockReturnValue(true);
    global.fetch = mockFetch;
    Object.defineProperty(global.navigator, 'sendBeacon', {
      value: mockSendBeacon, configurable: true, writable: true,
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('NO envía reportes si VITE_API_URL está vacío + warnea 1 sola vez', async () => {
    const { reportError } = await import('./reportError.js');
    reportError(new TypeError("Bug real de producción"));
    reportError(new TypeError("Segundo bug"));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSendBeacon).not.toHaveBeenCalled();
    // El warn sólo se loguea la primera vez para no floodear la consola.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/VITE_API_URL/);
  });
});
