// Filtro de ruido para /api/client-errors — espejado del frontend.
//
// Contexto (2026-07-07): el PR #517 agregó `_result.default` al
// NOISE_PATTERNS del **frontend** (`frontend/src/lib/reportError.js`)
// para que el cliente no reporte al backend errores de chunk-load Safari.
// Pero el fix era INCOMPLETO — el endpoint POST /api/client-errors del
// backend seguía haciendo `Sentry.captureMessage(message)` sobre cualquier
// mensaje que le llegara, sin filtrar.
//
// Resultado: TECNY-PORTAL-BACKEND-4 (con message "undefined is not an
// object (evaluating 'e._result.default')") volvió como regresión el
// 2026-07-07 02:43 UTC porque:
//   - Users con bundle viejo cacheado (localStorage/service worker) NO
//     tenían el NOISE_PATTERNS actualizado del PR #517.
//   - Esos users seguían reportando al backend.
//   - El backend seguía enviándolo a Sentry.
//
// Fix: espejar acá exactamente los patterns del frontend, con el mismo
// helper `isNoise(msg)`. Si el `message` que reporta el cliente matchea
// alguno → NO llamamos `Sentry.captureMessage`. Aún logueamos con
// `logger.warn` (útil para debugging local) pero no ensuciamos Sentry.
//
// Mantener sincronizado con `frontend/src/lib/reportError.js#NOISE_PATTERNS`.
// Cualquier pattern agregado allá debe agregarse acá también (y viceversa).
// Si algún día divergen, este backend es la "segunda línea de defensa" —
// aunque el frontend falle en filtrar (bundle viejo), el backend contiene.

const NOISE_PATTERNS = [
  /Sin conexi[óo]n con el servidor/i,           // api.js fetch network failure
  /La solicitud tard[óo] demasiado/i,           // api.js AbortError (timeout)
  /^NO_AUTH$/,                                  // api.js 401 (sesión expirada)
  /No ten[ée]s permiso/i,                       // api.js 403
  /Failed to fetch/i,                           // browser network failure genérico
  /NetworkError when attempting to fetch/i,     // Firefox
  /Load failed/i,                               // Safari
  /Network request failed/i,                    // misc
  /The operation was aborted/i,                 // user navegó/cerró (Firefox)
  /AbortError/i,                                // user navegó/cerró (Chrome clásico / Node)
  // 2026-07-25 Sentry TECNY-PORTAL-BACKEND-19: Safari + Chrome moderno usan
  // el mensaje "Fetch is aborted" (variante "was aborted" existe también).
  // Los patterns AbortError/The operation was aborted NO matchean estas
  // variantes → falso positivo TECNY-PORTAL-BACKEND-19 en Sentry.
  /[Ff]etch (is|was) aborted/,                  // Safari / Chrome moderno / WebKit iOS
  // Chunk load failures (ampliación 2026-07-06/07).
  /valid JavaScript MIME type/i,                // chunk devolvió HTML (index) en vez de JS
  /dynamically imported module/i,               // browser genérico
  /Importing a module script failed/i,          // Safari
  /Loading chunk\s+\S+\s+failed/i,              // Webpack legacy
  /Failed to fetch dynamically imported/i,      // Chrome/Firefox
  /Cannot read properties of undefined \(reading 'default'\)/i, // Chrome — mod undefined
  /_result\.default/i,                          // Safari — mod undefined (TECNY-PORTAL-BACKEND-4)
  /Dynamic import resolved to invalid module/i, // guard sintético de lazyWithRetry
];

function isClientErrorNoise(message) {
  if (!message) return false;
  const msg = String(message);
  return NOISE_PATTERNS.some((p) => p.test(msg));
}

// 2026-07-27 (Sentry hotfix post Sprint 4): filtro por user-agent para
// crawlers y bots. Los bots (AhrefsBot, GoogleBot, BingBot, etc.) no
// renderean el DOM completo — muchos disparan `img.onError` sobre
// `<img loading="lazy">` porque no ejecutan el intersection observer.
// La Landing tiene `onError` handlers legítimos para logos del carrusel
// TrustedCompanies + otros assets: cuando un bot los "fallea", el
// frontend reporta a /api/client-errors con `message:
// 'trusted_company_logo_failed'` (u otros genéricos). Sentry recibe
// ruido de bots que ningún user real vio.
//
// Regex insensitive a case, cubre los crawlers más comunes:
//   - AhrefsBot (SEO)         - GoogleBot                - BingBot
//   - YandexBot               - DuckDuckBot              - facebookexternalhit
//   - LinkedInBot             - TwitterBot               - Slackbot
//   - Semrush/DotBot/MJ12Bot  - AmazonBot                - PetalBot
//   - Applebot/Baiduspider    - genérico *bot* al final del UA
//
// NO filtramos por "spider" o "crawler" en general porque hay UAs
// legítimos que contienen esas palabras (ej. testing frameworks). El
// pattern es explícito por nombre.
const BOT_UA_PATTERNS = [
  /AhrefsBot/i,
  /GoogleBot/i,
  /BingBot/i,
  /YandexBot/i,
  /DuckDuckBot/i,
  /facebookexternalhit/i,
  /LinkedInBot/i,
  /TwitterBot/i,
  /Slackbot/i,
  /Semrush/i,
  /DotBot/i,
  /MJ12Bot/i,
  /AmazonBot/i,
  /PetalBot/i,
  /Applebot/i,
  /Baiduspider/i,
];

function isBotUserAgent(ua) {
  if (!ua) return false;
  const s = String(ua);
  return BOT_UA_PATTERNS.some((p) => p.test(s));
}

module.exports = { isClientErrorNoise, isBotUserAgent, NOISE_PATTERNS, BOT_UA_PATTERNS };
