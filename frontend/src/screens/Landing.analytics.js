/**
 * Landing.analytics.js — helpers de observabilidad para la landing pública.
 *
 * Sprint 1 H3 del roadmap post-auditoría (docs/AUDIT_LANDING_2026-07-19.md).
 *
 * Objetivo: capturar eventos de la landing SIN acoplar al vendor específico
 * de analytics. La estrategia es "provider-agnóstico via `window.dataLayer`":
 *   - Un tag manager (GTM, GA4, PostHog, Plausible con proxy) que se instale
 *     mañana consume el dataLayer que ya está pusheando eventos con nombres
 *     estables.
 *   - Sin depender de que alguna herramienta esté cargada: si nada consume el
 *     dataLayer, los eventos quedan en memoria como array plano — cero costo.
 *
 * Y para errores usamos el helper existente `silentReport` (backend Sentry),
 * evitando meter el SDK de @sentry/react al bundle (~30kb gz).
 *
 * Nomenclatura de eventos (mantener estable — un tag manager futuro depende):
 *   - `landing_view`        — 1 vez, al montar Landing.
 *   - `landing_content_ready` — cuando los 3 fetches del CMS resolvieron.
 *   - `landing_fetch_error` — cualquier fetch del CMS que falla.
 *   - `cta_click`           — click en cualquier CTA (nav, hero, pricing, ...).
 *   - `logo_load_failed`    — <img> del carrusel Empresas que emite `onerror`.
 *
 * Los `params` de cada evento son planos (strings/numbers/bools) para maximizar
 * compatibilidad con destinos analytics. Sin objetos anidados.
 */

import { silentReport } from '../lib/reportError';

// Ventanas viejas o SSR: `window` puede no existir. Todos los helpers son
// safe si eso pasa — no-op silencioso.
const hasWindow = () => typeof window !== 'undefined';

/**
 * Push a `window.dataLayer` (patrón GTM/GA4). Si nada lo consume, queda en
 * memoria como array — cero costo real. Un futuro `<script>` de GTM/etc. lo
 * lee y envía a donde configuremos. Idempotent: crea el array si no existe.
 *
 * En DEV loguea a console para debugging.
 *
 * @param {string} eventName - Nombre estable del evento (ver nomenclatura arriba).
 * @param {object} [params={}] - Params planos (string/number/bool).
 */
export function trackEvent(eventName, params = {}) {
  const payload = { event: eventName, ...params, ts: Date.now() };
  if (hasWindow()) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);
  }
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log('[landing:event]', eventName, params);
  }
}

/**
 * `performance.mark` seguro. Algunos navegadores viejos no lo tienen; wrap
 * en try/catch para no romper la landing por analytics no crítico.
 *
 * Las marks quedan visibles en DevTools > Performance panel y son consumibles
 * desde web-vitals u otros libs que ya se conecten al `window.dataLayer`
 * pusheando el LCP/FID/CLS. Este helper es para marcas de negocio (ej.
 * "landing-ready") que complementan las Web Vitals estándar.
 *
 * @param {string} name - Nombre único de la mark (ej. 'landing-fetch-start').
 */
export function markPerformance(name) {
  if (hasWindow() && typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      performance.mark(name);
    } catch {
      // Ignorar — algunos browsers viejos tiran si el nombre choca.
    }
  }
}

/**
 * `performance.measure` seguro entre dos marks. Emite el resultado también
 * como evento del dataLayer para que el tag manager futuro pueda enviarlo a
 * un backend de RUM.
 *
 * @param {string} measureName - Nombre del measure resultante.
 * @param {string} startMark   - Nombre de la mark de inicio.
 * @param {string} [endMark]   - Nombre de la mark de fin. Si no viene, usa "now".
 */
export function measurePerformance(measureName, startMark, endMark) {
  if (!hasWindow() || typeof performance === 'undefined' || typeof performance.measure !== 'function') {
    return;
  }
  try {
    const measure = endMark
      ? performance.measure(measureName, startMark, endMark)
      : performance.measure(measureName, startMark);
    // Algunos browsers devuelven undefined en performance.measure() — sacamos
    // el duration del último entry con getEntriesByName.
    const duration = measure?.duration
      ?? performance.getEntriesByName(measureName).at(-1)?.duration
      ?? 0;
    trackEvent('landing_performance_measure', {
      measure: measureName,
      duration_ms: Math.round(duration),
    });
  } catch {
    // Ignorar — measure requiere que las marks existan; si no, seguimos.
  }
}

/**
 * Reporta un error de la landing al backend (que lo enruta a Sentry) con el
 * context `screen: 'landing'` preseteado + el pattern de context custom.
 *
 * También pushea el evento al dataLayer con nombre estable `landing_error`
 * para que analytics vea el error aunque el backend Sentry esté caído.
 *
 * @param {Error|string} error - El error a reportar.
 * @param {object} [context={}] - Metadata extra (section, url, etc.).
 */
export function reportLandingError(error, context = {}) {
  silentReport(error, { screen: 'landing', ...context });
  // El mensaje viaja al dataLayer + a un potencial destino de analytics —
  // capamos a 200 chars por si un stacktrace largo se cuela en error.message.
  const rawMsg = error?.message || String(error);
  trackEvent('landing_error', {
    message: String(rawMsg).slice(0, 200),
    section: context.section || 'unknown',
  });
}
