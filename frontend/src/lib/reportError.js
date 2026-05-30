/**
 * reportError — envía errores no manejados del cliente al backend, que los
 * reenvía a Sentry (configurado en `backend/server.js`).
 *
 * Por qué no Sentry directo en el frontend:
 *   - @sentry/react agrega ~30kb gz al bundle.
 *   - Ya tenemos Sentry corriendo en el backend; reusamos esa integración.
 *   - El endpoint `/api/client-errors` está sin auth y rate-limited globalmente.
 *
 * Hooks:
 *   - ErrorBoundary llama a `reportError` con el error capturado.
 *   - `installGlobalErrorHandlers()` se llama una vez en main.jsx para
 *     capturar window.onerror y unhandledrejection.
 *
 * Throttle: máximo 5 reportes por sesión, mínimo 2s entre reportes. Si la
 * app está en loop generando errores, no queremos DDOS-earnos a nosotros mismos.
 */
const BASE = import.meta.env.VITE_API_URL || 'https://ipro-backend-production.up.railway.app';

// Build metadata inyectada por vite.config.js (via define). Permite correlacionar
// errores client con el commit/release exacto que estaba activo cuando ocurrió.
// Sin esto, los stacktraces minificados de Sentry son ilegibles porque no sabés
// QUÉ release los generó.
const BUILD_COMMIT  = typeof __BUILD_COMMIT__  !== 'undefined' ? __BUILD_COMMIT__  : 'unknown';
const BUILD_VERSION = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'unknown';

let reportsSent = 0;
const MAX_REPORTS_PER_SESSION = 5;
let lastReportAt = 0;
const MIN_INTERVAL_MS = 2000;

export function reportError(error, context = {}) {
  // Solo en producción — en dev preferimos ver el error en consola.
  if (import.meta.env.DEV) return;

  // Throttle
  if (reportsSent >= MAX_REPORTS_PER_SESSION) return;
  const now = Date.now();
  if (now - lastReportAt < MIN_INTERVAL_MS) return;
  lastReportAt = now;
  reportsSent += 1;

  const payload = {
    message: error?.message || String(error),
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : null,
    url: window.location?.href,
    userAgent: navigator?.userAgent,
    timestamp: new Date().toISOString(),
    // Build info — el backend lo manda a Sentry como tags/release.
    build_commit:  BUILD_COMMIT,
    build_version: BUILD_VERSION,
    ...context,
  };

  // Fire-and-forget: si el backend está caído no queremos generar OTRO error.
  // sendBeacon no requiere CORS preflight y va aún si la página se está cerrando.
  try {
    const body = JSON.stringify(payload);
    const blob = new Blob([body], { type: 'application/json' });
    const sent = navigator.sendBeacon?.(BASE + '/api/client-errors', blob);
    if (!sent) {
      // Fallback: fetch con keepalive.
      fetch(BASE + '/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // No queremos que reportError tire un error secundario.
  }
}

export function installGlobalErrorHandlers() {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    reportError(event.error || event.message, { source: 'window.onerror' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { source: 'unhandledrejection' });
  });
}
