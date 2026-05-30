import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
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

export default defineConfig({
  define: {
    __BUILD_COMMIT__:  JSON.stringify(buildCommit()),
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
  ],
  base: '/',
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    globals: true,
    setupFiles: ['./src/test-setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
  build: {
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
