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
export default function ExitoModal({ state, onClose, onDescargar, pdfLoading }) {
  if (!state.open) return null;
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="exito-modal-title" style={{ zIndex: 600 }}
         onClick={onClose}>
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
        </div>
        <div className="modal-ft" style={{ justifyContent: 'center', gap: 12 }}>
          <button className="btn btn-primary" onClick={onClose}
                  autoFocus style={{ minWidth: 110, background: 'var(--accent)' }}>OK</button>
          <button className="btn"
                  style={{ minWidth: 200, background: 'var(--neg)', color: '#fff', border: 0, opacity: pdfLoading ? 0.7 : 1 }}
                  disabled={pdfLoading}
                  onClick={() => onDescargar(state.venta)}>
            {pdfLoading ? 'Generando…' : 'Descargar comprobante'}
          </button>
        </div>
      </div>
    </div>
  );
}
