// ConfirmModal — reemplaza window.confirm() con un modal del design system.
// Uso declarativo (componente): <ConfirmModal open={...} onConfirm={...} onCancel={...} ... />
// Uso imperativo (hook):        const confirm = useConfirm(); await confirm({ title, message });

import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { useModal } from '../lib/useModal';

// ── Imperativo: hook useConfirm ───────────────────────────────────────────────
const ConfirmCtx = createContext(null);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null); // { title, message, confirmLabel, danger, resolve }
  const resolveRef = useRef(null);

  const confirm = useCallback(({
    title        = '¿Estás seguro?',
    message      = '',
    confirmLabel = 'Confirmar',
    danger       = false,
  } = {}) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setState({ title, message, confirmLabel, danger });
    });
  }, []);

  function handleConfirm() {
    setState(null);
    resolveRef.current?.(true);
  }

  function handleCancel() {
    setState(null);
    resolveRef.current?.(false);
  }

  return (
    <ConfirmCtx.Provider value={{ confirm }}>
      {children}
      {state && (
        <ConfirmModal
          open
          title={state.title}
          message={state.message}
          confirmLabel={state.confirmLabel}
          danger={state.danger}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm debe usarse dentro de <ConfirmProvider>');
  return ctx.confirm;
}

// ── Declarativo: componente ────────────────────────────────────────────────────
export function ConfirmModal({
  open,
  title        = '¿Estás seguro?',
  message      = '',
  confirmLabel = 'Confirmar',
  cancelLabel  = 'Cancelar',
  danger       = false,
  onConfirm,
  onCancel,
}) {
  const overlayRef = useRef(null);
  // Esc cierra (cancelar) + body scroll lock + foco al botón primario.
  // Crítico en operaciones destructivas (delete venta, comprobante, etc.):
  // antes no había forma rápida de cancelar por teclado.
  useModal({ open, onClose: onCancel, overlayRef });

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      style={{ zIndex: 500 }}
    >
      <div
        className="modal"
        style={{ maxWidth: 400 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-hd">
          <h3 id="confirm-modal-title" style={{ color: danger ? 'var(--neg)' : 'var(--text)' }}>{title}</h3>
        </div>
        {message && (
          <div className="modal-body">
            {/* whiteSpace: pre-line respeta `\n` en el message — útil cuando el
                caller pasa varias líneas (ej. desglose de diferencia en venta). */}
            <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0, lineHeight: 1.6, whiteSpace: 'pre-line' }}>
              {message}
            </p>
          </div>
        )}
        <div className="modal-ft">
          <button className="btn btn-ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className="btn btn-primary"
            style={danger ? { background: 'var(--neg)', boxShadow: 'none' } : {}}
            onClick={onConfirm}
            data-autofocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
