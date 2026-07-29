/**
 * api.ts — resolución de la URL base del backend Tecny.
 *
 * En Astro las env vars con prefix `PUBLIC_` están disponibles en el browser.
 * `PUBLIC_API_URL` se setea por contexto en `landing/netlify.toml`:
 *   - production      → https://tecny-backend-production.up.railway.app
 *   - branch-deploy   → https://tecny-backend-staging.up.railway.app
 *   - deploy-preview  → https://tecny-backend-staging.up.railway.app
 *
 * En dev local sin `.env`, cae al default de producción (mismo comportamiento
 * que la versión SPA `frontend/src/lib/api.js:resolveApiBase`).
 */

const DEFAULT_API_URL = 'https://tecny-backend-production.up.railway.app';

/**
 * URL base del backend. Trailing slash removido para permitir concatenación
 * simple: `BACKEND_BASE + '/api/public/pricing'`.
 */
export const BACKEND_BASE = (
  import.meta.env.PUBLIC_API_URL || DEFAULT_API_URL
).replace(/\/+$/, '');

/**
 * Helper para armar URLs contra el backend público (sin auth).
 */
export function apiUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${BACKEND_BASE}${clean}`;
}
