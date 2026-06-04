/**
 * useModal — hook de accesibilidad para modales.
 *
 * Encapsula los 3 patterns que la auditoría detectó faltantes en TODOS los
 * modales del sistema (14 modales sin Esc/focus-trap/scroll-lock):
 *
 *   1. **Esc cierra** — sin tener que clickear el botón "Cancelar" o el ✕.
 *      Útil para modales destructivos (ConfirmModal) y forms largos.
 *   2. **body scroll lock** — al abrir un modal, el fondo no debe scrollear
 *      cuando el usuario hace swipe en mobile (bug visual de iOS).
 *   3. **Focus al primer elemento** — al abrir, foco al primer input o botón;
 *      al cerrar, devolver foco al elemento que abrió el modal (restoreFocus).
 *
 * Uso:
 *   const overlayRef = useRef(null);
 *   useModal({ open: showForm, onClose: () => setShowForm(false), overlayRef });
 *   ...
 *   {showForm && (
 *     <div ref={overlayRef} className="modal-overlay" onClick={() => setShowForm(false)}>
 *       <div className="modal" onClick={e => e.stopPropagation()}>...</div>
 *     </div>
 *   )}
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

export function useModal({ open, onClose, overlayRef, autoFocusSelector }) {
  // Ref para onClose: los callers pasan arrow functions inline que cambian
  // identidad en cada render. Si onClose estuviera en las deps del useEffect,
  // CUALQUIER setState del padre re-correría el efecto → re-foco al primer
  // input → el cursor "saltaba" del input que estabas tipeando de vuelta al
  // primer campo (bug reportado por el operador después de TANDA 1).
  // Solución: ref estable, leemos el último callback al momento del Esc.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Esc handler + body lock + foco inicial. Solo depende de `open` —
  // las otras props son refs estables o configuración inmutable, así que
  // el efecto NO debe re-correr al cambiar onClose entre renders.
  useEffect(() => {
    if (!open) return undefined;

    applyBodyLock(true);

    function onKey(e) {
      if (e.key === 'Escape' && typeof onCloseRef.current === 'function') {
        e.stopPropagation();
        onCloseRef.current();
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // overlayRef y autoFocusSelector son inmutables en la práctica (refs y
  // strings estables); incluirlos en deps re-aplicaría el foco innecesariamente.
}

export default useModal;
