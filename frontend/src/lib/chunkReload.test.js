import { describe, it, expect } from 'vitest';
import { isChunkLoadError } from './chunkReload';

describe('isChunkLoadError', () => {
  it('detecta errores de carga de chunk tras un deploy', () => {
    expect(isChunkLoadError(new Error("'text/html' is not a valid JavaScript MIME type."))).toBe(true);
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /assets/Financiera-abc.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
  });

  it('NO marca errores normales de la app', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(new TypeError('x is not a function'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
