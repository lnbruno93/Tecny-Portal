// swAutoReload — helpers para el auto-reload silencioso post-SW update.
//
// 2026-07-14 (bug reportado por TekHaus): cuando deployamos fix backend/frontend,
// los users con tabs abiertos hace horas siguen ejecutando el bundle viejo hasta
// hard-reload. Hoy hay banner "Actualizar" (Shell.jsx UpdateBanner) pero es fácil
// de ignorar — TekHaus vio "búsqueda por producto sigue fallando" durante horas
// mientras Lucas (con bundle nuevo) no reproducía nada.
//
// Estrategia: cuando `needRefresh === true` (SW nuevo listo) + user inactivo
// >30s + ningún input con datos sin guardar → auto-invocar el update. Con esto:
//   · Fix crítico llega a todos los users sin depender de que clickeen el banner.
//   · Users activos (tipeando, editando) ven el banner pero NO son interrumpidos.
//   · Como safety net, el banner sigue visible y clickeable en todo momento.
//
// Helpers acá viven aparte del Shell.jsx para poder testear la lógica sin montar
// el árbol React entero (`shouldDelayReload` es puro DOM query — se testea con
// jsdom en vitest).

/**
 * ¿Debemos posponer el reload automático porque el user está en el medio de
 * algo importante? Retorna true si detectamos actividad de edición.
 *
 * Criterios (cualquiera → delay):
 *   1. El elemento con focus es un input/textarea/select/contenteditable →
 *      el user probablemente está tipeando (aunque no haya cambiado nada aún).
 *   2. Algún input/textarea "de datos" tiene value distinto al defaultValue →
 *      hay data ingresada sin guardar (React setea defaultValue al primer render;
 *      value !== defaultValue implica edición del user post-mount).
 *
 * Skips explícitos:
 *   · type="hidden" / "submit" / "button" / "reset" / "file" → no son inputs
 *     de datos que el user tipea.
 *   · type="checkbox" / "radio" → checked/unchecked no cuenta como "dirty"
 *     con criterio value (los users rara vez pierden data en checkboxes
 *     porque están asociados a un submit, no a un flujo de N campos).
 *
 * Falsos positivos aceptables (no recarga cuando podría):
 *   · Input con valor pre-poblado del server (ej. Ficha cliente con nombre
 *     ya guardado). `defaultValue === value` → no cuenta como dirty. ✓
 *   · Inputs vacíos con placeholder → value === '' → no cuenta como dirty. ✓
 *
 * Falsos negativos aceptables (recarga cuando quizás no debería):
 *   · State en React de otros componentes (ej. Cart items del modal Venta
 *     con productos agregados). No están en <input> del DOM directamente.
 *     Pero si el user acaba de agregar productos, estuvo interactuando
 *     hace <30s → el idle check lo salva.
 *
 * @returns {boolean} true si hay que posponer el reload
 */
export function shouldDelayReload() {
  // Guard SSR / test sin document.
  if (typeof document === 'undefined') return false;

  // Criterio 1: focus en input-like.
  const active = document.activeElement;
  if (active) {
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (active.isContentEditable) return true;
  }

  // Criterio 2: algún input tiene value != defaultValue (dirty post-mount).
  const inputs = document.querySelectorAll('input, textarea');
  const NON_DATA_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'file', 'checkbox', 'radio']);
  for (const el of inputs) {
    if (NON_DATA_TYPES.has(el.type)) continue;
    const value = (el.value || '').trim();
    if (!value) continue; // vacío no es dirty
    const defaultValue = (el.defaultValue || '').trim();
    if (value !== defaultValue) return true;
  }

  return false;
}

// Config del auto-reload. Exportados para poder testear con valores más chicos.
export const AUTO_RELOAD_IDLE_MS = 30_000;    // 30s sin interacción
export const AUTO_RELOAD_CHECK_INTERVAL_MS = 5_000;  // chequea cada 5s

/**
 * Instala listeners de actividad + un timer que dispara `onReady` cuando el
 * user está idle Y no hay forms dirty. Retorna un cleanup para desinstalar.
 *
 * Uso desde React:
 *   useEffect(() => {
 *     if (!needRefresh) return;
 *     return startAutoReloadWatcher(() => updateServiceWorker(true));
 *   }, [needRefresh, updateServiceWorker]);
 *
 * @param {() => void} onReady — callback a disparar cuando podemos recargar
 * @param {object} [opts]
 * @param {number} [opts.idleMs] — override para tests
 * @param {number} [opts.checkIntervalMs] — override para tests
 * @param {() => boolean} [opts.shouldDelay] — override para tests (default: shouldDelayReload)
 * @returns {() => void} cleanup para remover listeners + timer
 */
export function startAutoReloadWatcher(onReady, opts = {}) {
  const idleMs = opts.idleMs ?? AUTO_RELOAD_IDLE_MS;
  const checkMs = opts.checkIntervalMs ?? AUTO_RELOAD_CHECK_INTERVAL_MS;
  const shouldDelay = opts.shouldDelay ?? shouldDelayReload;

  let lastActivity = Date.now();
  let fired = false;
  const bump = () => { lastActivity = Date.now(); };

  // passive: true — no interfiere con scroll/touch performance.
  const events = ['mousemove', 'keydown', 'touchstart', 'scroll'];
  const opts_listener = { passive: true };
  events.forEach(ev => window.addEventListener(ev, bump, opts_listener));

  const timer = setInterval(() => {
    if (fired) return;
    if (Date.now() - lastActivity < idleMs) return;
    if (shouldDelay()) return;
    fired = true;
    onReady();
  }, checkMs);

  return () => {
    events.forEach(ev => window.removeEventListener(ev, bump, opts_listener));
    clearInterval(timer);
  };
}
