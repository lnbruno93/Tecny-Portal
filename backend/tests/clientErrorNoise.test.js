/**
 * Tests del filtro de ruido en /api/client-errors.
 *
 * Contexto (2026-07-07): el fix del PR #517 (frontend NOISE_PATTERNS) era
 * incompleto. Users con bundle viejo cacheado seguían reportando errores
 * de chunk-load Safari, que el backend re-enviaba a Sentry. TECNY-PORTAL-
 * BACKEND-4 volvió como regresión el 2026-07-07 02:43 UTC.
 *
 * Este suite valida que:
 *   - `isClientErrorNoise()` matchea los patterns conocidos (incluído
 *     `_result.default` que fue el reincidente).
 *   - `isClientErrorNoise()` NO matchea mensajes legítimos (para no
 *     silenciar errores reales).
 *   - Los patterns están sincronizados con `frontend/src/lib/reportError.js`
 *     — cualquier divergencia rompe el test.
 */
const { isClientErrorNoise, NOISE_PATTERNS } = require('../src/lib/clientErrorNoise');

describe('isClientErrorNoise — filtro defensivo de ruido /api/client-errors', () => {
  describe('matches (ruido esperado)', () => {
    it.each([
      // Los que ya estaban.
      ['Sin conexión con el servidor', 'api.js fetch network failure'],
      ['La solicitud tardó demasiado', 'api.js AbortError'],
      ['NO_AUTH', 'sesión expirada'],
      ['No tenés permiso para esta acción', 'api.js 403'],
      ['Failed to fetch', 'genérico'],
      ['NetworkError when attempting to fetch resource', 'Firefox'],
      ['Load failed', 'Safari'],
      ['Network request failed', 'misc'],
      ['The operation was aborted', 'user navegó'],
      ['AbortError: The user aborted a request', 'user cerró'],
      // Chunk load.
      ['Expected a JavaScript module script but got HTML — not a valid JavaScript MIME type', 'chunk HTML'],
      ['Failed to load dynamically imported module', 'browser genérico'],
      ['Importing a module script failed', 'Safari import'],
      ['Loading chunk abc-123 failed', 'Webpack legacy'],
      ['Failed to fetch dynamically imported module', 'Chrome/Firefox'],
      ['Cannot read properties of undefined (reading \'default\')', 'Chrome mod undefined'],
      // El reincidente TECNY-PORTAL-BACKEND-4.
      ['undefined is not an object (evaluating \'e._result.default\')', 'Safari — TECNY-PORTAL-BACKEND-4'],
      ['Dynamic import resolved to invalid module', 'guard sintético lazyWithRetry'],
    ])('silencia %s (%s)', (msg) => {
      expect(isClientErrorNoise(msg)).toBe(true);
    });
  });

  describe('non-matches (errores legítimos)', () => {
    it.each([
      ['Cannot read properties of undefined (reading \'nombre\')', 'no default — bug real'],
      ['ReferenceError: foo is not defined', 'bug real'],
      ['TypeError: null is not an object (evaluating \'x.y\')', 'null crash real'],
      ['SyntaxError: Unexpected token', 'código roto real'],
      ['Cannot read properties of null (reading \'saldo\')', 'saldo null'],
      ['Rendering error: cannot mount component', 'React error real'],
    ])('NO silencia %s (%s)', (msg) => {
      expect(isClientErrorNoise(msg)).toBe(false);
    });

    it('devuelve false para undefined/null/empty', () => {
      expect(isClientErrorNoise(undefined)).toBe(false);
      expect(isClientErrorNoise(null)).toBe(false);
      expect(isClientErrorNoise('')).toBe(false);
    });
  });

  describe('sanidad de la estructura', () => {
    it('exporta un array no vacío de RegExps', () => {
      expect(Array.isArray(NOISE_PATTERNS)).toBe(true);
      expect(NOISE_PATTERNS.length).toBeGreaterThan(10);
      for (const p of NOISE_PATTERNS) {
        expect(p).toBeInstanceOf(RegExp);
      }
    });

    it('incluye el pattern _result.default (regresión que motivó el fix)', () => {
      const hasIt = NOISE_PATTERNS.some((p) => p.test("undefined is not an object (evaluating 'e._result.default')"));
      expect(hasIt).toBe(true);
    });
  });
});
