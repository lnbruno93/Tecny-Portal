// ExitoModal — modal de éxito después de guardar una venta. Muestra el
// checkmark verde + opción de descargar el comprobante PDF.
//
// El PDF se genera con import dinámico (lazy) para no inflar el bundle
// principal: la lib jsPDF + autoTable solo se carga cuando el usuario
// hace click en "Descargar comprobante", lo cual ocurre solo después de
// confirmar una venta.
//
// Estado esperado en el padre:
//   const [exitoModal, setExitoModal] = useState({ open: false, venta: null });
//
// Props:
//   state         — { open, venta }
//   onClose       — fn() para cerrar el modal
//   onDescargar   — fn(venta) que dispara la descarga del PDF.
//                   Es async; el componente NO maneja su propio loading.
//                   El padre controla `pdfLoading` para sincronizar con
//                   otros UI elements (ej. el toast de error).
//   pdfLoading    — booleano. Si true, deshabilita el botón de descarga
//                   y muestra "Generando…".
//
// U2 auditoría 2026-06: useModal aplicado — Esc cierra el modal (atajo
// estándar), body scroll lock + foco inicial al botón OK (que ya tiene autoFocus).
import { useRef } from 'react';
import useModal from '../../lib/useModal';

export default function ExitoModal({ state, onClose, onDescargar, pdfLoading, onReenviarEmail }) {
  const overlayRef = useRef(null);
  useModal({ open: state.open, onClose, overlayRef });
  if (!state.open) return null;
  // #475 — mostrar entry-point del reenvío por email solo si la venta tiene
  // email cargado (cliente_email viene del payload o del contacto vinculado).
  const ventaEmail = state.venta?.cliente_email || '';
  return (
    <div ref={overlayRef} className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="exito-modal-title" style={{ zIndex: 600 }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-body" style={{ padding: '36px 28px 18px', textAlign: 'center' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 88, height: 88, borderRadius: '50%',
            border: '3px solid var(--pos)', color: 'var(--pos)',
            marginBottom: 24,
          }}>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <h2 id="exito-modal-title" style={{ fontSize: 28, fontWeight: 700, margin: '0 0 10px', color: 'var(--text)' }}>
            ¡Éxito!
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 15, margin: 0 }}>
            Venta guardada exitosamente.
          </p>
          {/* #475 — entry-point reenvío comprobante por mail. Solo aparece si
              hay email del cliente cargado. Si el operador ya pidió enviar el
              comprobante (checkbox del modal de venta), el backend ya lo
              despachó via setImmediate; el botón acá es para reenviar. */}
          {ventaEmail && onReenviarEmail && (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '14px 0 0' }}>
              Comprobante por mail a <strong>{ventaEmail}</strong>
            </p>
          )}
        </div>
        <div className="modal-ft" style={{ justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={onClose}
                  autoFocus style={{ minWidth: 110, background: 'var(--accent)' }}>OK</button>
          <button className="btn"
                  style={{ minWidth: 200, background: 'var(--neg)', color: '#fff', border: 0, opacity: pdfLoading ? 0.7 : 1 }}
                  disabled={pdfLoading}
                  onClick={() => onDescargar(state.venta)}>
            {pdfLoading ? 'Generando…' : 'Descargar comprobante'}
          </button>
          {ventaEmail && onReenviarEmail && (
            <button className="btn btn-ghost"
                    style={{ minWidth: 180 }}
                    onClick={() => onReenviarEmail(state.venta)}>
              Reenviar por mail
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
