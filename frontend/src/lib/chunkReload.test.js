import { describe, it, expect } from 'vitest';
import { isChunkLoadError } from './chunkReload';

describe('isChunkLoadError', () => {
  it('detecta errores de carga de chunk tras un deploy', () => {
    expect(isChunkLoadError(new Error("'text/html' is not a valid JavaScript MIME type."))).toBe(true);
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /assets/Financiera-abc.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
  });

  // 2026-07-05 ampliación: los patterns que llegaban a Sentry sin ser detectados
  // (issues 7515527708 y 7514038974). Ver comentario en chunkReload.js.
  it('detecta el patrón Chrome: "reading \'default\'" de un undefined (React Lazy)', () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'default')"))).toBe(true);
  });

  it('detecta el patrón Safari: _result.default de undefined (React Lazy)', () => {
    expect(isChunkLoadError(new TypeError("undefined is not an object (evaluating 'e._result.default')"))).toBe(true);
  });

  it('detecta el error propio de lazyWithRetry cuando el import resuelve inválido', () => {
    expect(isChunkLoadError(new Error('Dynamic import resolved to invalid module (empty or non-object)'))).toBe(true);
  });

  it('NO marca errores normales de la app', () => {
    // Genérico sin el "reading 'default'" — sigue siendo bug de la pantalla.
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(new TypeError('x is not a function'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
