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
export default function DiffModal({ state, onClose }) {
  if (!state.open) return null;
  const dif = state.dif;
  const aFavor = dif > 0;
  const close = (aceptado) => {
    const r = state.resolve;
    onClose();
    if (r) r(aceptado);
  };
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="diff-modal-title" style={{ zIndex: 600 }}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div className="modal-body" style={{ padding: '32px 28px 18px', textAlign: 'left' }}>
          {/* Icono de warning grande, centrado */}
          <div style={{ textAlign: 'center', marginBottom: 18 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 76, height: 76, borderRadius: '50%',
              border: '3px solid var(--warn, #d97706)', color: 'var(--warn, #d97706)',
              fontSize: 38, fontWeight: 700, lineHeight: 1,
            }}>!</div>
          </div>
          <h2 id="diff-modal-title" style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px', color: 'var(--text)' }}>
            ⚠️ Diferencia en métodos de pago
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.5, margin: '0 0 18px' }}>
            Los métodos de pago no suman exactamente el monto requerido.
          </p>
          <div style={{ borderTop: '1px solid var(--hairline)', borderBottom: '1px solid var(--hairline)', padding: '14px 0' }}>
            <div className="flex-between" style={{ fontSize: 14, marginBottom: 8 }}>
              <strong>Total de la venta:</strong>
              <span className="mono" style={{ color: 'var(--accent)', fontWeight: 700 }}>u$s {state.items.toFixed(2)}</span>
            </div>
            <div className="flex-between" style={{ fontSize: 14, marginBottom: 8 }}>
              <strong>Total pagado:</strong>
              <span className="mono pos" style={{ fontWeight: 700 }}>u$s {state.cubierto.toFixed(2)}</span>
            </div>
            <div className="flex-between" style={{ fontSize: 14 }}>
              <strong>{aFavor ? 'Sobrante:' : 'Restante:'}</strong>
              <span className="mono" style={{ fontWeight: 700, color: aFavor ? 'var(--pos)' : 'var(--neg)' }}>
                u$s {aFavor ? '+' : '-'}{Math.abs(dif).toFixed(2)}
              </span>
            </div>
          </div>
          <div style={{
            marginTop: 16, padding: '12px 14px', background: 'rgba(122, 162, 247, 0.08)',
            border: '1px solid rgba(122, 162, 247, 0.25)', borderRadius: 8, fontSize: 13, lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: 4 }}>¿Qué quieres hacer?</div>
            <div style={{ color: 'var(--text)' }}>· <strong>Corregir:</strong> ajustar los métodos de pago</div>
            <div style={{ color: 'var(--text)' }}>· <strong>Aceptar igual:</strong> guardar y sumar la diferencia al profit</div>
          </div>
        </div>
        <div className="modal-ft" style={{ justifyContent: 'center', gap: 12 }}>
          <button className="btn btn-ghost" onClick={() => close(false)} style={{ minWidth: 130 }}>Corregir</button>
          <button className="btn btn-primary" onClick={() => close(true)} autoFocus style={{ minWidth: 130, background: 'var(--pos)' }}>Aceptar igual</button>
        </div>
      </div>
    </div>
  );
}
