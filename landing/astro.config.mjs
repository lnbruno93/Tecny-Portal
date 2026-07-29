// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

/**
 * Landing pública de tecnyapp.com.
 *
 * Contexto: migración desde SPA React (frontend/src/screens/Landing.jsx) a
 * sitio estático Astro para poder correr Meta ADS con Pixel + CAPI limpio.
 * Ver `docs/LANDING_MIGRATION.md` (por crear) para el rationale completo.
 *
 * Convenciones:
 *   - `site` es la URL canónica de producción → usada por sitemap y meta tags.
 *   - Tailwind v4 vía Vite plugin (más rápido que el legacy @astrojs/tailwind).
 *   - React solo para "islands" (componentes interactivos puntuales: modal
 *     demo, form contacto). El resto es .astro estático (0 JS shipped).
 *   - Sitemap se genera al build, submitear a Google Search Console.
 */
export default defineConfig({
  site: 'https://tecnyapp.com',
  integrations: [react(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
  // Build determinístico: sin inline styles automáticos (para que CSP pueda
  // seguir siendo strict — un futuro `style-src 'self'` sin `'unsafe-inline'`
  // requiere que Astro NO inline styles en el HTML).
  build: {
    inlineStylesheets: 'never',
  },
});
