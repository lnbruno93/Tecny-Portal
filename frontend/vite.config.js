import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Build metadata inyectada al bundle como constantes globales — accesibles
// desde el código frontend vía __BUILD_COMMIT__ y __BUILD_VERSION__.
// Razón: cuando un error llega a Sentry, los stacktraces minificados solo
// son legibles si sabemos qué build los generó. Sin esto, "main-abc123.js:1:34521"
// es inútil. Con el commit SHA del build, podemos hacer source-maps o
// re-build localmente para reproducir.
function buildCommit() {
  // En Railway/Netlify, el commit viene por env. En local, lo sacamos de git.
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA.slice(0, 7);
  if (process.env.COMMIT_REF)             return process.env.COMMIT_REF.slice(0, 7); // Netlify
  if (process.env.GIT_COMMIT_SHA)         return process.env.GIT_COMMIT_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}
function buildVersion() {
  try {
    return JSON.parse(readFileSync('./package.json', 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Activación condicional del plugin de Sentry: solo cuando el token está presente.
// Sin token, el plugin es no-op (no rompe build local ni preview). Con token,
// sube los source maps al proyecto Sentry y crea una "release" identificada
// con el commit short SHA — mismo identifier que usa el backend al taggear
// errors (build_commit en /api/client-errors), así Sentry puede matchear el
// stacktrace minificado con el código original.
//
// Requiere SENTRY_AUTH_TOKEN como env var en Netlify (build env). Para local
// no se setea — los maps no se suben.
const SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_ORG   = process.env.SENTRY_ORG   || 'lnbruno';
const SENTRY_PROJECT = process.env.SENTRY_PROJECT || 'tecny-portal-frontend';
const BUILD_SHA = buildCommit();

export default defineConfig({
  define: {
    __BUILD_COMMIT__:  JSON.stringify(BUILD_SHA),
    __BUILD_VERSION__: JSON.stringify(buildVersion()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'pwa-icon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Tecny',
        short_name: 'Tecny',
        description: 'Portal operativo Tecny — Financiera, Cajas, Envíos, Cotizador',
        theme_color: '#0a0e18',
        background_color: '#0a0e18',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        lang: 'es-AR',
        icons: [
          { src: 'pwa-64x64.png',            sizes: '64x64',   type: 'image/png' },
          { src: 'pwa-192x192.png',           sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png',           sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache todo el bundle. HTML se mantiene en precache pero NO se usa
        // como navigation handler — la runtime rule NetworkFirst de abajo se
        // encarga de las navigations cuando hay red, y cae al cache de
        // 'navigation-cache' offline. El index.html precacheado queda como
        // entrada inerte (sirve para bundle integrity check pero no se sirve
        // directamente — ver navigateFallback: null abajo).
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // navigateFallback: null deshabilita el NavigationRoute default de
        // workbox (que servía index.html del precache para CUALQUIER request
        // de navigation). Sin esto, ese route quedaba registrado ANTES de
        // nuestra runtime rule de NetworkFirst y se la comía — nuestro rule
        // nunca disparaba (first-match-wins en workbox routing). Resultado:
        // HTML siempre del precache → CSP cacheado → bug original.
        // Trade-off: primera navegación offline (sin cache previo) falla.
        // Aceptable — un PWA recién instalado tiene cache de la instalación.
        navigateFallback: null,
        // skipWaiting + clientsClaim: el nuevo SW se activa apenas instala y
        // toma control de las tabs abiertas (no espera a que se cierren todas).
        // Es lo que registerType: 'autoUpdate' implica, pero lo dejo explícito
        // para que sea obvio leyendo el archivo. Combinado con el banner de
        // Shell.jsx (needRefresh) y la runtime rule NetworkFirst abajo, asegura
        // que los users vean cambios de CSP / build dentro de minutos, no días.
        skipWaiting: true,
        clientsClaim: true,
        // API → NetworkFirst (siempre intenta red, cae a cache si offline)
        runtimeCaching: [
          // 2026-06-18 #309: Navigation requests → NetworkFirst.
          // Antes el SW servía index.html del precache CON los HTTP response
          // headers cacheados (incluyendo CSP). Cuando actualizábamos CSP a
          // nivel Netlify (#307 hCaptcha, #308 report-uri), users con SW
          // stale veían el CSP viejo hasta clickear "Actualizar" en el banner.
          // Con NetworkFirst, cuando hay red el HTML viene fresco de Netlify
          // (con el CSP del momento). Offline cae al cache. networkTimeoutSeconds:
          // 3s para no degradar la experiencia de carga.
          //
          // sameOrigin: solo nuestro frontend (Netlify), no apunta a Railway
          // ni a hCaptcha. request.mode === 'navigate' = top-level navigation
          // request (la única que carga HTML; los fetch/XHR son 'cors'/'no-cors').
          {
            urlPattern: ({ request, sameOrigin }) =>
              sameOrigin && request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'navigation-cache',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gfonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Matchea la URL absoluta del backend en Railway (cross-origin)
            // El patrón /\/api\/.*/i NO matchea URLs absolutas con dominio diferente
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/api/') ||
              url.href.includes('railway.app/api/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 10,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
    // sentryVitePlugin DEBE ir DESPUÉS de los demás plugins de build para que
    // procese los source maps ya generados. Es no-op sin SENTRY_AUTH_TOKEN.
    SENTRY_TOKEN && sentryVitePlugin({
      org:           SENTRY_ORG,
      project:       SENTRY_PROJECT,
      authToken:     SENTRY_TOKEN,
      release:       { name: BUILD_SHA }, // matchea con `release` en Sentry capture
      // Subir source maps y eliminarlos del bundle público (Sentry los lee).
      // Sin esto, los .map quedarían accesibles al cliente.
      sourcemaps:    {
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
      // Silencia logs verbose en local; deja warnings/errors visibles.
      silent:        false,
      telemetry:     false,
    }),
  ].filter(Boolean),
  base: '/',
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    globals: true,
    setupFiles: ['./src/test-setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
  build: {
    // Genera source maps para que el plugin de Sentry los suba. Los maps NO
    // quedan en el bundle público (filesToDeleteAfterUpload los borra
    // después del upload). Sin SENTRY_AUTH_TOKEN, los .map se generan pero
    // tampoco se publican — Netlify solo sirve lo que está en dist/ después
    // del build, y en ese caso no se borran. Para evitar exposición en local
    // builds, configurar netlify.toml o el .gitignore para no publicar .map.
    //
    // 'hidden' (no true): Vite genera los .map igual (Sentry los sigue
    // subiendo) PERO no agrega el comment "//# sourceMappingURL=..." en los
    // .js minificados. Sin ese comment, DevTools no sabe que existen los
    // maps y no intenta descargarlos → no aparecen los warnings de
    // "Unrecognized token '<'" en la consola que se generan cuando los
    // .map fueron borrados post-upload a Sentry. Sentry sigue funcionando
    // porque trabaja con los .map directamente, no necesita el comment.
    sourcemap: SENTRY_TOKEN ? 'hidden' : false,
    rollupOptions: {
      output: {
        // Vite 8 (rolldown) requiere manualChunks como función
        // Separa vendors en un chunk estable para maximizar cache hit rate
        manualChunks(id) {
          if (id.includes('node_modules/react') ||
              id.includes('node_modules/react-dom') ||
              id.includes('node_modules/react-router-dom') ||
              id.includes('node_modules/react-router/') ||
              id.includes('node_modules/@remix-run/')) {
            return 'vendor';
          }
        },
      },
    },
  },
});
