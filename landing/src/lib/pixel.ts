/**
 * pixel.ts — Meta Pixel client-side wrapper.
 *
 * Estrategia:
 *   1. `pixelInit(id)` instala el snippet oficial de Meta (Events Manager)
 *      en el <head> — carga el fbevents.js loader vía connect.facebook.net.
 *   2. `pixelTrack('EventName', params)` dispara eventos estándar Meta
 *      (Lead, Contact, Schedule, ViewContent, etc.).
 *   3. `pixelTrackCustom('CustomName', params)` para eventos custom.
 *   4. Cada evento genera un `event_id` UUID → cuando F4b (CAPI backend)
 *      esté listo, mismo event_id dispara server-side y Meta dedupea.
 *
 * SEGURIDAD: consent check está en el LLAMADOR (MetaPixel.astro), no acá.
 * Si `pixelInit()` se llama, se instala. El caller decide si consent OK.
 *
 * REFERENCIA:
 *   - Snippet oficial: https://developers.facebook.com/docs/meta-pixel/get-started
 *   - Event API: https://developers.facebook.com/docs/meta-pixel/reference
 *   - Standard events: https://developers.facebook.com/docs/meta-pixel/reference#standard-events
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    fbq?: any;
    _fbq?: any;
  }
}

/**
 * Instala el snippet oficial de Meta Pixel + init con el ID dado.
 * Idempotent — si ya está instalado (`window.fbq` existe), no hace nada.
 *
 * Snippet copiado LITERAL de Meta Events Manager (2026-07-29) para
 * mantener paridad con lo que Meta soporta oficialmente. Si Meta actualiza
 * el snippet, actualizar acá + agregar hash nuevo al CSP (F4b hardening).
 */
export function pixelInit(pixelId: string): void {
  if (typeof window === 'undefined' || window.fbq) return;

  // Snippet oficial de Meta — NO MODIFICAR salvo actualización de Meta.
  (function (f: any, b: any, e: any, v: any) {
    if (f.fbq) return;
    const n: any = (f.fbq = function () {
      // eslint-disable-next-line prefer-rest-params
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    });
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = '2.0';
    n.queue = [];
    const t = b.createElement(e);
    t.async = true;
    t.src = v;
    const s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  window.fbq('init', pixelId);
}

/**
 * Dispara un evento estándar de Meta (PageView, Lead, Contact, Schedule,
 * ViewContent, CompleteRegistration, etc.).
 *
 * ── DUAL DISPATCH (F4-C) ──────────────────────────────────────────
 * Cada llamada dispara SIMULTÁNEAMENTE:
 *   1. Pixel client-side (fbq) — el snippet Meta ya instalado.
 *   2. CAPI backend (POST /api/public/pixel-capi) — server-side.
 * Ambos con el MISMO event_id → Meta dedupea automáticamente.
 *
 * Beneficio del CAPI: recupera ~30% de eventos que el Pixel client pierde
 * por iOS 14 ATT, adblockers, y timeouts de navegación.
 *
 * Fire-and-forget: el fetch al CAPI backend NO se espera (no bloquea UI).
 * Si el backend falla, el Pixel client-side sigue funcionando — mismo
 * comportamiento que sin CAPI.
 */
export function pixelTrack(
  eventName: string,
  params: Record<string, string | number | boolean | null | undefined> = {}
): string {
  const eventID = generateEventId();
  if (typeof window === 'undefined') return eventID;

  // 1. Pixel client-side (si está instalado)
  if (window.fbq) {
    window.fbq('track', eventName, params, { eventID });
  }

  // 2. CAPI backend — fire and forget
  sendToCapi(eventName, eventID, params);

  return eventID;
}

/**
 * Dispara un evento CUSTOM (no estándar). Meta no valida el nombre —
 * lo trackea como custom event en Events Manager.
 *
 * NO envía a CAPI: la whitelist del endpoint backend solo acepta Standard
 * events (Lead, Schedule, Contact, ViewContent, PageView, CompleteRegistration).
 * Custom events (CTAClick con location/target) no aportan a conversion
 * optimization — quedan solo client-side para debugging.
 */
export function pixelTrackCustom(
  eventName: string,
  params: Record<string, string | number | boolean | null | undefined> = {}
): string {
  const eventID = generateEventId();
  if (typeof window === 'undefined' || !window.fbq) return eventID;
  window.fbq('trackCustom', eventName, params, { eventID });
  return eventID;
}

// ── CAPI dispatch helpers ───────────────────────────────────────────────

// URL del backend Tecny — leída al primer uso (lazy init) porque
// import.meta.env se resuelve al build.
let CAPI_ENDPOINT: string | null = null;
function getCapiEndpoint(): string {
  if (CAPI_ENDPOINT === null) {
    const base = (import.meta.env.PUBLIC_API_URL || 'https://tecny-backend-production.up.railway.app').replace(/\/+$/, '');
    CAPI_ENDPOINT = `${base}/api/public/pixel-capi`;
  }
  return CAPI_ENDPOINT;
}

/**
 * Fire-and-forget POST al backend CAPI. Nunca bloquea, nunca throwea.
 *
 * fbp/fbc cookies: si el Pixel client las setea (después del init), las
 * leemos y forwardeamos — mejora el matching en Meta ADS Manager. Si el
 * user tiene adblock que bloquea las cookies, van vacíos y no rompe nada.
 */
function sendToCapi(
  eventName: string,
  eventId: string,
  params: Record<string, string | number | boolean | null | undefined>
): void {
  try {
    const fbp = readCookie('_fbp');
    const fbc = readCookie('_fbc');
    const payload = {
      event_name: eventName,
      event_id: eventId,
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: window.location.href,
      custom_data: params,
      ...(fbp ? { fbp } : {}),
      ...(fbc ? { fbc } : {}),
    };

    // AbortController con timeout 5s — evita fetch colgados que ocupen
    // conexiones si el backend está lento. En navegaciones rápidas
    // (user cierra el tab), el browser aborta igualmente.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    // keepalive: true → el request sigue vivo aunque el user navegue
    // fuera de la página antes de que responda. Crítico para Lead events
    // que disparan justo antes del redirect a /signup.
    fetch(getCapiEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      keepalive: true,
    })
      .catch(() => {
        /* silent-fail — el Pixel client-side ya se disparó, CAPI es best-effort */
      })
      .finally(() => clearTimeout(timer));
  } catch {
    /* silent-fail — nunca queremos que tracking rompa la landing */
  }
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * UUID v4 short — 22 chars vs 36 del UUID canónico. Suficiente para dedup
 * (probabilidad de colisión en 1M events/día ~= 10^-12).
 * Usamos `crypto.randomUUID()` cuando existe; fallback manual para browsers
 * viejos (Safari <15.4 no lo tenía).
 */
function generateEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback simple — no cryptographically secure pero suficiente para
  // dedup (Meta solo compara strings).
  return 'evt_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
