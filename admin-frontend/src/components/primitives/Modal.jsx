// Modal primitive del admin console (Sub-fase B.3 #353).
//
// React 19 + Vite 8, sin deps externas — los 4 modals de mutations de
// tenant (edit / suspend / reactivate / extend-trial) lo consumen.
//
// Decisiones de diseño explícitas:
//   · `open=false` → `return null`. NO usamos CSS hidden: queremos que el
//     child se desmonte (resetea form state interno automáticamente y no
//     deja listeners colgando).
//   · NO bloqueamos scroll del body. Lucas testea en mobile y el doble
//     scroll está OK por ahora — si molesta, se ajusta en sub-fase futura.
//   · Backdrop click cierra (configurable). Click sobre el card NO cierra:
//     `stopPropagation` para que el bubble no llegue al overlay.
//   · ESC cierra (configurable). Listener montado solo cuando open=true.
//   · Focus inicial: al abrir, focuseamos el primer input/textarea/button
//     del modal. Esto NO es un focus trap completo (Tab puede escapar),
//     pero es suficiente para que el teclado entre directo al form sin
//     un Tab manual.
//   · ARIA: role="dialog", aria-modal="true", aria-labelledby.

import { useEffect, useRef } from 'react';
import { Btn } from './index.jsx';

let modalSeq = 0;

export default function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  size = 'md',
  closeOnBackdrop = true,
  closeOnEsc = true,
}) {
  // ID estable para aria-labelledby. Generado una sola vez por instancia
  // (no por render) — useRef preserva la referencia entre renders.
  const titleIdRef = useRef(null);
  if (titleIdRef.current === null) {
    modalSeq += 1;
    titleIdRef.current = `modal-title-${modalSeq}`;
  }

  const cardRef = useRef(null);

  // ESC listener — solo cuando el modal está abierto. Si closeOnEsc=false,
  // no instalamos el listener en absoluto (no instalarlo y devolver early
  // sería equivalente, pero esto es más explícito y simétrico con backdrop).
  useEffect(() => {
    if (!open || !closeOnEsc) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeOnEsc, onClose]);

  // Focus inicial: al abrir, focuseamos el primer field/button del modal.
  // querySelector se ejecuta DESPUÉS del paint (setTimeout 0) para que el
  // DOM esté montado completo. Sin esto, el focus podría caer en un
  // elemento que aún no existe.
  useEffect(() => {
    if (!open) return undefined;
    const id = setTimeout(() => {
      const root = cardRef.current;
      if (!root) return;
      const focusable = root.querySelector(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])'
      );
      if (focusable) focusable.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [open]);

  if (!open) return null;

  // Click handler del backdrop. Solo dispara si el click fue EN el
  // backdrop mismo (e.target === e.currentTarget), no en algún descendiente.
  // Combinado con stopPropagation del card es defensa-en-profundidad.
  const handleBackdropClick = (e) => {
    if (!closeOnBackdrop) return;
    if (e.target === e.currentTarget) onClose?.();
  };

  const sizeClass = size === 'sm' ? 'modal-sm' : size === 'lg' ? 'modal-lg' : 'modal-md';

  return (
    <div
      className="modal-backdrop"
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        ref={cardRef}
        className={`modal ${sizeClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleIdRef.current}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-hd">
          <h2 id={titleIdRef.current} className="modal-title">{title}</h2>
          <Btn
            kind="ghost"
            sm
            iconOnly
            icon="X"
            onClick={onClose}
            aria-label="Cerrar"
          />
        </header>
        <section className="modal-body">{children}</section>
        {actions && <footer className="modal-ft">{actions}</footer>}
      </div>
    </div>
  );
}
