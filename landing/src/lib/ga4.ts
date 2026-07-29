/**
 * ga4.ts — Google Analytics 4 client-side wrapper.
 *
 * Complementa Meta Pixel (analytics propio, independiente de Meta ADS
 * platform). Consume el mismo dataLayer que Meta — mismo mapping de eventos.
 *
 * Standard events mapeados (mismos que Pixel):
 *   - page_view (auto por gtag config)
 *   - generate_lead (equivalente a Meta Lead)
 *   - schedule (equivalente a Meta Schedule)
 *   - contact (equivalente a Meta Contact)
 *   - view_content (equivalente a Meta ViewContent — para retargeting audiences)
 *
 * REFERENCIA:
 *   - Setup: https://developers.google.com/tag-platform/gtagjs/install
 *   - Events: https://developers.google.com/analytics/devguides/collection/ga4/reference/events
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    gtag?: (...args: any[]) => void;
    dataLayer?: any[];
  }
}

/**
 * Instala el snippet gtag oficial + config con el measurement ID dado.
 * Idempotent — si ya está instalado (`window.gtag` existe), no hace nada.
 *
 * Snippet oficial de Google:
 *   https://developers.google.com/tag-platform/gtagjs/install#add-your-tag
 */
export function ga4Init(measurementId: string): void {
  if (typeof window === 'undefined' || window.gtag) return;

  // Cargar el gtag loader async
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.appendChild(script);

  // Inicializar dataLayer + gtag (GA4 reusa el mismo window.dataLayer que
  // ya inicializamos en BaseLayout — así compartimos con Meta Pixel).
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag('js', new Date());
  window.gtag('config', measurementId, {
    // send_page_view: true es el default. Explicit para claridad.
    send_page_view: true,
  });
}

/**
 * Dispara un evento GA4. `name` puede ser Standard (Google lo reconoce y
 * enriquece reports) o Custom.
 *
 * Standard events comunes:
 *   - `generate_lead`     — lead capture (equiv. Meta Lead)
 *   - `schedule`          — appointment booking
 *   - `contact`           — contact interaction
 *   - `view_item`         — viewed content (retargeting)
 *   - `sign_up`           — signup completado (en el portal, no en la landing)
 *
 * Ver full list: https://developers.google.com/analytics/devguides/collection/ga4/reference/events
 */
export function ga4Track(eventName: string, params: Record<string, any> = {}): void {
  if (typeof window === 'undefined' || !window.gtag) return;
  window.gtag('event', eventName, params);
}
