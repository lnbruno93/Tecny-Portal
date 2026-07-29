/**
 * consent.ts — gestión de consent para tracking (Meta Pixel, GA4, etc.).
 *
 * Modelo LEGÍTIMO INTERÉS (Ley 25.326 AR + LGPD BR):
 *   - Tracking analítico + ads carga POR DEFAULT (asumimos opt-in implícito).
 *   - Banner discreto informa + link a política de privacidad.
 *   - Usuario puede opt-out explícito → localStorage guarda decisión.
 *   - Si opt-out, ni Pixel ni GA4 se instalan en siguientes visitas.
 *
 * Alternativa NO adoptada: GDPR-strict con opt-in explícito. Descartada
 * porque:
 *   1. Target AR/UY/LATAM — GDPR no aplica jurisdiccionalmente.
 *   2. Requiere consentimiento antes de cargar Pixel → CTR ads baja ~30%.
 *   3. UX intrusiva (modal blockeante) para nichos no-EU.
 *
 * Si a futuro operamos en EU: agregar geo-detection (Accept-Language +
 * Cloudflare geo header) y switch a modo GDPR-strict solo para esos users.
 */

const CONSENT_KEY = 'tecny_consent';
const CONSENT_SEEN_KEY = 'tecny_consent_seen';

/**
 * ¿El usuario permitió tracking? True por default (legítimo interés).
 * Solo devuelve false si el usuario opt-out explícito en el banner.
 */
export function isTrackingAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(CONSENT_KEY) !== 'rejected';
  } catch {
    // localStorage puede tirar en incognito con quota exceeded o safari
    // strict — fallback conservador: asumimos allowed (mismo default).
    return true;
  }
}

/**
 * Usuario opt-out explícito del tracking. Persistido en localStorage.
 * NO recarga la página — el caller decide si reload (para desactivar el
 * Pixel ya cargado en la sesión actual).
 */
export function optOut(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CONSENT_KEY, 'rejected');
  } catch {
    /* noop — quota exceeded */
  }
}

/**
 * Usuario re-opt-in (después de haber opt-out anteriormente). Borra la key.
 */
export function optIn(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* noop */
  }
}

/**
 * ¿El usuario ya vio el banner alguna vez? Si sí, no lo mostramos otra vez.
 * Marker independiente del consent decision — usuario puede ver banner,
 * clickear "Entendido" (marca seen=1 sin opt-out) y seguir con tracking.
 */
export function hasSeenBanner(): boolean {
  if (typeof window === 'undefined') return true; // SSR: no mostrar
  try {
    return localStorage.getItem(CONSENT_SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

export function markBannerSeen(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CONSENT_SEEN_KEY, '1');
  } catch {
    /* noop */
  }
}
