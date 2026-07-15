// Tests de reportError — verifica el pipeline de reporte de errores del
// admin al backend (task #137, 2026-07-15).
//
// Foco: contratos observables (llama a sendBeacon con el shape esperado,
// filtra ruido, respeta throttle). NO testeamos el path interno del backend
// ni Sentry — eso lo cubre backend/tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock import.meta.env: por defecto simulamos producción (DEV=false) y con
// VITE_API_URL seteado. Los tests que necesiten variantes lo overrideean.
vi.stubEnv('DEV', false);
vi.stubEnv('VITE_API_URL', 'https://api.test.local');

// Mock sendBeacon (siempre exitoso) — captura las llamadas para assertions.
const sendBeaconMock = vi.fn(() => true);

describe('reportError (admin)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset del módulo entre tests: reportError mantiene throttle counters
    // en module scope (reportsSent, lastReportAt) — sin reset todos los
    // tests después del 5° dispararían MAX_REPORTS_PER_SESSION.
    vi.resetModules();
    // Stub globals cada test para asegurar independencia.
    global.navigator = {
      sendBeacon: sendBeaconMock,
      userAgent: 'Test/1.0',
    };
    global.window = {
      location: { href: 'https://admin.test.local/some-page' },
    };
    global.Blob = class Blob {
      constructor(chunks) { this.chunks = chunks; }
    };
  });

  it('reporta un error con el payload esperado', async () => {
    const { reportError } = await import('../reportError.js');
    reportError(new Error('test error'));
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeaconMock.mock.calls[0];
    expect(url).toBe('https://api.test.local/api/client-errors');
    const body = JSON.parse(blob.chunks[0]);
    expect(body.message).toBe('test error');
    expect(body.source).toBe('admin');
    expect(body.url).toBe('https://admin.test.local/some-page');
    expect(body.userAgent).toBe('Test/1.0');
    expect(body.build_commit).toBeDefined();
    expect(body.build_version).toBeDefined();
  });

  it('filtra ruido (NetworkError) — no reporta', async () => {
    const { reportError } = await import('../reportError.js');
    reportError(new Error('NetworkError when attempting to fetch resource'));
    expect(sendBeaconMock).not.toHaveBeenCalled();
  });

  it('filtra ruido (chunk load failure)', async () => {
    const { reportError } = await import('../reportError.js');
    reportError(new Error('Failed to fetch dynamically imported module'));
    expect(sendBeaconMock).not.toHaveBeenCalled();
  });

  it('no envía nada en dev (import.meta.env.DEV=true)', async () => {
    vi.stubEnv('DEV', true);
    const { reportError } = await import('../reportError.js');
    reportError(new Error('dev error'));
    expect(sendBeaconMock).not.toHaveBeenCalled();
    vi.stubEnv('DEV', false); // cleanup
  });

  it('no envía si VITE_API_URL está vacío (no fallback a prod)', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const { reportError } = await import('../reportError.js');
    reportError(new Error('base missing'));
    expect(sendBeaconMock).not.toHaveBeenCalled();
    vi.stubEnv('VITE_API_URL', 'https://api.test.local'); // cleanup
  });

  it('respeta throttle: máximo 5 reportes por sesión', async () => {
    const { reportError } = await import('../reportError.js');
    // Enviar 10 errores distintos → solo 5 deberían pasar el throttle.
    // Necesitamos avanzar el reloj entre reports para pasar MIN_INTERVAL_MS.
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) {
      reportError(new Error(`err ${i}`));
      vi.advanceTimersByTime(3000); // > MIN_INTERVAL_MS
    }
    expect(sendBeaconMock).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it('context.source es preservado si el caller lo pasa', async () => {
    const { reportError } = await import('../reportError.js');
    reportError(new Error('boundary error'), { source: 'admin:react-boundary' });
    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const [, blob] = sendBeaconMock.mock.calls[0];
    const body = JSON.parse(blob.chunks[0]);
    expect(body.source).toBe('admin:react-boundary');
  });
});
