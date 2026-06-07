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

const COLORS = {
  success: { bg: 'var(--pos)',    text: '#fff' },
  error:   { bg: 'var(--neg)',    text: '#fff' },
  warn:    { bg: '#d97706',       text: '#fff' },
  info:    { bg: 'var(--accent)', text: '#fff' },
};

function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  // role="status" + aria-live="polite" garantiza que los lectores de pantalla
  // anuncien los toasts sin interrumpir lo que el usuario está leyendo. Para
  // errores subimos a aria-live="assertive" se anuncia inmediatamente.
  // (Mantenemos polite global; los errores ya rompen contexto visualmente).
  return (
    <div
      className="toast-container"
      role="status"
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        pointerEvents: 'none',
      }}
    >
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast: t, onDismiss }) {
  const colors = COLORS[t.type] || COLORS.info;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 16px',
        borderRadius: 10,
        background: colors.bg,
        color: colors.text,
        boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
        fontSize: 14,
        fontWeight: 500,
        minWidth: 240,
        maxWidth: 380,
        pointerEvents: 'all',
        opacity: t.leaving ? 0 : 1,
        transform: t.leaving ? 'translateY(8px)' : 'translateY(0)',
        transition: 'opacity 0.25s ease, transform 0.25s ease',
        cursor: 'default',
      }}
    >
      <span style={{ flexShrink: 0, opacity: 0.9 }}>{ICONS[t.type]}</span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{t.message}</span>
      <button
        onClick={() => onDismiss(t.id)}
        aria-label="Cerrar notificación"
        style={{
          flexShrink: 0,
          background: 'none',
          border: 'none',
          color: colors.text,
          opacity: 0.7,
          cursor: 'pointer',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );
}
