// ScrollFadeX — wrapper reactivo para containers con overflow horizontal.
//
// #F-4: reemplazó al utility `.scroll-fade-x` original (#M-09, removido en
// post-audit) que mostraba un fade-right permanente, sin detectar overflow
// real ni posición de scroll. Este componente lo mejora con ResizeObserver
// + scroll listener para mostrar el fade SOLO cuando hay contenido oculto
// en esa dirección. Resultado:
//   - Sin overflow → ningún fade.
//   - Overflow + scrollLeft=0 → fade derecho.
//   - Overflow + scrolleado al medio → fade izquierdo + derecho.
//   - Overflow + scrolleado al final → fade izquierdo.
//
// Uso:
//   <ScrollFadeX>
//     <Seg ... />     {/* o cualquier contenido scrollable horizontalmente */}
//   </ScrollFadeX>
//
// El componente crea el wrapper externo (position:relative) y el inner
// scrollable (overflow-x:auto). Si tu contenido ya tiene padding/margin que
// querés conservar, pasalo via `style` o `className`.

import { useEffect, useRef, useState, useCallback } from 'react';

export default function ScrollFadeX({ children, className = '', style }) {
  const scrollerRef = useRef(null);
  const [hasOverflowRight, setHasOverflowRight] = useState(false);
  const [hasOverflowLeft,  setHasOverflowLeft]  = useState(false);

  const update = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Tolerancia 1px para evitar flicker por subpixel rounding.
    const maxScroll = el.scrollWidth - el.clientWidth;
    setHasOverflowLeft(el.scrollLeft > 1);
    setHasOverflowRight(el.scrollLeft < maxScroll - 1);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    update(); // medición inicial

    // ResizeObserver: cubre cambios de tamaño del wrapper Y del contenido
    // interno (ej. categorías que se agregan/quitan, hover que cambia layout).
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Observar también el primer hijo para detectar cambios de contenido.
    if (el.firstElementChild) ro.observe(el.firstElementChild);

    el.addEventListener('scroll', update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', update);
    };
  }, [update]);

  // Re-medir si los children cambian (key/identity). useEffect con dep en
  // children no funciona bien con elements, pero ResizeObserver del firstChild
  // ya cubre la mayoría de los casos.
  return (
    <div
      className={
        'scroll-fade-rx ' +
        (hasOverflowLeft  ? 'has-overflow-left '  : '') +
        (hasOverflowRight ? 'has-overflow-right ' : '') +
        className
      }
      style={style}
    >
      <div ref={scrollerRef} className="scroll-fade-rx__inner">
        {children}
      </div>
    </div>
  );
}
