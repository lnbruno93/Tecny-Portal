/**
 * cotizadorTc — persistencia del TIPO DE CAMBIO del Cotizador.
 *
 * Contexto (task #445 primera pasada + follow-up 2026-07-01):
 * El Cotizador tenía TC hardcodeado en 1400 al arrancar; #445 agregó fetch
 * a `/api/config/last-tc` al mount que actualiza si hay valor. Pero cada
 * vez que el operador cerraba/abría el Cotizador, el TC volvía al valor
 * del backend — que puede ser viejo (ej. sistema quedó en $1400 cuando la
 * realidad es $1530). El operador terminaba tipeándolo a mano cada vez.
 *
 * Decisión del user 2026-07-01: TC persistente en localStorage. Una vez
 * que el operador lo tipea, queda hasta que él lo modifique manualmente.
 * NO se resetea por día ni por sesión.
 *
 * Alcance:
 * - Sólo el Cotizador. El modal de "Nueva Venta" mantiene su propio flow
 *   independiente (decisión durable — evita acoplamiento cross-módulo).
 * - Los 2 tabs internos del Cotizador (Tarjetas + USD) COMPARTEN el mismo
 *   TC persistido — cambiarlo en un tab impacta al otro al toque.
 *
 * Estrategia:
 * - localStorage key `cotizador_tc_ars_usd_v1` (con "_v1" por si algún día
 *   cambia el shape).
 * - Fail-safe en entornos sin localStorage (Safari privado modo, tests):
 *   getStoredTc() devuelve null → caller cae al fetch del backend.
 * - Sync cross-component (TabTarjetas ↔ TabUsd en la misma pestaña) via
 *   `window` custom event `cotizador-tc-changed`. localStorage events
 *   nativos NO disparan en la pestaña que hizo la escritura, sólo en
 *   OTRAS pestañas del mismo origin — por eso el custom event.
 * - Sync cross-tab (múltiples pestañas del portal abiertas): `storage`
 *   event nativo.
 */

const STORAGE_KEY = 'cotizador_tc_ars_usd_v1';
const CHANGE_EVENT = 'cotizador-tc-changed';

/**
 * Lee el TC persistido en localStorage.
 * @returns {number|null} — el valor si existe y es numérico, null si no.
 */
export function getStoredTc() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    // Guard: si algo escribió basura en la key, devolvemos null y el caller
    // hace fallback al backend. No throw — es mejor UX degradada que crash.
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    // Safari privado / cookies bloqueadas / etc.
    return null;
  }
}

/**
 * Persiste el TC nuevo y notifica a los otros consumers.
 * Fail-safe: si localStorage no está disponible, dispatch el event igual
 * (para sync in-memory entre TabTarjetas y TabUsd de la misma pestaña).
 * @param {number} value
 */
export function saveStoredTc(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return; // ignoramos silenciosamente
  try {
    localStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    // Storage no disponible — seguimos con el custom event para que el
    // sync in-memory funcione al menos.
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { value: n } }));
  } catch {
    // window ausente (SSR / tests raros) — no rompemos.
  }
}

/**
 * Suscripción al cambio del TC. Devuelve la función de unsubscribe (para
 * useEffect cleanup).
 *
 * Escucha tanto el custom event (cambios en la misma pestaña) como el
 * storage event nativo (cambios en OTRAS pestañas del mismo origin).
 *
 * @param {(value: number) => void} callback
 * @returns {() => void}
 */
export function subscribeTcChange(callback) {
  const onCustom = (e) => {
    const v = e?.detail?.value;
    if (Number.isFinite(v)) callback(v);
  };
  const onStorage = (e) => {
    if (e.key !== STORAGE_KEY) return;
    const n = Number(e.newValue);
    if (Number.isFinite(n) && n > 0) callback(n);
  };
  window.addEventListener(CHANGE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
