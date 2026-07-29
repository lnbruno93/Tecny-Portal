/**
 * analytics.ts — helpers de observabilidad de la landing (Astro).
 *
 * Port directo del pattern de `frontend/src/screens/Landing.analytics.js`.
 * Estrategia: provider-agnóstico via `window.dataLayer` (patrón GTM/GA4).
 *
 * Cuando la Fase 4 instale Meta Pixel + GA4, este dataLayer es la fuente
 * de verdad — Pixel/GA4/etc. consumen los eventos aquí pusheados. Los
 * nombres son ESTABLES (`landing_view`, `cta_click`, etc.) — cambiarlos
 * rompe el mapping en Meta Events Manager.
 *
 * Diferencia con la versión SPA:
 *   - No usamos silentReport → Sentry (todavía). En F4 se conecta a Sentry
 *     via el backend endpoint /api/csp-report o instalando el SDK.
 *   - No import.meta.env.DEV — en Astro es `import.meta.env.DEV` igual, pero
 *     este file corre en el browser (via <script>), donde Astro reemplaza
 *     el valor al build.
 */

// SSR-safe: durante el prerender de Astro, `window` no existe. Todos los
// helpers son no-op silencioso en ese contexto — nada crashea, nada trackea
// (correcto: pre-render no es un usuario).
const hasWindow = (): boolean => typeof window !== 'undefined';

type AnalyticsParams = Record<string, string | number | boolean | null | undefined>;

/**
 * Push a `window.dataLayer` (GTM/GA4 pattern). Idempotent: crea el array
 * si no existe. Si nada lo consume, los eventos quedan en memoria — cero costo.
 *
 * En DEV loguea a console para debugging (Vite/Astro reemplaza
 * `import.meta.env.DEV` al build).
 */
export function trackEvent(eventName: string, params: AnalyticsParams = {}): void {
  const payload = { event: eventName, ...params, ts: Date.now() };
  if (hasWindow()) {
    // @ts-expect-error — dataLayer es un contract externo, no está en window types.
    window.dataLayer = window.dataLayer || [];
    // @ts-expect-error — misma razón.
    window.dataLayer.push(payload);
  }
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log('[landing:event]', eventName, params);
  }
}

/**
 * performance.mark seguro. Usada para RUM custom (ej. "landing-content-ready").
 */
export function markPerformance(name: string): void {
  if (hasWindow() && typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      performance.mark(name);
    } catch {
      /* noop — algunos browsers viejos tiran si el nombre choca */
    }
  }
}

/**
 * performance.measure seguro + emit al dataLayer como `landing_performance_measure`.
 */
export function measurePerformance(measureName: string, startMark: string, endMark?: string): void {
  if (!hasWindow() || typeof performance === 'undefined' || typeof performance.measure !== 'function') {
    return;
  }
  try {
    const measure = endMark
      ? performance.measure(measureName, startMark, endMark)
      : performance.measure(measureName, startMark);
    const duration =
      measure?.duration ??
      performance.getEntriesByName(measureName).at(-1)?.duration ??
      0;
    trackEvent('landing_performance_measure', {
      measure: measureName,
      duration_ms: Math.round(duration),
    });
  } catch {
    /* noop — measure requiere marks existentes */
  }
}

/**
 * Reporta un error de la landing. En Fase 2 solo va al dataLayer (sin Sentry).
 * En Fase 4 se conecta a un backend endpoint para forward a Sentry.
 *
 * Filtra AbortError: son esperados en HMR / navegación / unmount. Reportarlos
 * ensucia sin señal — mismo criterio que la versión SPA.
 */
export function reportLandingError(error: unknown, context: AnalyticsParams = {}): void {
  const rawMsg = error instanceof Error ? error.message : String(error);
  if (/AbortError|signal is aborted|The operation was aborted/i.test(rawMsg)) {
    return;
  }
  trackEvent('landing_error', {
    message: String(rawMsg).slice(0, 200),
    section: (context.section as string) || 'unknown',
  });
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.error('[landing:error]', error, context);
  }
}
