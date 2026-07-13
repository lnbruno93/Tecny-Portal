import { useEffect } from 'react';

/**
 * 2026-07-13 UX fix: bloquear que el scroll con rueda/trackpad cambie el
 * valor de inputs numéricos.
 *
 * Contexto: HTML5 nativo hace que `<input type="number">` con focus
 * incremente/decremente su valor cuando el usuario hace scroll con
 * rueda o gesture del trackpad sobre el campo. Bug reportado por
 * cliente 2026-07-13 sobre el modal de Nueva Venta: al scrollear
 * el modal, el valor de "$ 151770" bajaba silenciosamente.
 *
 * Fix estándar de la industria (Notion, Airtable, Linear, Stripe): al
 * detectar wheel sobre `input[type=number]` con focus, hacer `blur()`.
 * El scroll de la página sigue funcionando pero deja de afectar al input.
 *
 * NO usamos `preventDefault()` porque eso bloquearía el scroll de la
 * página mientras el foco está en el input (peor UX en móvil y para
 * scroll de la ventana modal).
 *
 * Coverage: el listener vive a nivel `document` con {passive: true},
 * así intercepta wheel events de TODOS los `<input type="number">` del
 * portal (114 inputs distribuidos en 12 pantallas). Zero cambios en los
 * componentes individuales.
 *
 * Uso: llamar UNA vez en el componente root de la app (`App.jsx`).
 */
export function useBlockNumberInputScroll() {
  useEffect(() => {
    function blurNumberInputOnWheel(e) {
      const el = e.target;
      if (
        el && el.tagName === 'INPUT' &&
        el.type === 'number' &&
        document.activeElement === el
      ) {
        el.blur();
      }
    }
    // {passive: true}: no llamamos preventDefault. Los browsers optimizan
    // scroll con passive listeners (evitan main-thread jank).
    document.addEventListener('wheel', blurNumberInputOnWheel, { passive: true });
    return () => document.removeEventListener('wheel', blurNumberInputOnWheel);
  }, []);
}
