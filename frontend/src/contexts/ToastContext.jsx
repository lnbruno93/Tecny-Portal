// ToastContext — sistema global de notificaciones tipo toast.
// Uso: const { toast } = useToast();
//      toast.success('Guardado correctamente');
//      toast.error('No se pudo guardar');
//      toast.info('Procesando…');

import { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';
import { friendlyError } from '../lib/friendlyError';

const ToastContext = createContext(null);

let _idCounter = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
    // Remove from DOM after animation
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 300);
  }, []);

  // Tope de stack para que un bug que dispare errores en loop no llene la
  // pantalla con 50 toasts. Cuando excede, descartamos los más viejos.
  const MAX_TOASTS = 5;

  const push = useCallback((message, type = 'info', duration = 4000) => {
    const id = ++_idCounter;
    setToasts(prev => {
      const next = [...prev, { id, message, type, leaving: false }];
      // Si superamos el tope, descartar los más viejos y cancelar sus timers
      while (next.length > MAX_TOASTS) {
        const stale = next.shift();
        clearTimeout(timers.current[stale.id]);
        delete timers.current[stale.id];
      }
      return next;
    });
    if (duration > 0) {
      timers.current[id] = setTimeout(() => dismiss(id), duration);
    }
    return id;
  }, [dismiss]);

  // CRÍTICO: memoizamos `toast` para que su referencia sea estable entre
  // renders del provider. Sin esto, cada vez que se agrega o quita un toast
  // (cambia `toasts` → re-render), `toast` sería un objeto nuevo. Componentes
  // que tengan `toast` en las deps de useEffect (Desglose360, etc.) entrarían
  // en loop si su effect dispara errores que generan toast.error → render
  // → nueva ref → effect → error → loop. Memoizando, la cadena se rompe.
  // toast.error acepta string O Error: si se pasa un Error, lo pipea por
  // friendlyError() (UX H1 auditoría 2026-06-06) que neutraliza casos crípticos
  // como 'NO_AUTH' (marker interno del wrapper api()) o TypeError genéricos.
  // Backward compatible: los call sites existentes con strings siguen igual.
  const toast = useMemo(() => ({
    success: (msg, opts) => push(msg, 'success', opts?.duration ?? 4000),
    error:   (msgOrErr, opts) => {
      const msg = (typeof msgOrErr === 'string') ? msgOrErr : friendlyError(msgOrErr);
      return push(msg, 'error', opts?.duration ?? 6000);
    },
    info:    (msg, opts) => push(msg, 'info',    opts?.duration ?? 4000),
    warn:    (msg, opts) => push(msg, 'warn',    opts?.duration ?? 5000),
    dismiss,
  }), [push, dismiss]);

  // El value del provider también memoizado para evitar re-renders innecesarios
  // en todos los consumers cuando este componente se re-renderiza por sus props.
  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast debe usarse dentro de <ToastProvider>');
  return ctx;
}

// ── Icons inline para no depender de Icons.jsx ──────────────────────────────
const ICONS = {
  success: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  error: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  warn: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  info: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  ),
};

// Sprint 93 CSP: los colores del toast pasaron a CSS clases
// .u-toast-{success|error|warn|info}. El JS solo mapea el tipo → suffix.
const TYPE_TO_CLASS = {
  success: 'u-toast-success',
  error:   'u-toast-error',
  warn:    'u-toast-warn',
  info:    'u-toast-info',
};

function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  // role="status" + aria-live="polite" garantiza que los lectores de pantalla
  // anuncien los toasts sin interrumpir lo que el usuario está leyendo. Para
  // errores subimos a aria-live="assertive" se anuncia inmediatamente.
  // (Mantenemos polite global; los errores ya rompen contexto visualmente).
  return (
    <div
      className="toast-container u-toast-container"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast: t, onDismiss }) {
  const typeClass = TYPE_TO_CLASS[t.type] || TYPE_TO_CLASS.info;
  return (
    <div className={'u-toast-item ' + typeClass + (t.leaving ? ' u-toast-item-leaving' : '')}>
      <span className="u-toast-icon">{ICONS[t.type]}</span>
      <span className="u-toast-msg">{t.message}</span>
      <button
        onClick={() => onDismiss(t.id)}
        aria-label="Cerrar notificación"
        className="u-toast-close-btn"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );
}
