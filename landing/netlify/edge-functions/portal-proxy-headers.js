// portal-proxy-headers.js (2026-07-30 P0 hotfix)
//
// Netlify edge function que intercepta los paths del portal (/login, /signup,
// /forgot-password) y garantiza:
//   1. Cache-Control: no-store — el edge nunca cachea el response del proxy,
//      así cambios de CSP se aplican inmediato sin esperar TTL expire.
//   2. Content-Security-Policy con hcaptcha.com — replica exactamente el CSP
//      del landing/netlify.toml. Sin esto, el widget hCaptcha invisible del
//      login/signup no carga y el user no puede loguearse.
//
// Root cause histórico: el catch-all `/* → tecny-portal.netlify.app/:splat`
// sirve la SPA React del portal via proxy. Netlify wrappea los headers del
// response del proxy con los headers del landing site — CSP del landing gana
// sobre el del portal. Cuando la migración a Astro creó el CSP restrictivo
// (PRs #936/#937), esos 3 paths quedaron sin hcaptcha permitido.
//
// La fix "correcta" (netlify.toml [[headers]] + _headers) tardaba horas en
// propagar por edge cache stubborn (fwd=stale indefinido). Edge function
// resuelve esto porque corre POR-REQUEST antes del cache.
//
// La edge function se ejecuta SOLO en los paths declarados en `config.path`
// abajo. Los demás siguen el flujo normal (static o catch-all proxy).

export default async (request, context) => {
  // Fetch response del backend (proxy al portal). context.next() aplica el
  // catch-all rewrite y trae el HTML del SPA.
  const response = await context.next();

  // Clonamos para poder mutar headers (Response es immutable por default).
  const headers = new Headers(response.headers);

  // 1. No cachear en el edge — cada request va al origen. El SPA ya tiene
  //    su propio cache-busting via hash-based filenames (Vite).
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');

  // 2. CSP con hcaptcha permitido (script/style/connect/frame-src).
  //    Duplicado exacto del netlify.toml [[headers]] block para /*.
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://connect.facebook.net https://www.googletagmanager.com https://*.hcaptcha.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.hcaptcha.com; " +
    "img-src 'self' data: https://www.facebook.com https://*.facebook.com https://www.google-analytics.com https://*.google-analytics.com https://tecny-backend-production.up.railway.app https://tecny-backend-staging.up.railway.app; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "connect-src 'self' https://tecny-backend-production.up.railway.app https://tecny-backend-staging.up.railway.app https://www.facebook.com https://*.facebook.com https://www.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com https://*.hcaptcha.com; " +
    "frame-src 'self' https://*.hcaptcha.com; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const config = {
  path: ['/login', '/signup', '/forgot-password'],
};
