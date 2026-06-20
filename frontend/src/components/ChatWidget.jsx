/**
 * ChatWidget — Asistente Tecny (FAB + Modal) (#340 Fase 1).
 *
 * UX (decidido con Lucas — Opción B de los mocks):
 *   - Botón FAB redondo en bottom-right del viewport (sparkles + tooltip).
 *   - Click abre un modal centrado tipo "card" (no a pantalla completa) —
 *     suficiente espacio para una conversación cómoda sin ocupar todo el
 *     screen real estate.
 *   - Header: avatar del bot + "Asistente Tecny" + botón cerrar.
 *   - Cuerpo: lista de mensajes (user a la derecha, assistant a la izquierda).
 *   - Footer: textarea + botón Enviar. Enter envía, Shift+Enter newline.
 *
 * State management:
 *   - Local useState — para Fase 1 no necesitamos compartir state con otros
 *     componentes. Si en Fase 2 hace falta (ej. abrir conv desde URL,
 *     notificaciones cross-tab), promovemos a ChatContext.
 *   - Conversación: se crea lazy en el primer envío (POST /conversations).
 *     A partir de ahí se reusa el mismo id para la sesión del widget.
 *   - Al cerrar el modal, el id queda guardado en state — reabrir continúa
 *     la conversación. Si el user quiere arrancar de cero, el botón "+"
 *     en el header resetea (sin borrar la conv, queda en historial).
 *
 * Tolerancia a errores:
 *   - 429 (rate limit): muestra el error.message del backend (que ya viene
 *     en español con números concretos). NO loopear retry automático.
 *   - 502 / network: muestra "Probá de nuevo en un momento". El user msg ya
 *     quedó persistido server-side — si reintenta, NO duplica (es un nuevo
 *     send). En la práctica el peor caso es 2 msgs de user antes de la
 *     respuesta — UX aceptable.
 *
 * No render si user no está logueado (defensive: Shell solo renderiza
 * ChatWidget dentro de rutas autenticadas, pero por las dudas).
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Icons } from './Icons';
import { chat } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

// Longitud máxima alineada con el backend (schemas/chat.js). Validado en el
// server, replicado acá para feedback inmediato (counter de chars).
const MAX_USER_MESSAGE_CHARS = 4000;

export default function ChatWidget() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);   // [{ role, text, error? }]
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const textareaRef = useRef(null);
  const scrollerRef = useRef(null);

  // Auto-focus en textarea cuando se abre el modal. Más natural que
  // requerir click adicional.
  useEffect(() => {
    if (open && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [open]);

  // Auto-scroll al fondo cuando llega un mensaje nuevo. requestAnimationFrame
  // garantiza que el DOM ya pintó el msg antes de scrollear (sino scrollea
  // al bottom anterior).
  useEffect(() => {
    if (!scrollerRef.current) return;
    requestAnimationFrame(() => {
      if (scrollerRef.current) {
        scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
      }
    });
  }, [messages, sending]);

  // ESC cierra el modal — paridad con CommandPalette / ChangePasswordModal.
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const reset = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setError(null);
    setDraft('');
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setError(null);

    // Append optimisticamente el user msg al state — UX responsive.
    const optimisticMsg = { role: 'user', text };
    setMessages((m) => [...m, optimisticMsg]);
    setDraft('');
    setSending(true);

    try {
      // Crear conv lazy si no existe todavía.
      let id = conversationId;
      if (!id) {
        const conv = await chat.createConversation();
        id = conv.id;
        setConversationId(id);
      }

      const res = await chat.sendMessage(id, text);
      setMessages((m) => [
        ...m,
        { role: 'assistant', text: res.text || 'Sin respuesta.' },
      ]);
    } catch (err) {
      // Marcar el user msg con error (visible al lado del mensaje)
      // + setear error global del widget. NO removemos el user msg del
      // hilo — quedó persistido server-side y queremos que sea reintentable
      // (escribe lo mismo y mandalo de nuevo).
      const msg = err?.message || 'No pude conectar. Probá de nuevo.';
      setError(msg);
      setMessages((m) => {
        const copy = [...m];
        const lastIdx = copy.length - 1;
        if (lastIdx >= 0 && copy[lastIdx].role === 'user') {
          copy[lastIdx] = { ...copy[lastIdx], error: true };
        }
        return copy;
      });
    } finally {
      setSending(false);
    }
  }, [draft, sending, conversationId]);

  const onKeyDownTextarea = useCallback((e) => {
    // Enter envía; Shift+Enter inserta newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }, [send]);

  if (!user) return null;

  return (
    <>
      {/* FAB */}
      <button
        type="button"
        className="chat-fab"
        title="Asistente Tecny"
        aria-label="Abrir asistente"
        onClick={() => setOpen(true)}
        aria-expanded={open}
      >
        <Icons.Sparkles size={22} />
      </button>

      {/* Modal (overlay + card) */}
      {open && (
        <div
          className="chat-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Asistente Tecny"
          onClick={(e) => {
            // Click fuera de la card cierra el modal.
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="chat-card">
            <header className="chat-header">
              <div className="chat-header-title">
                <div className="chat-avatar"><Icons.Sparkles size={16} /></div>
                <div>
                  <div className="chat-title">Asistente Tecny</div>
                  <div className="chat-sub">Análisis de tu negocio</div>
                </div>
              </div>
              <div className="chat-header-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title="Nueva conversación"
                  onClick={reset}
                  disabled={sending}
                >
                  <Icons.Plus size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Cerrar"
                  onClick={() => setOpen(false)}
                >
                  <Icons.X size={16} />
                </button>
              </div>
            </header>

            <div className="chat-body" ref={scrollerRef}>
              {messages.length === 0 && !sending && (
                <div className="chat-empty">
                  <Icons.Sparkles size={28} />
                  <p>Preguntame sobre tu negocio. Por ejemplo:</p>
                  <ul>
                    <li>"¿Cuánto vendí hoy?"</li>
                    <li>"¿Qué comprobantes ingresaron en el día?"</li>
                    <li>"¿Cómo vienen los envíos activos?"</li>
                  </ul>
                </div>
              )}

              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`chat-msg chat-msg-${m.role}${m.error ? ' chat-msg-error' : ''}`}
                >
                  <div className="chat-msg-bubble">{m.text}</div>
                  {m.error && <div className="chat-msg-error-tag">No se envió</div>}
                </div>
              ))}

              {sending && (
                <div className="chat-msg chat-msg-assistant">
                  <div className="chat-msg-bubble chat-msg-typing">
                    <span /><span /><span />
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="chat-error-bar" role="alert">{error}</div>
            )}

            <footer className="chat-footer">
              <textarea
                ref={textareaRef}
                className="chat-input"
                placeholder="Escribí tu pregunta…"
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, MAX_USER_MESSAGE_CHARS))}
                onKeyDown={onKeyDownTextarea}
                rows={1}
                disabled={sending}
                aria-label="Mensaje al asistente"
                maxLength={MAX_USER_MESSAGE_CHARS}
              />
              <button
                type="button"
                className="chat-send"
                title="Enviar (Enter)"
                aria-label="Enviar"
                onClick={send}
                disabled={!draft.trim() || sending}
              >
                <Icons.Send size={16} />
              </button>
            </footer>
            <div className="chat-foot-hint">
              Enter para enviar · Shift+Enter para salto de línea ·
              {draft.length > 0 && ` ${draft.length}/${MAX_USER_MESSAGE_CHARS}`}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
