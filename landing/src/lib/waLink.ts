/**
 * waLink.ts — helper para construir links wa.me.
 *
 * Port de `buildWaLink` en `frontend/src/screens/Landing.jsx`. Normaliza el
 * número stripeando cualquier cosa que no sea dígito (por si el admin editó
 * con espacios, +, o guiones por accidente).
 */

const FALLBACK_WHATSAPP = '5491126165007';

export function buildWaLink(whatsapp: string | null | undefined, message: string): string {
  const digits = (whatsapp || FALLBACK_WHATSAPP).replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
