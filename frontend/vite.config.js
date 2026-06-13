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
const SENTRY_PROJECT = process.env.SENTRY_PROJECT || 'ipro-portal-frontend';
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
        name: 'iPro Portal',
        short_name: 'iPro',
        description: 'Portal operativo iPro Tech — Financiera, Cajas, Envíos, Cotizador',
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
        // Precache todo el bundle
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // API → NetworkFirst (siempre intenta red, cae a cache si offline)
        runtimeCaching: [
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
