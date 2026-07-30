/**
 * RelevoProveedorModal — ajuste manual del saldo del proveedor contra la realidad.
 *
 * Feature RELEVO (2026-07-29): el user con capability `proveedores.relevar`
 * (owner o admin por default) ajusta el saldo del proveedor al valor REAL.
 *
 * Casos de uso:
 *   - Pago olvidado en efectivo (le dimos plata que no cargamos).
 *   - Compra no cargada (nos mandó mercadería que no anotamos).
 *   - Devolución no registrada.
 *   - Mobiliario intercambiado ("nos dio una silla como parte de pago").
 *   - Cierre de cuenta con ajuste final para reconciliar.
 *
 * UX (rediseño 2026-07-30 post feedback Lucas "muy poco estético"):
 *   1. Card saldo actual en USD (readonly) con hint semántico.
 *   2. Input saldo nuevo — grande, acepta negativos.
 *   3. Delta panel tinted según signo de la DEUDA:
 *      - delta+ = MÁS deuda = rojo (mala noticia)
 *      - delta- = MENOS deuda = verde (buena noticia)
 *      OJO: al revés que en cajas (donde + es bueno). En proveedores
 *      "saldo" = deuda.
 *   4. Nota obligatoria min 10 chars con contador visible.
 *   5. Warning banner amber "no impacta otros proveedores ni Dashboard".
 *
 * Todo en USD (deuda del proveedor se lleva siempre en USD por fórmula
 * canónica de saldoProveedor.js — no hay selector de moneda ni TC).
 *
 * Backend: ver `backend/src/routes/proveedores.js` handler POST /:id/relevo,
 * `backend/src/schemas/proveedores.js:proveedorRelevoSchema` y helper
 * `backend/src/lib/saldoProveedor.js` (SALDO_CASE_M consume relevo_incremento
 * y relevo_reduccion — 2 tipos porque monto tiene CHECK ≥ 0).
 *
 * Convención del saldo:
 *   - Positivo = les debemos al proveedor (deuda pendiente).
 *   - Negativo = el proveedor nos debe (adelanto entregado sin mercadería).
 */
import { useEffect, useRef, useState, useMemo } from 'react';
import useModal from '../lib/useModal';
import { Icons } from './Icons';
import { proveedores as proveedoresApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { friendlyError } from '../lib/friendlyError';

function todayISO() { return new Date().toLocaleDateString('sv'); }

// Formato de número con separadores locales — siempre USD para proveedores.
function fmtMoneyUsd(n) {
  const val = Number(n || 0).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `USD ${val}`;
}

// Hint semántico del saldo actual — clarifica la convención al operador.
function saldoActualHint(n) {
  if (n > 0) return 'Positivo — nosotros le debemos al proveedor.';
  if (n < 0) return 'Negativo — el proveedor nos debe (adelanto entregado).';
  return 'Cuenta en cero.';
}

export default function RelevoProveedorModal({ proveedor, onClose, onSaved }) {
  const { toast } = useToast();

  // Estado del form
  const [fecha, setFecha]                 = useState(todayISO());
  const [saldoNuevoStr, setSaldoNuevoStr] = useState('');
  const [nota, setNota]                   = useState('');
  const [saving, setSaving]               = useState(false);
  const [error, setError]                 = useState(null);

  const overlayRef = useRef(null);
  useModal({ open: true, onClose, overlayRef });

  const saldoActual = Number(proveedor?.saldo_usd || 0);
  const saldoNuevoNum = saldoNuevoStr === '' || saldoNuevoStr === '-'
    ? null
    : Number(saldoNuevoStr);

  // Delta calculado en vivo (null si saldo_nuevo no válido).
  const delta = useMemo(() => {
    if (saldoNuevoNum === null || isNaN(saldoNuevoNum)) return null;
    return Math.round((saldoNuevoNum - saldoActual) * 100) / 100;
  }, [saldoNuevoNum, saldoActual]);

  // Validaciones para habilitar el botón.
  const notaTrim = nota.trim();
  const notaOk = notaTrim.length >= 10 && notaTrim.length <= 500;
  const deltaOk = delta !== null && delta !== 0;
  const formOk = notaOk && deltaOk && !saving;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!formOk) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        fecha,
        saldo_nuevo_usd: saldoNuevoNum,
        nota: notaTrim,
      };
      const res = await proveedoresApi.relevarProveedor(proveedor.id, body);
      toast({
        type: 'success',
        title: 'Relevo registrado',
        message: `Saldo ajustado ${fmtMoneyUsd(res.saldo_anterior)} → ${fmtMoneyUsd(res.saldo_nuevo)}`,
      });
      if (onSaved) onSaved(res);
      onClose();
    } catch (err) {
      setError(friendlyError(err));
      setSaving(false);
    }
  }

  if (!proveedor) return null;

  // Semántica INVERTIDA vs cajas (acá "saldo" = deuda):
  //   - delta > 0 → aumenta la deuda → rojo (mala noticia)
  //   - delta < 0 → reduce la deuda → verde (buena noticia)
  const deltaPanelClass = delta === null || delta === 0
    ? 'relevo-delta-panel'
    : delta > 0 ? 'relevo-delta-panel is-neg' : 'relevo-delta-panel is-pos';
  const deltaSign = delta === null || delta === 0 ? '' : delta > 0 ? '+' : '';

  return (
    <div className="modal-overlay" ref={overlayRef} onMouseDown={(e) => {
      if (e.target === overlayRef.current) onClose();
    }}>
      <div className="modal u-mw-520" role="dialog" aria-labelledby="relevo-prov-title">
        <div className="modal-hd">
          <div>
            <h3 id="relevo-prov-title">Relevo de saldo</h3>
            <div className="page-sub">{proveedor.nombre}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar" title="Cerrar">
            <Icons.X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body relevo-body">
          {/* Saldo actual */}
          <div className="relevo-saldo-actual">
            <div className="relevo-saldo-label">Saldo actual (según sistema)</div>
            <div className="relevo-saldo-value mono">{fmtMoneyUsd(saldoActual)}</div>
            <div className="relevo-saldo-hint">{saldoActualHint(saldoActual)}</div>
          </div>

          {/* Fecha */}
          <div className="field">
            <label className="field-label" htmlFor="relevo-prov-fecha">Fecha del relevo</label>
            <input
              id="relevo-prov-fecha"
              type="date"
              className="input"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              required
            />
          </div>

          {/* Saldo nuevo */}
          <div className="field">
            <label className="field-label" htmlFor="relevo-prov-saldo-nuevo">
              Saldo nuevo en USD (según la realidad) <span className="u-color-neg">*</span>
            </label>
            <input
              id="relevo-prov-saldo-nuevo"
              type="number"
              inputMode="decimal"
              step="0.01"
              className="input mono"
              value={saldoNuevoStr}
              onChange={(e) => setSaldoNuevoStr(e.target.value)}
              placeholder={String(saldoActual)}
              autoFocus
            />
            <div className="muted tiny">
              Puede ser negativo (adelantos entregados sin mercadería recibida).
            </div>
          </div>

          {/* Delta calculado */}
          {delta !== null && (
            <div className={deltaPanelClass}>
              <div className="relevo-delta-label">Diferencia calculada</div>
              <div className={`relevo-delta-value mono ${delta > 0 ? 'u-color-neg' : delta < 0 ? 'u-color-pos' : ''}`}>
                {deltaSign}{fmtMoneyUsd(delta)}
              </div>
              {delta > 0 && (
                <div className="relevo-delta-hint">Aumenta lo que le debemos al proveedor.</div>
              )}
              {delta < 0 && (
                <div className="relevo-delta-hint">Reduce lo que le debemos al proveedor.</div>
              )}
              {delta === 0 && (
                <div className="relevo-delta-hint u-color-warn">
                  Sin diferencia — no hay ajuste que registrar.
                </div>
              )}
            </div>
          )}

          {/* Nota */}
          <div className="field">
            <label className="field-label" htmlFor="relevo-prov-nota">
              Motivo del relevo <span className="u-color-neg">*</span>
            </label>
            <textarea
              id="relevo-prov-nota"
              className="input u-textarea-vcenter"
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Ej: Pago olvidado a Kevin del 20/07 en efectivo por USD 300"
              rows={3}
              maxLength={500}
              required
            />
            <div className="muted tiny">
              Mínimo 10 caracteres. Aparece en el historial y audit trail.
              {' '}
              <span className={notaTrim.length < 10 ? 'u-color-warn' : ''}>
                ({notaTrim.length}/500)
              </span>
            </div>
          </div>

          {/* Warning informativo */}
          <div className="relevo-warning-banner">
            <Icons.Alert size={14} />
            <div>
              Este ajuste <strong>no impacta otros proveedores</strong>, cajas ni
              KPIs del Dashboard (cobrado / pagado del mes). Queda registrado en el
              historial de esta cuenta con badge distintivo &quot;Relevo&quot;.
            </div>
          </div>

          {/* Error del backend */}
          {error && (
            <div className="u-color-neg-fs-13-mt-8">{error}</div>
          )}
        </form>

        <div className="modal-ft">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!formOk}
            onClick={handleSubmit}
          >
            {saving ? 'Registrando…' : 'Confirmar relevo'}
          </button>
        </div>
      </div>
    </div>
  );
}
