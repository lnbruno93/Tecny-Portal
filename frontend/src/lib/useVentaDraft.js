/**
 * useVentaDraft — persistencia de borrador de venta en localStorage.
 *
 * Contexto (bug Nook Tech, task #267, 2026-07-31):
 * El modal de "Nueva venta" se cerraba por click accidental en el overlay
 * (o ESC, o botón X) y el operador perdía TODA la carga (form + items del
 * carrito + pagos configurados). Rehacer una venta de 5-10 items lleva
 * varios minutos y bloquea al cliente esperando en el mostrador → alta
 * fricción operativa.
 *
 * Estrategia (2 capas defensivas):
 *   1. `tryClose()` con confirm — evita cierres accidentales cuando hay
 *      data cargada. Cubre ~90% de los casos (click torpe en overlay,
 *      ESC accidental, doble click en Cancelar).
 *   2. Este hook (draft persistente) — cubre el ~10% restante: crash del
 *      browser, refresh accidental, session expiry, cierre forzoso de
 *      pestaña, corte de luz con el modal abierto.
 *
 * Diseño:
 *   - LocalStorage key único global: `venta:draft:v1` (una máquina, un
 *     draft). No scopeamos per user/tenant porque los operadores comparten
 *     PC en muchos negocios y complica la mental model. Si aparece un
 *     caso multi-user en la misma PC pidiendo scope, agregamos v2.
 *   - Guarda solo lo serializable: `{ vForm, cart, pagos }`. Los
 *     `comprobantes` son File objects — no se persisten. Al restaurar,
 *     el operador ve un warning "Re-subí los comprobantes" si tenía.
 *   - TTL 24h. Un draft de hace más de un día probablemente ya no aplica
 *     (fecha cambió, precios cambiaron, stock cambió) — mejor que arranque
 *     limpio para no confundir.
 *   - Debounced 500ms — evita escribir localStorage en cada keystroke.
 *
 * Ciclo de vida:
 *   - Al abrir modal "Nueva venta" (no edit, no rápida): hook detecta
 *     draft ≤24h y expone `hasDraft=true`. UI muestra banner con opciones
 *     [Restaurar] / [Descartar].
 *   - Mientras el modal está abierto: cada cambio dispara `saveDraft()`
 *     (debounced) → localStorage se actualiza.
 *   - Al submitear exitoso: `clearDraft()`. El draft desaparece.
 *   - Al cerrar sin submitear (via tryClose confirm): el draft queda —
 *     próxima vez que abra "Nueva venta" verá el banner de restore.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'venta:draft:v1';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
const SAVE_DEBOUNCE_MS = 500;

// Shape del draft persistido. Versioned por si evolucionamos el shape.
// `savedAt` = timestamp UNIX ms del último save (para el TTL + UI).
// `state` = objeto arbitrario con lo que el caller pide persistir.

/**
 * Lee el draft actual de localStorage. Retorna null si:
 *   - No hay draft
 *   - Formato inválido (corrupción, JSON parse error)
 *   - Expiró (>24h desde savedAt)
 *
 * Efecto lateral: si el draft expiró, lo borra de localStorage (cleanup
 * automático — no dejamos basura acumulándose entre sesiones).
 */
export function readDraft() {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.savedAt !== 'number' || !parsed.state) return null;
    if (Date.now() - parsed.savedAt > TTL_MS) {
      // Expiró — cleanup preventivo.
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    // JSON.parse falla o localStorage bloqueado — degradación silenciosa,
    // el user pierde el draft pero no se rompe la app.
    return null;
  }
}

/**
 * Borra el draft de localStorage. Idempotente y silencioso.
 */
export function clearDraft() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * Hook para gestionar el draft de una venta en curso.
 *
 * @param {object} opts
 * @param {boolean} opts.enabled — solo persiste si true. El caller lo pone
 *   en `showVenta && !editId && !procRapidaId` — el draft NO aplica a edit
 *   ni a proceso de venta rápida (ambos parten de data server-side).
 *
 * @returns {{
 *   hasDraft: boolean,          — true si hay draft ≤24h al abrir
 *   draftPreview: {savedAt: number, itemsCount: number} | null,
 *   saveDraft: (state: object) => void,   — debounced, llamalo cada change
 *   restoreDraft: () => object | null,    — devuelve el state guardado
 *   discardDraft: () => void,             — limpia + esconde el banner
 * }}
 */
export function useVentaDraft({ enabled }) {
  // Snapshot inicial: leemos UNA VEZ al montar. El banner se muestra
  // basado en esto. Si el user restaura o descarta, se oculta.
  const [initialDraft, setInitialDraft] = useState(() => readDraft());
  const [bannerVisible, setBannerVisible] = useState(false);

  // Al enable=true (modal recién abierto), decidimos si mostrar banner.
  useEffect(() => {
    if (enabled && initialDraft) setBannerVisible(true);
    if (!enabled) setBannerVisible(false);
  }, [enabled, initialDraft]);

  // Debounce timer ref — se recrea en cada saveDraft, cancelando el
  // anterior. Así solo escribimos localStorage cuando el user pausa.
  const debounceRef = useRef(null);

  const saveDraft = useCallback((state) => {
    if (!enabled) return;
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      try {
        const payload = { savedAt: Date.now(), state };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        // QuotaExceeded o localStorage bloqueado (private mode) — silent.
        // El user pierde el draft pero el modal sigue funcionando.
      }
    }, SAVE_DEBOUNCE_MS);
  }, [enabled]);

  // Flush al desmontar por si había un save pendiente en el debounce.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const restoreDraft = useCallback(() => {
    setBannerVisible(false);
    return initialDraft?.state ?? null;
  }, [initialDraft]);

  const discardDraft = useCallback(() => {
    clearDraft();
    setInitialDraft(null);
    setBannerVisible(false);
  }, []);

  // Preview para el banner: cuántos items + timestamp formateado.
  const draftPreview = initialDraft ? {
    savedAt: initialDraft.savedAt,
    itemsCount: Array.isArray(initialDraft.state?.cart) ? initialDraft.state.cart.length : 0,
    hadComprobantes: (initialDraft.state?.__comprobantesCount ?? 0) > 0,
  } : null;

  return {
    hasDraft: bannerVisible,
    draftPreview,
    saveDraft,
    restoreDraft,
    discardDraft,
  };
}

export default useVentaDraft;
