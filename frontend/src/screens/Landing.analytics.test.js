/**
 * Tests unitarios del módulo Landing.analytics.js — Sprint 1 H3.
 *
 * Cubre: trackEvent, markPerformance, measurePerformance, reportLandingError.
 * Los helpers son puros wrappers de APIs web (dataLayer, performance) — el
 * objetivo del test es asegurar que:
 *   1. Nunca revientan si la API no existe (safe fallbacks).
 *   2. El payload al dataLayer tiene la shape esperada.
 *   3. Los errores se propagan a silentReport con el screen preseteado.
 *
 * En DEV el módulo también loguea a console; silenciamos console en los tests
 * para no ensuciar la salida.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock silentReport ANTES del import del módulo bajo test.
vi.mock('../lib/reportError', () => ({
  silentReport: vi.fn(),
}));

import { silentReport } from '../lib/reportError';
import {
  trackEvent,
  markPerformance,
  measurePerformance,
  reportLandingError,
} from './Landing.analytics';

describe('Landing.analytics', () => {
  beforeEach(() => {
    // Reset dataLayer entre tests para aislamiento.
    window.dataLayer = undefined;
    vi.clearAllMocks();
  });

  describe('trackEvent', () => {
    it('pushea al dataLayer con event + params + ts', () => {
      trackEvent('landing_view', { url: 'https://tecnyapp.com/' });
      expect(window.dataLayer).toHaveLength(1);
      expect(window.dataLayer[0]).toMatchObject({
        event: 'landing_view',
        url: 'https://tecnyapp.com/',
      });
      expect(typeof window.dataLayer[0].ts).toBe('number');
    });

    it('crea el dataLayer si no existía (idempotent)', () => {
      expect(window.dataLayer).toBeUndefined();
      trackEvent('cta_click', { location: 'nav', target: 'signup' });
      expect(Array.isArray(window.dataLayer)).toBe(true);
    });

    it('acumula múltiples eventos en el mismo dataLayer', () => {
      trackEvent('landing_view');
      trackEvent('cta_click', { location: 'hero' });
      trackEvent('landing_content_ready');
      expect(window.dataLayer.map(e => e.event)).toEqual([
        'landing_view', 'cta_click', 'landing_content_ready',
      ]);
    });

    it('acepta params vacíos', () => {
      trackEvent('landing_view');
      expect(window.dataLayer[0]).toMatchObject({ event: 'landing_view' });
    });
  });

  describe('markPerformance', () => {
    it('llama a performance.mark si existe', () => {
      const markSpy = vi.spyOn(performance, 'mark');
      markPerformance('landing-mount');
      expect(markSpy).toHaveBeenCalledWith('landing-mount');
      markSpy.mockRestore();
    });

    it('no-op si performance.mark tira', () => {
      const markSpy = vi.spyOn(performance, 'mark').mockImplementation(() => {
        throw new Error('boom');
      });
      // No debe propagar el error — el catch interno lo swallows.
      expect(() => markPerformance('bad-name')).not.toThrow();
      markSpy.mockRestore();
    });
  });

  describe('measurePerformance', () => {
    beforeEach(() => {
      performance.clearMarks();
      performance.clearMeasures();
    });

    it('emite performance.measure y pushea al dataLayer con duration_ms', () => {
      performance.mark('landing-mount');
      // Esperamos un tick para tener duración > 0
      const start = performance.now();
      while (performance.now() - start < 2) { /* busy wait 2ms */ }
      performance.mark('landing-content-ready');

      measurePerformance('landing-content-time', 'landing-mount', 'landing-content-ready');

      const evt = (window.dataLayer || []).find(e => e.event === 'landing_performance_measure');
      expect(evt).toBeTruthy();
      expect(evt.measure).toBe('landing-content-time');
      expect(evt.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('no revienta si las marks no existen', () => {
      // Sin mark previa performance.measure tira; el catch interno swallows.
      expect(() => measurePerformance('bad', 'no-existe')).not.toThrow();
    });
  });

  describe('reportLandingError', () => {
    it('llama silentReport con screen: landing preseteado', () => {
      const err = new Error('fetch pricing failed');
      reportLandingError(err, { section: 'pricing' });
      expect(silentReport).toHaveBeenCalledWith(err, {
        screen: 'landing',
        section: 'pricing',
      });
    });

    it('permite pisar screen si el caller lo necesita (extensibilidad)', () => {
      const err = new Error('x');
      reportLandingError(err, { screen: 'landing-embed', section: 'x' });
      expect(silentReport).toHaveBeenCalledWith(err, {
        screen: 'landing-embed',
        section: 'x',
      });
    });

    it('también pushea landing_error al dataLayer para redundancia', () => {
      reportLandingError(new Error('boom'), { section: 'trusted-companies' });
      const evt = (window.dataLayer || []).find(e => e.event === 'landing_error');
      expect(evt).toBeTruthy();
      expect(evt.section).toBe('trusted-companies');
      expect(evt.message).toBe('boom');
    });

    it('trunca mensajes largos a 200 chars (safety para dataLayer)', () => {
      const bigMsg = 'x'.repeat(500);
      reportLandingError(bigMsg, { section: 'x' });
      const evt = (window.dataLayer || []).find(e => e.event === 'landing_error');
      expect(evt.message.length).toBeLessThanOrEqual(200);
    });
  });
});
