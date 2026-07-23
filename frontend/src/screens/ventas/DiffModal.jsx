// DiffModal — modal de confirmación cuando los métodos de pago NO suman
// exactamente el total de la venta. Da 2 opciones:
//   - "Corregir": vuelve al form (resuelve `false`).
//   - "Aceptar igual": guarda la venta y suma la diferencia al profit
//     (resuelve `true`).
//
// No usa el ConfirmModal global porque necesita el desglose visual con
// colores (sobrante en verde / restante en rojo) y un layout específico.
//
// Estado esperado en el padre:
//   const [diffModal, setDiffModal] = useState({
//     open: false, items: 0, cubierto: 0, dif: 0, resolve: null
//   });
//
// El campo `resolve` es la promesa pending que el padre resuelve cuando
// el usuario elige una opción. La promesa se setea desde el flow de submit
// de la venta (await new Promise(resolve => setDiffModal({ ..., resolve }))).
//
// U2 auditoría 2026-06: useModal aplicado — Esc cancela (resuelve con false,
// igual que "Corregir"), body lock activo mientras está abierto, foco inicial
// va al botón primary "Aceptar igual" (que ya tenía autoFocus).
import { useRef } from 'react';
import useModal from '../../lib/useModal';

export default function DiffModal({ state, onClose }) {
  const overlayRef = useRef(null);
  // Esc = "Corregir" (resolver false). Este es el comportamiento más seguro
  // para un modal de confirmación destructiva.
  const handleEscClose = () => {
    const r = state.resolve;
    onClose();
    if (r) r(false);
  };
  useModal({ open: state.open, onClose: handleEscClose, overlayRef });
  if (!state.open) return null;
  const dif = state.dif;
  const aFavor = dif > 0;
  const close = (aceptado) => {
    const r = state.resolve;
    onClose();
    if (r) r(aceptado);
  };
  return (
    <div ref={overlayRef} className="modal-overlay u-z-600" role="dialog" aria-modal="true" aria-labelledby="diff-modal-title">
      <div className="modal u-mw-520" onClick={e => e.stopPropagation()}>
        <div className="modal-body u-diff-modal-body">
          {/* Icono de warning grande, centrado */}
          <div className="u-diff-icon-wrap">
            <div className="u-diff-icon-circle">!</div>
          </div>
          <h2 id="diff-modal-title" className="u-diff-title">
            ⚠️ Diferencia en métodos de pago
          </h2>
          <p className="u-diff-subtitle">
            Los métodos de pago no suman exactamente el monto requerido.
          </p>
          <div className="u-diff-breakdown-box">
            <div className="flex-between u-fs-14-mb-8">
              <strong>Total de la venta:</strong>
              <span className="mono u-color-accent-fw-700">u$s {state.items.toFixed(2)}</span>
            </div>
            <div className="flex-between u-fs-14-mb-8">
              <strong>Total pagado:</strong>
              <span className="mono pos u-fw-700">u$s {state.cubierto.toFixed(2)}</span>
            </div>
            <div className="flex-between u-fs-14">
              <strong>{aFavor ? 'Sobrante:' : 'Restante:'}</strong>
              <span className={`mono u-fw-700 ${aFavor ? 'u-color-pos' : 'u-color-neg'}`}>
                u$s {aFavor ? '+' : '-'}{Math.abs(dif).toFixed(2)}
              </span>
            </div>
          </div>
          <div className="u-diff-cta-box">
            <div className="u-diff-cta-title">¿Qué quieres hacer?</div>
            <div className="u-color-text">· <strong>Corregir:</strong> ajustar los métodos de pago</div>
            <div className="u-color-text">· <strong>Aceptar igual:</strong> guardar y sumar la diferencia al profit</div>
          </div>
        </div>
        <div className="modal-ft u-modal-ft-center">
          <button className="btn btn-ghost u-mw-min-130" onClick={() => close(false)}>Corregir</button>
          <button className="btn btn-primary u-btn-accept-pos" onClick={() => close(true)} autoFocus>Aceptar igual</button>
        </div>
      </div>
    </div>
  );
}
