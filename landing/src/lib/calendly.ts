/**
 * calendly.ts — helper para links de booking Calendly con UTM tracking.
 *
 * Port de `CALENDLY_BASE_URL` + `calendlyHref` en Landing.jsx.
 *
 * Si Lucas cambia el slug en Calendly, actualizar UNA constante acá — los N
 * CTAs de la landing apuntan a este helper.
 *
 * `source` va como `utm_campaign` → Calendly lo trackea nativo desde plan
 * Standard. En Free queda inerte pero no rompe.
 */

const CALENDLY_BASE_URL = 'https://calendly.com/hola-tecnyapp/30min';

export function calendlyHref(source: string): string {
  const params = new URLSearchParams({
    utm_source: 'landing',
    utm_medium: 'cta',
    utm_campaign: source,
  });
  return `${CALENDLY_BASE_URL}?${params.toString()}`;
}
