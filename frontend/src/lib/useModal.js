/**
 * useModal — hook de accesibilidad para modales.
 *
 * Encapsula los patterns que la auditoría detectó faltantes en TODOS los
 * modales del sistema (14 modales sin Esc/focus-trap/scroll-lock):
 *
 *   1. **Esc cierra** — sin tener que clickear el botón "Cancelar" o el ✕.
 *      Útil para modales destructivos (ConfirmModal) y forms largos.
 *   2. **body scroll lock** — al abrir un modal, el fondo no debe scrollear
 *      cuando el usuario hace swipe en mobile (bug visual de iOS).
 *   3. **Focus al primer elemento** — al abrir, foco al primer input o botón.
 *   4. **Restore focus** — al cerrar, devolver foco al elemento que abrió
 *      el modal (W3C APG Dialog pattern). Sin esto, el foco "se pierde"
 *      al body después de cerrar — los usuarios de teclado quedan
 *      desorientados.
 *   5. **Focus trap** — Tab/Shift+Tab ciclan dentro del modal sin salirse
 *      al sidebar de la app (U-08 auditoría 2026-06-10). Patrón estándar
 *      W3C APG Dialog (https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
 *
 * Uso:
 *   const overlayRef = useRef(null);
 *   useModal({ open: showForm, onClose: () => setShowForm(false), overlayRef });
 *   ...
 *   {showForm && (
 *     <div ref={overlayRef} className="modal-overlay" onClick={() => setShowForm(false)}>
 *       <div className="modal" role="dialog" aria-modal="true" aria-labelledby="..."
 *            onClick={e => e.stopPropagation()}>...</div>
 *     </div>
 *   )}
 *
 * NOTA: `role="dialog"` y `aria-modal="true"` se aplican en el JSX del caller
 * (no se pueden inyectar desde el hook). El hook se encarga del foco/Esc/trap.
 *
 * El hook es defensivo: no hace nada si `open=false`, y limpia el body lock
 * y el listener al desmontar. Múltiples modales abiertos a la vez funcionan
 * (el body lock se acumula con un contador interno).
 */
import { useEffect, useRef } from 'react';

// Contador global de modales abiertos. Cuando llega a 0, soltamos el lock.
// Permite que dos modales anidados (ej. confirm dentro de un form) funcionen
// sin pisarse mutuamente.
let openCount = 0;

function applyBodyLock(lock) {
  if (typeof document === 'undefined') return;
  if (lock) {
    openCount += 1;
    if (openCount === 1) document.body.classList.add('modal-open');
  } else {
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) document.body.classList.remove('modal-open');
  }
}

// Selector de elementos focusables dentro del modal — base estándar W3C
// para focus trap. Excluimos `disabled` y `[tabindex="-1"]` (e.g. wrappers
// programáticos que no deben recibir foco vía Tab).
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(root) {
  if (!root) return [];
  // Sólo filtramos cosas explícitamente ocultas vía CSS hidden attribute.
  // Evitamos `offsetParent` / `getClientRects` como heurística de visibilidad:
  // jsdom no calcula layout, así que esos checks rechazan TODOS los elementos
  // en tests y rompen el focus trap. En el browser real, el selector ya
  // excluye `disabled`/`tabindex=-1`; lo demás se asume visible.
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(el => {
    if (el.hasAttribute('hidden')) return false;
    return true;
  });
}

export function useModal({ open, onClose, overlayRef, autoFocusSelector }) {
  // Ref para onClose: los callers pasan arrow functions inline que cambian
  // identidad en cada render. Si onClose estuviera en las deps del useEffect,
  // CUALQUIER setState del padre re-correría el efecto → re-foco al primer
  // input → el cursor "saltaba" del input que estabas tipeando de vuelta al
  // primer campo (bug reportado por el operador después de TANDA 1).
  // Solución: ref estable, leemos el último callback al momento del Esc.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Ref para guardar el elemento que tenía el foco antes de abrir el modal,
  // así podemos devolverle el foco al cerrar (restore focus, W3C APG).
  const previouslyFocusedRef = useRef(null);

  // Esc handler + body lock + foco inicial + focus trap. Solo depende de
  // `open` — las otras props son refs estables o configuración inmutable,
  // así que el efecto NO debe re-correr al cambiar onClose entre renders.
  useEffect(() => {
    if (!open) return undefined;

    // Guardar el elemento focuseado actual ANTES de mover el foco al modal.
    // Si nada está focuseado (e.g. user abrió con click en un link sin
    // foco visible), document.activeElement es <body> — y restoreFocus
    // a <body> es no-op, que es OK.
    previouslyFocusedRef.current = (typeof document !== 'undefined')
      ? document.activeElement
      : null;

    applyBodyLock(true);

    function onKey(e) {
      if (e.key === 'Escape' && typeof onCloseRef.current === 'function') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      // Focus trap (W3C APG Dialog). Tab desde el último elemento vuelve
      // al primero; Shift+Tab desde el primero salta al último. Si el foco
      // está fuera del modal (e.g. extension del browser robó el foco),
      // lo devolvemos al primer focusable.
      if (e.key === 'Tab') {
        const root = overlayRef?.current;
        if (!root) return;
        const focusables = getFocusable(root);
        if (focusables.length === 0) {
          // Nada focusable — prevenir tab default que se iría afuera.
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !root.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }
    document.addEventListener('keydown', onKey);

    // Foco inicial — esperamos un frame para que el modal esté en DOM.
    // Esto corre UNA SOLA VEZ al abrir el modal (no en cada re-render).
    const focusTimer = setTimeout(() => {
      const root = overlayRef?.current;
      if (!root) return;
      const selector = autoFocusSelector
        || 'input:not([type="hidden"]), textarea, select, [data-autofocus], button.btn-primary';
      const el = root.querySelector(selector);
      if (el && typeof el.focus === 'function') el.focus();
    }, 50);

    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey);
      applyBodyLock(false);
      // Restore focus al elemento que disparó el modal. Defensivo: el
      // elemento puede haber sido desmontado (e.g. botón en una lista que
      // se re-renderizó). Verificamos que siga conectado y sea focuseable.
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function' && prev.isConnected) {
        try { prev.focus(); } catch { /* ignore */ }
      }
      previouslyFocusedRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // overlayRef y autoFocusSelector son inmutables en la práctica (refs y
  // strings estables); incluirlos en deps re-aplicaría el foco innecesariamente.
}

export default useModal;
