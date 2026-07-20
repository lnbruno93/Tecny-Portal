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

// ── Directivas COMUNES a los 2 sites y a los 3 contextos ──────────────
// Cualquier cambio acá debe reflejarse en LOS 6 blocks (2 files × 3 contextos).
// El script verify-csp-parity.js asserta que sea así.
const COMMON_DIRECTIVES = Object.freeze({
  'default-src': ["'self'"],

  // hCaptcha widget del signup (portal) y de /aceptar-invitacion (admin).
  // Ambos comparten el vendor → misma directiva en ambos.
  'script-src': ["'self'", 'https://*.hcaptcha.com'],

  // 'unsafe-inline' necesario por style={{}} inline en algunos componentes
  // legacy (tanto portal como admin). Migrar a classes → borrar. TODO tech-debt.
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://*.hcaptcha.com'],

  'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],

  // Backend prod + staging en ambos porque el bundle se compila con VITE_API_URL
  // definida en build time — el CSP tiene que cubrir cualquiera de las 2
  // targets posibles para que no falle por config drift.
  'connect-src': [
    "'self'",
    'https://tecny-backend-production.up.railway.app',
    'https://tecny-backend-staging.up.railway.app',
    'https://*.hcaptcha.com',
  ],

  'frame-src': ["'self'", 'https://*.hcaptcha.com'],
  'manifest-src': ["'self'"],
  'worker-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
});

// ── Diferencias LEGÍTIMAS por site ────────────────────────────────────
// El resto de las directivas son idénticas entre root y admin.
const SITE_DIFFERENCES = Object.freeze({
  // Portal (frontend/netlify.toml) — landing pública tecnyapp.com.
  root: {
    // 'blob:' habilita <img src="blob:..."> generados por URL.createObjectURL
    // (posible en flows de upload preview). El admin también lo necesitaría
    // si diera preview upload, pero admin hace preview vía data: URLs, no blob.
    'img-src': [
      "'self'",
      'data:',
      'blob:',
      'https://tecny-backend-production.up.railway.app',
      'https://tecny-backend-staging.up.railway.app',
    ],
  },
  // Admin (admin-frontend/netlify.toml) — admin.tecnyapp.com.
  admin: {
    'img-src': [
      "'self'",
      'data:',
      'https://tecny-backend-production.up.railway.app',
      'https://tecny-backend-staging.up.railway.app',
    ],
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
  return {
    ...COMMON_DIRECTIVES,
    ...siteDiff,
    'report-uri': [reportUri],
  };
}

module.exports = {
  COMMON_DIRECTIVES,
  SITE_DIFFERENCES,
  REPORT_URI_BY_CONTEXT,
  REQUIRED_CONTEXTS,
  SITES,
  expectedCspFor,
};
