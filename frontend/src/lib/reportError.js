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
// Auditoría 2026-06-30 Q-09: no usar fallback hard-coded a producción.
//
// El fallback anterior era `'https://tecny-backend-production.up.railway.app'`.
// Si un build de staging salía sin `VITE_API_URL` por error de Netlify env,
// TODOS los reportes de ese build viajaban a la cola de Sentry de PROD —
// contaminando la señal de prod con ruido de staging y haciendo imposible
// distinguir incidentes reales. Antes que enviar al destino equivocado,
// preferimos NO enviar y dejar un warn local para que el operador detecte el
// misconfig.
const BASE = import.meta.env.VITE_API_URL || '';

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

/**
 * Patrones de mensajes que NO son bugs y no deben llegar a Sentry.
 *
 * Detectado 2026-06-14 mirando issue Sentry NODE-F: 14 eventos agrupados bajo
 * "Sin conexión con el servidor. Verificá tu red e intentá de nuevo." con 0
 * users mapeados. Ese texto sale de `api.js` cuando un fetch() falla por red
 * — es el mensaje que mostramos AL USUARIO, no la causa raíz. Si la promesa
 * cae en `unhandledrejection`, el handler global lo postea a /api/client-errors
 * → backend → Sentry, ensuciando la cola con ruido transient sin contexto del
 * endpoint que falló.
 *
 * Estos mensajes se silencian PORQUE:
 *   1. Son transient (wifi del usuario, no un bug del código).
 *   2. Ya los manejamos correctamente (mostramos al usuario, ofrecemos retry).
 *   3. Agrupados son inútiles para diagnosticar — perdemos info del endpoint.
 *
 * Si en el futuro queremos OBSERVABILIDAD de estos errores (ej. detectar
 * Railway tirado), mejor hacer un endpoint de health que mida latencia, NO
 * apilar mensajes de UI en Sentry.
 */
const NOISE_PATTERNS = [
  /Sin conexi[óo]n con el servidor/i,           // api.js fetch network failure
  /La solicitud tard[óo] demasiado/i,           // api.js AbortError (timeout)
  /^NO_AUTH$/,                                  // api.js 401 (sesión expirada — handled via event)
  /No ten[ée]s permiso/i,                       // api.js 403 (mostrado al usuario)
  /Failed to fetch/i,                           // browser network failure genérico
  /NetworkError when attempting to fetch/i,     // Firefox
  /Load failed/i,                               // Safari
  /Network request failed/i,                    // misc
  /The operation was aborted/i,                 // user navegó/cerró
  /AbortError/i,                                // user navegó/cerró
];

function isNoise(error) {
  const msg = error?.message || String(error || '');
  return NOISE_PATTERNS.some(p => p.test(msg));
}

// Warn flag para que el misconfig de VITE_API_URL no se loguee 5000 veces.
let _baseMissingWarned = false;

export function reportError(error, context = {}) {
  // Solo en producción — en dev preferimos ver el error en consola.
  if (import.meta.env.DEV) return;

  // Auditoría 2026-06-30 Q-09: si el build salió sin VITE_API_URL, no hay
  // backend al que postear — early return + warn 1 sola vez para que el
  // operador detecte el misconfig en cualquier consola que abra.
  if (!BASE) {
    if (!_baseMissingWarned) {
      _baseMissingWarned = true;
      // eslint-disable-next-line no-console
      console.warn('[reportError] VITE_API_URL no está seteado; no se envían reportes a Sentry.');
    }
    return;
  }

  // Filtrar ruido conocido (errores transient de red, etc.) — ver
  // NOISE_PATTERNS para el porqué.
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

/**
 * silentReport — para errores async que NO deben mostrar UI al usuario pero
 * SÍ deben loggearse. Antes los handlers usaban `.catch(console.error)` que en
 * producción se evapora (Safari/Chrome no muestran console por default ni el
 * operador la abre). Resultado: cualquier fetch que falla "siempre" en un caso
 * edge queda invisible meses.
 *
 * 2026-06-11 H-03: reemplaza el pattern `.catch(console.error)` por
 * `.catch(err => silentReport(err, { screen: 'X', action: 'Y' }))`.
 *
 * En DEV: loggea a console (visible durante el desarrollo).
 * En PROD: postea al backend → Sentry con el context.
 */
export function silentReport(error, context = {}) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.error('[silentReport]', context, error);
    return;
  }
  reportError(error, context);
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
