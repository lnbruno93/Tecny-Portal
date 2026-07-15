/**
 * reportError — envía errores no manejados del admin al backend, que los
 * reenvía a Sentry (configurado en `backend/server.js`).
 *
 * Port 1:1 del pattern que usa `frontend/src/lib/reportError.js` (task #137,
 * 2026-07-15). Antes el admin NO reportaba nada — errores de super-admin
 * quedaban solo en console del browser, invisibles para monitoring.
 *
 * Diseño (mismo que portal):
 *   - Backend endpoint `/api/client-errors` recibe el POST (sin auth,
 *     rate-limited 60 req/min/IP, filtro de ruido idéntico al frontend).
 *   - Fire-and-forget con sendBeacon (fallback fetch keepalive) para
 *     no bloquear al usuario ni generar OTRO error si el backend está caído.
 *   - Throttle: máximo 5 reportes por sesión, mínimo 2s entre reportes.
 *   - NOISE_PATTERNS filtra transient network/chunk errors idem portal.
 *
 * Diferencia con portal:
 *   - `source: 'admin'` en el payload para que Sentry pueda distinguir
 *     app-portal vs app-admin en las tags. El backend lo pasa como tag
 *     `source` al captureMessage (ver backend/src/app.js:389).
 *   - No hay dependencia con auth: el ErrorBoundary del admin puede
 *     dispararse antes o después del login.
 */

// Auditoría 2026-06-30 Q-09 (portal, aplicable acá): no usar fallback hard-
// coded a producción. Si un build de staging sale sin VITE_API_URL, todos
// los reportes viajarían a la cola de Sentry de prod y ensuciarían la
// señal. Preferimos NO enviar y dejar un warn local.
const BASE = import.meta.env.VITE_API_URL || '';

// Build metadata inyectada por vite.config.js (via define). Permite
// correlacionar errores client con el commit/release exacto que estaba
// activo cuando ocurrió. Sin esto los stacktraces de Sentry son ilegibles
// porque no sabés QUÉ release los generó.
const BUILD_COMMIT  = typeof __BUILD_COMMIT__  !== 'undefined' ? __BUILD_COMMIT__  : 'unknown';
const BUILD_VERSION = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'unknown';

let reportsSent = 0;
const MAX_REPORTS_PER_SESSION = 5;
let lastReportAt = 0;
const MIN_INTERVAL_MS = 2000;

/**
 * Patrones ignorados. Mantenidos en paridad con
 * `frontend/src/lib/reportError.js` NOISE_PATTERNS — cualquier cambio
 * debería aplicarse en ambos (o extraer a un módulo compartido si crece).
 */
const NOISE_PATTERNS = [
  /Sin conexi[óo]n con el servidor/i,           // api.js fetch network failure
  /La solicitud tard[óo] demasiado/i,           // api.js AbortError (timeout)
  /^NO_AUTH$/,                                  // api.js 401 (sesión expirada — event)
  /No ten[ée]s permiso/i,                       // api.js 403 (mostrado al usuario)
  /Failed to fetch/i,                           // browser network failure genérico
  /NetworkError when attempting to fetch/i,     // Firefox
  /Load failed/i,                               // Safari
  /Network request failed/i,                    // misc
  /The operation was aborted/i,                 // user navegó/cerró
  /AbortError/i,                                // user navegó/cerró
  // Chunk load failures — mismo listado que portal (bundle stale post-deploy).
  /valid JavaScript MIME type/i,
  /dynamically imported module/i,
  /Importing a module script failed/i,
  /Loading chunk\s+\S+\s+failed/i,
  /Failed to fetch dynamically imported/i,
  /Cannot read properties of undefined \(reading 'default'\)/i,
];

function isNoise(error) {
  const msg = error?.message || String(error || '');
  return NOISE_PATTERNS.some(p => p.test(msg));
}

let _baseMissingWarned = false;

export function reportError(error, context = {}) {
  // Solo en producción — en dev preferimos ver el error en consola.
  if (import.meta.env.DEV) return;

  if (!BASE) {
    if (!_baseMissingWarned) {
      _baseMissingWarned = true;
      // eslint-disable-next-line no-console
      console.warn('[admin reportError] VITE_API_URL no está seteado; no se envían reportes a Sentry.');
    }
    return;
  }

  if (isNoise(error)) return;

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
    // 'admin' vs 'frontend' (portal) — permite filtrar en Sentry por origen.
    source: context.source || 'admin',
    build_commit:  BUILD_COMMIT,
    build_version: BUILD_VERSION,
    ...context,
    // Overwrite source SIEMPRE con 'admin' si el caller no especificó otro
    // — evita que un context externo lo pise a 'frontend' por error.
    ...(context.source ? {} : { source: 'admin' }),
  };

  try {
    const body = JSON.stringify(payload);
    const blob = new Blob([body], { type: 'application/json' });
    const sent = navigator.sendBeacon?.(BASE + '/api/client-errors', blob);
    if (!sent) {
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

/**
 * silentReport — para errores async que NO deben mostrar UI al usuario
 * pero SÍ deben loggearse. Reemplaza `.catch(console.error)` (invisible
 * en prod).
 */
export function silentReport(error, context = {}) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.error('[admin silentReport]', context, error);
    return;
  }
  reportError(error, context);
}

export function installGlobalErrorHandlers() {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    reportError(event.error || event.message, { source: 'admin:window.onerror' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { source: 'admin:unhandledrejection' });
  });
}
