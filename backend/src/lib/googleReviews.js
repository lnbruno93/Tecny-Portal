/**
 * googleReviews — fetch de reseñas de Google Business Profile via Places API (New).
 *
 * 2026-07-13 (CMS Landing Fase 2 extendida): la landing tecnyapp.com muestra
 * reseñas reales del listing de Google ("Tecny App", place_id
 * ChIJt32vtDn5sCoRmCjEY6g98SU) además de las reseñas manuales que Lucas
 * carga en la CMS Fase 2. Objetivo: leverage social proof orgánico.
 *
 * Diseño:
 *   · Cache in-memory con TTL 6hs. Places API (New) devuelve max 5 reseñas
 *     por place_id, y refrescar cada 6hs cubre el ciclo típico de reseñas
 *     nuevas (los clientes escriben después de una interacción, la cadencia
 *     es baja). 4 llamadas/día × 30 días = 120 llamadas/mes → dentro del
 *     free tier de $200/mes de Maps Platform (~$3/mes al precio de Place
 *     Details con reviews SKU).
 *   · Fail-open: si la API de Google explota, devolvemos `{ reviews: [] }`.
 *     La landing tiene su propio fallback a las reseñas manuales de la
 *     CMS Fase 2 (y ésas tienen su propio fallback a hardcoded).
 *   · Cache es lazy (no timer): la primera request refresca, subsiguientes
 *     dentro del TTL leen del cache. Sin timer evitamos wake-ups en idle
 *     y no gastamos cuota si nadie visita la landing.
 *   · Normalización: shape uniforme con SiteTestimonial (CMS Fase 2). El
 *     frontend puede renderizar Google y manual con el mismo componente.
 *
 * Config por env:
 *   · GOOGLE_PLACES_API_KEY   — key con Places API (New) habilitada.
 *   · GOOGLE_PLACES_PLACE_ID  — Place ID del negocio (ChIJ...).
 *   · GOOGLE_REVIEWS_CACHE_TTL_MS (opt) — TTL del cache, default 6h.
 *
 * Si alguna env var falta, el módulo devuelve empty siempre (no lanza) —
 * comportamiento explícito para que en dev sin config todo siga andando.
 *
 * Threshold "mostrar o no":
 *   Este módulo NO decide si mostrar/ocultar por count. Devuelve todas las
 *   reseñas + metadata (rating, count agregado). La landing decide con su
 *   propio threshold — cf. iPro-Website/src/hooks/use-google-reviews.ts.
 */

const logger = require('./logger');

const PLACES_API_URL = 'https://places.googleapis.com/v1/places';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const NETWORK_TIMEOUT_MS = 8000; // 8s (Places API típicamente responde <500ms)
const LANGUAGE_CODE = 'es';

// Palette derivada de los colores por defecto de la CMS Fase 2. Se asigna al
// author de la reseña de Google (que no viene con color) determinísticamente
// por hash del nombre — misma persona siempre mismo color entre renders.
const AVATAR_COLORS = [
  '#4285F4', '#EA4335', '#FBBC04', '#34A853',
  '#673AB7', '#00ACC1', '#F4511E', '#8E24AA',
];

// Estado del cache en memoria (por proceso).
let _cache = null;
let _cachedAt = 0;

function cacheTtlMs() {
  return Number(process.env.GOOGLE_REVIEWS_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS;
}

/**
 * Deriva un color hex determinístico desde el nombre del author.
 * Mismo nombre → mismo color siempre (hash estable). Distintos authors
 * distribuidos uniformemente entre las 8 opciones de la palette.
 */
function nameToColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0; // fuerza int32
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/**
 * Deriva la inicial (1-2 chars) del nombre del author.
 * "Tomás R." → "T"
 * "María F." → "M"
 * "Anónimo" → "A"
 */
function nameToInitial(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return '?';
  return trimmed[0].toUpperCase();
}

/**
 * Normaliza una review de Google Places API al shape `SiteTestimonial`
 * (mismo shape que la CMS Fase 2). Agrega campos extras específicos de
 * Google (`rating`, `source`, `photo_url`) que la CMS no tiene.
 *
 * Google response shape (Places API New v1):
 *   {
 *     name: "places/PLACE_ID/reviews/REVIEW_ID",
 *     relativePublishTimeDescription: "hace 3 días",
 *     rating: 5,
 *     text: { text: "...", languageCode: "es" },
 *     originalText: { text: "...", languageCode: "en" },
 *     authorAttribution: { displayName, uri, photoUri },
 *     publishTime: "2026-07-10T12:00:00Z"
 *   }
 *
 * Preferimos `text.text` (traducido por Google a `es` porque pedimos
 * `languageCode=es`). Si el idioma original ya era `es`, `text` viene con el
 * texto original sin traducción. En cualquier caso, `text.text` es lo
 * correcto para mostrar en la landing.
 */
function normalizeGoogleReview(gReview) {
  const author = gReview.authorAttribution || {};
  const displayName = author.displayName || 'Anónimo';
  const reviewId = (gReview.name || '').split('/').pop() || '';

  return {
    // Prefijo `google:` para no colisionar con UUIDs de la CMS manual.
    // Facilita también detectar la fuente en el frontend sin mirar `source`.
    id:               `google:${reviewId}`,
    name:             displayName,
    initial:          nameToInitial(displayName),
    color:            nameToColor(displayName),
    time:             gReview.relativePublishTimeDescription || '',
    text:             gReview.text?.text || gReview.originalText?.text || '',
    // Extras específicos de Google:
    rating:           typeof gReview.rating === 'number' ? gReview.rating : null,
    source:           'google',
    photo_url:        author.photoUri || null,
    // Link al perfil del reviewer en Maps — útil si en el futuro querés
    // linkear "leer reseña original" desde la landing.
    author_url:       author.uri || null,
  };
}

/**
 * Devuelve `true` si el cache está vigente (dentro del TTL).
 */
function isCacheFresh() {
  if (!_cache) return false;
  return (Date.now() - _cachedAt) < cacheTtlMs();
}

/**
 * Snapshot del estado actual del cache. Útil para tests o debug.
 * NO exportar para uso en runtime — usar getReviews() que refresca si stale.
 */
function _getCacheSnapshot() {
  return { cache: _cache, cachedAt: _cachedAt };
}

/**
 * Force-invalida el cache. Útil para tests. En runtime, no debería
 * llamarse — el TTL hace el trabajo.
 */
function _clearCache() {
  _cache = null;
  _cachedAt = 0;
}

/**
 * Fetch fresh desde la API de Google. No usar directamente — usar
 * getReviews() que decide cache vs fetch.
 *
 * @returns {Promise<object>} { reviews: [], rating, count } o { reviews: [], error } si falla
 */
async function fetchFromGoogle() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACES_PLACE_ID;

  if (!apiKey || !placeId) {
    // Config missing → devolvemos empty explícito. No es error — es "feature
    // desactivada". Sin log noise porque este estado es esperado en dev sin config.
    return { reviews: [], rating: null, count: 0, source: 'google', configured: false };
  }

  const url = `${PLACES_API_URL}/${encodeURIComponent(placeId)}?languageCode=${LANGUAGE_CODE}`;
  const fieldMask = 'id,displayName,rating,userRatingCount,reviews';

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
      },
      signal: ctrl.signal,
    });
  } catch (err) {
    logger.warn({ err: err.message }, '[googleReviews] network error al llamar Places API — fail-open');
    return { reviews: [], rating: null, count: 0, source: 'google', error: 'network_error', configured: true };
  } finally {
    clearTimeout(t);
  }

  if (!response.ok) {
    // Log 4xx/5xx pero no explota — el frontend usa el fallback manual.
    let bodyPreview;
    try { bodyPreview = (await response.text()).slice(0, 200); } catch { /* noop */ }
    logger.warn(
      { status: response.status, body: bodyPreview },
      '[googleReviews] HTTP no-2xx de Places API — fail-open'
    );
    return { reviews: [], rating: null, count: 0, source: 'google', error: 'http_error', configured: true };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    logger.warn({ err: err.message }, '[googleReviews] response no es JSON válido — fail-open');
    return { reviews: [], rating: null, count: 0, source: 'google', error: 'parse_error', configured: true };
  }

  const rawReviews = Array.isArray(data.reviews) ? data.reviews : [];
  const normalized = rawReviews
    .map(normalizeGoogleReview)
    // Skip reviews sin texto — Google a veces devuelve "star-only" ratings sin
    // texto, y esos no aportan a la landing (queremos testimonios legibles).
    .filter(r => r.text && r.text.trim().length > 0);

  return {
    reviews: normalized,
    rating: typeof data.rating === 'number' ? data.rating : null,
    count: typeof data.userRatingCount === 'number' ? data.userRatingCount : 0,
    source: 'google',
    configured: true,
  };
}

/**
 * API pública del módulo. Devuelve reseñas de Google (desde cache si vigente,
 * o refresca contra la API si stale/cold).
 *
 * SIEMPRE resuelve (nunca throws). En caso de error, devuelve estructura
 * válida con `reviews: []` para que el caller pueda tratarlo uniforme.
 *
 * @returns {Promise<{reviews: Array, rating: number|null, count: number, source: 'google', cachedAt: string, configured: boolean, error?: string}>}
 */
async function getReviews() {
  if (isCacheFresh()) {
    return { ..._cache, cachedAt: new Date(_cachedAt).toISOString() };
  }
  const fresh = await fetchFromGoogle();
  _cache = fresh;
  _cachedAt = Date.now();
  return { ...fresh, cachedAt: new Date(_cachedAt).toISOString() };
}

module.exports = {
  getReviews,
  // Exports internos para tests. NO usar en runtime.
  _internal: {
    normalizeGoogleReview,
    nameToColor,
    nameToInitial,
    isCacheFresh,
    _getCacheSnapshot,
    _clearCache,
    fetchFromGoogle,
  },
};
