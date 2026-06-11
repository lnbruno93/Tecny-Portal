// Tooltip — wrapper accesible para texto explicativo (U-15 auditoría 2026-06-10).
//
// API:
//   <Tooltip content="texto explicativo">
//     <button>i</button>
//   </Tooltip>
//
// Accesibilidad (Patrón ARIA Tooltip):
//   · El tooltip tiene `role="tooltip"` y un id único.
//   · El trigger (primer child) recibe `aria-describedby={id}` cuando el
//     tooltip está visible (lectores de pantalla lo anuncian junto al label).
//   · Aparece en `focus` y `mouseenter`, desaparece en `blur`, `mouseleave`,
//     y al apretar `Escape` (W3C APG recomendación).
//
// Posicionamiento:
//   Simple, basado en `position: absolute` desde un wrapper inline-block.
//   Por default cae abajo (`placement="bottom"`); `placement="top"` lo
//   invierte. Sin libs externas — Floating UI sería overkill para tooltips
//   chiquitos sin overflow tracking.
//
// Estilos en styles.css (.tooltip + .tooltip-wrap).
import { Children, cloneElement, useEffect, useId, useRef, useState } from 'react';

export default function Tooltip({ content, placement = 'bottom', children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrapRef = useRef(null);

  // Esc cierra (W3C APG). Escuchamos a nivel document para que funcione
  // aún si el foco no está exactamente en el trigger (ej. móvil con tap).
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // El trigger es el primer hijo — le clonamos los handlers + aria-describedby.
  // Patrón "single child" estilo HeadlessUI: simple, sin necesidad de Slot.
  const child = Children.only(children);
  const trigger = cloneElement(child, {
    'aria-describedby': open ? id : undefined,
    onFocus: (e) => { setOpen(true); child.props.onFocus?.(e); },
    onBlur: (e) => { setOpen(false); child.props.onBlur?.(e); },
    onMouseEnter: (e) => { setOpen(true); child.props.onMouseEnter?.(e); },
    onMouseLeave: (e) => { setOpen(false); child.props.onMouseLeave?.(e); },
  });

  return (
    <span
      ref={wrapRef}
      className={`tooltip-wrap tooltip-${placement}`}
      // Sin esto, perderías el tooltip si el cursor se mueve del trigger al
      // bubble flotante (hover gap).
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {trigger}
      {open && (
        <span role="tooltip" id={id} className="tooltip">
          {content}
        </span>
      )}
    </span>
  );
}
