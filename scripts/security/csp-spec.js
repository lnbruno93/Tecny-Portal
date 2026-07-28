/**
 * scripts/security/csp-spec.js — spec canónica de Content-Security-Policy.
 *
 * Sprint 3 L1 del roadmap post-auditoría (docs/AUDIT_LANDING_2026-07-19.md).
 *
 * ── Contexto del problema ─────────────────────────────────────────────
 *
 * Tenemos DOS netlify.toml (portal + admin) con CSPs casi idénticos que
 * se duplican en 3 contextos cada uno (production, branch-deploy,
 * deploy-preview) = 6 headers CSP para mantener alineados a mano.
 *
 * Netlify NO soporta imports/macros en TOML — cada block es autónomo. Un
 * cambio en directivas hCaptcha, backend URL o similar tiene que
 * replicarse en 6 lugares o rompe. El 2026-07-19 esto rompió en prod:
 *
 *   > Root netlify.toml:  img-src ... blob: https://tecny-backend-...
 *   > Admin netlify.toml: img-src 'self' data:                       ← faltaba backend URL
 *
 *   Consecuencia: en admin.tecnyapp.com los logos del carrusel Empresas
 *   (que servía el backend) dieron 4x un `?` roto. Bug detectado con
 *   ojos, no con CI. Ver PRs #666-#671 (fixes retroactivos).
 *
 * ── Diseño del fix ────────────────────────────────────────────────────
 *
 * Este archivo define UNA fuente de verdad para las directivas comunes.
 * `scripts/security/verify-csp-parity.js` parsea ambos netlify.toml y
 * asserta que cada CSP declarado matchee lo que la spec dice.
 *
 * Un PR que cambie CSP en un solo netlify.toml sin actualizar el otro
 * (o sin actualizar esta spec) FALLA CI. Escalabilidad garantizada por
 * detección temprana, no por generación (que rompe el flow deploy Netlify).
 *
 * Las diferencias legítimas por site (root vs admin) están declaradas en
 * `siteDifferences` — cualquier otra divergencia es un bug.
 */

// ── Backend URLs por contexto ─────────────────────────────────────────
// Sprint 1 audit 07-25 · Fix 10 (Track D P1-2): antes production incluía
// ambas URLs (prod + staging) en `connect-src` e `img-src`. Un XSS injectado
// en prod podía usar staging como canal de exfiltración/data-loading si el
// atacante controlaba también staging. Ahora cada contexto habilita
// SOLO su backend correspondiente. `deploy-preview` mantiene ambas porque
// los previews de PRs a veces necesitan point a prod backend para
// smoke-testing (config común en el codebase).
const BACKEND_URLS_BY_CONTEXT = Object.freeze({
  production:       ['https://tecny-backend-production.up.railway.app'],
  'branch-deploy':  ['https://tecny-backend-staging.up.railway.app'],
  // Deploy-preview: orden production-primero (matchea el orden histórico
  // en netlify.toml — el parity check es order-sensitive porque el header
  // CSP también es order-sensitive del punto de vista del browser).
  'deploy-preview': ['https://tecny-backend-production.up.railway.app', 'https://tecny-backend-staging.up.railway.app'],
});

// ── Directivas COMUNES a los 2 sites y a los 3 contextos ──────────────
// Cualquier cambio acá debe reflejarse en LOS 6 blocks (2 files × 3 contextos).
// El script verify-csp-parity.js asserta que sea así.
//
// NOTA (Sprint 1 audit 07-25 · Fix 10): `connect-src` e `img-src` ahora
// dependen del contexto (via BACKEND_URLS_BY_CONTEXT) — se componen en
// `expectedCspFor(site, context)`. El resto sigue siendo idéntico entre
// contextos.
const COMMON_DIRECTIVES = Object.freeze({
  'default-src': ["'self'"],

  // hCaptcha widget del signup (portal) y de /aceptar-invitacion (admin).
  // Ambos comparten el vendor → misma directiva en ambos.
  'script-src': ["'self'", 'https://*.hcaptcha.com'],

  // 'unsafe-inline' necesario por style={{}} inline en algunos componentes
  // legacy (tanto portal como admin). Migrar a classes → borrar. TODO tech-debt.
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://*.hcaptcha.com'],

  // Sprint 105 (2026-07-24): `data:` removido — no hay @font-face data-embedded
  // en ninguno de los 2 apps. Cargamos Inter/JetBrains Mono via Google Fonts.
  'font-src': ["'self'", 'https://fonts.gstatic.com'],

  // Sprint 105 (2026-07-24): `data:` agregado — el modal viewer de comprobantes
  // en Financiera.jsx renderiza PDFs como `<iframe src="data:application/pdf;...">`
  // (contenido viene del backend en base64). Sin `data:` en frame-src el CSP
  // bloquea silenciosamente el iframe → el user ve visor vacío.
  'frame-src': ["'self'", 'data:', 'https://*.hcaptcha.com'],
  'manifest-src': ["'self'"],
  'worker-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  // Sprint 105 (2026-07-24): defense-in-depth. HSTS ya bumpea http→https
  // para browsers que respetan STS; `upgrade-insecure-requests` cubre todo
  // request subresource dentro de la página (imágenes, XHR, etc.).
  'upgrade-insecure-requests': [],
  // Sprint 105 (2026-07-24): bloquea inline event handlers `onclick="..."`,
  // `onload="..."`, etc. React usa syntheticEvent (no HTML attrs) → 0 impacto
  // funcional, prevención de que se agreguen a futuro.
  'script-src-attr': ["'none'"],
});

// ── Diferencias LEGÍTIMAS por site ────────────────────────────────────
// El resto de las directivas son idénticas entre root y admin.
//
// Sprint 1 audit 07-25 · Fix 10: los backend URLs de `img-src` se componen
// en `expectedCspFor(site, context)` desde BACKEND_URLS_BY_CONTEXT. Acá
// solo declaramos los tokens NON-backend (self, data:, blob:).
const SITE_DIFFERENCES = Object.freeze({
  // Portal (frontend/netlify.toml) — landing pública tecnyapp.com.
  //
  // Sprint 105 (2026-07-24): `blob:` REMOVIDO. Auditando createObjectURL en
  // frontend/src: solo se usa en downloadBlob.js (crea <a href="blob:"> para
  // download, NO <img src="blob:">). Ningún componente del portal renderiza
  // imágenes con blob URLs → CSP no lo necesita.
  root: {
    imgSrcBase: ["'self'", 'data:'],
  },
  // Admin (admin-frontend/netlify.toml) — admin.tecnyapp.com.
  //
  // Sprint 105 (2026-07-24): `blob:` AGREGADO. TrustedCompaniesCard usa
  // `URL.createObjectURL(file)` y luego lo pasa a `<img src={addPreview}>`
  // como preview de logo mientras se está subiendo. Sin blob: el CSP bloquea
  // el preview → el user no ve la imagen antes de submit (feature latente
  // rota, no reportada porque users no probaron esa función crítica todavía).
  admin: {
    imgSrcBase: ["'self'", 'data:', 'blob:'],
  },
});

// ── report-uri es CONTEXT-específico ──────────────────────────────────
// production → backend prod. staging / preview → backend staging (mismo criterio
// que el resto de la config: entornos no-prod no ensucian el prod backend).
const REPORT_URI_BY_CONTEXT = Object.freeze({
  production: 'https://tecny-backend-production.up.railway.app/api/csp-report',
  'branch-deploy': 'https://tecny-backend-staging.up.railway.app/api/csp-report',
  'deploy-preview': 'https://tecny-backend-staging.up.railway.app/api/csp-report',
});

// ── Contextos que deben tener CSP en cada netlify.toml ────────────────
const REQUIRED_CONTEXTS = Object.freeze(['production', 'branch-deploy', 'deploy-preview']);

// ── Sites cubiertos por la spec ───────────────────────────────────────
const SITES = Object.freeze({
  root: {
    label: 'root (frontend/tecnyapp.com)',
    path: 'netlify.toml',
  },
  admin: {
    label: 'admin (admin-frontend/admin.tecnyapp.com)',
    path: 'admin-frontend/netlify.toml',
  },
});

/**
 * Construye el spec CSP esperado para un (site, context) dado.
 * Combina directivas comunes + diferencia por site + report-uri por context.
 *
 * @param {'root' | 'admin'} site
 * @param {'production' | 'branch-deploy' | 'deploy-preview'} context
 * @returns {Record<string, string[]>} directive-name → [tokens]
 */
function expectedCspFor(site, context) {
  const siteDiff = SITE_DIFFERENCES[site];
  if (!siteDiff) throw new Error(`site desconocido: ${site}`);
  const reportUri = REPORT_URI_BY_CONTEXT[context];
  if (!reportUri) throw new Error(`context desconocido: ${context}`);
  const backendUrls = BACKEND_URLS_BY_CONTEXT[context];
  if (!backendUrls) throw new Error(`context desconocido para backend URLs: ${context}`);
  return {
    ...COMMON_DIRECTIVES,
    // connect-src: 'self' + backend(s) del contexto + hCaptcha + Google Fonts.
    // Sprint 1 audit 07-25 · Fix 10: se compone por contexto (antes era
    // COMMON con prod+staging siempre).
    //
    // 2026-07-28 (Sentry noise fix TECNY-PORTAL-BACKEND-1B, 378 events/14d):
    // el Service Worker de Vite PWA hace `fetch()` a fonts.googleapis.com
    // para pre-cachear el CSS de Inter/JetBrains Mono. `style-src` ya lo
    // permitía, pero `fetch()` va contra `connect-src`. Sin este dominio,
    // el SW disparaba una CSP violation por cada usuario en cada primer
    // load (~800 events/mes solo por eso). Efecto colateral silencioso:
    // el CSS de Google Fonts NO se pre-cacheaba, primer load de cada user
    // era más lento (~200ms extra en 3G).
    'connect-src': [
      "'self'",
      ...backendUrls,
      'https://*.hcaptcha.com',
      'https://fonts.googleapis.com',
    ],
    // img-src: base del site (self, data:, opcional blob:) + backend(s) del contexto.
    'img-src': [
      ...siteDiff.imgSrcBase,
      ...backendUrls,
    ],
    'report-uri': [reportUri],
  };
}

module.exports = {
  COMMON_DIRECTIVES,
  SITE_DIFFERENCES,
  BACKEND_URLS_BY_CONTEXT,
  REPORT_URI_BY_CONTEXT,
  REQUIRED_CONTEXTS,
  SITES,
  expectedCspFor,
};
