/**
 * RelevoCajaModal — ajuste manual del saldo de una caja contra la realidad.
 *
 * Feature RELEVO (2026-07-29): el user con permission `cajas.relevar` (owner
 * o admin) ajusta el saldo de una caja al valor REAL (arqueo físico, pago
 * olvidado, gasto fuera del sistema, etc.).
 *
 * UX:
 *   1. Muestra saldo actual de la caja (readonly).
 *   2. User ingresa `saldo_nuevo` deseado.
 *   3. Sistema calcula y muestra el DELTA en vivo (color rojo si -,
 *      verde si +).
 *   4. Nota OBLIGATORIA (min 10 chars) — audit forense.
 *   5. Warning explicando que el relevo NO genera movimientos en otras
 *      cajas ni impacta el Dashboard.
 *   6. Confirmar → POST /api/cajas/cajas/:id/relevo.
 *
 * Backend: ver `backend/src/routes/cajas.js` handler POST /:id/relevo y
 * `backend/src/schemas/cajas.js:cajaRelevoSchema`.
 *
 * Signo del saldo_nuevo:
 *   - Puede ser negativo (adelanto entregado no registrado).
 *   - El backend NO aplica la guardia "no permitir negativo" que sí aplica
 *     al ajuste manual — el relevo ES el ajuste, aceptando la realidad.
 *
 * Cajas ARS/UYU: TC requerido (para calcular monto_usd del movimiento).
 * Cajas USD/USDT: TC no aplica (el saldo YA está en USD).
 */
import { useEffect, useRef, useState, useMemo } from 'react';
import useModal from '../lib/useModal';
import { Icons } from './Icons';
import { cajas as cajasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { friendlyError } from '../lib/friendlyError';

function todayISO() { return new Date().toLocaleDateString('sv'); }

const REQUIERE_TC = ['ARS', 'UYU'];

// Formato de número con separadores locales.
function fmtMoney(n, moneda) {
  const val = Number(n || 0).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${moneda} ${val}`;
}

export default function RelevoCajaModal({ caja, onClose, onSaved }) {
  const { toast } = useToast();

  // Estado del form
  const [fecha, setFecha]           = useState(todayISO());
  const [saldoNuevoStr, setSaldoNuevoStr] = useState('');
  const [nota, setNota]             = useState('');
  const [tc, setTc]                 = useState('');
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState(null);

  const overlayRef = useRef(null);
  useModal({ open: true, onClose, overlayRef });

  const requiereTc = REQUIERE_TC.includes(caja?.moneda);
  const saldoActual = Number(caja?.saldo_actual || 0);
  const saldoNuevoNum = saldoNuevoStr === '' || saldoNuevoStr === '-'
    ? null
    : Number(saldoNuevoStr);

  // Delta calculado en vivo (null si saldo_nuevo no válido).
  const delta = useMemo(() => {
    if (saldoNuevoNum === null || isNaN(saldoNuevoNum)) return null;
    // Round a 2 decimales para evitar drift por float.
    return Math.round((saldoNuevoNum - saldoActual) * 100) / 100;
  }, [saldoNuevoNum, saldoActual]);

  // Validaciones para habilitar el botón.
  const notaTrim = nota.trim();
  const notaOk = notaTrim.length >= 10 && notaTrim.length <= 500;
  const deltaOk = delta !== null && delta !== 0;
  const tcOk = !requiereTc || (Number(tc) > 0);
  const formOk = notaOk && deltaOk && tcOk && !saving;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!formOk) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        fecha,
        saldo_nuevo: saldoNuevoNum,
        nota: notaTrim,
      };
      if (requiereTc) body.tc = Number(tc);
      const res = await cajasApi.relevarCaja(caja.id, body);
      toast({
        type: 'success',
        title: 'Relevo registrado',
        message: `Saldo ajustado ${fmtMoney(res.saldo_anterior, caja.moneda)} → ${fmtMoney(res.saldo_nuevo, caja.moneda)}`,
      });
      if (onSaved) onSaved(res);
      onClose();
    } catch (err) {
      setError(friendlyError(err));
      setSaving(false);
    }
  }

  if (!caja) return null;

  const deltaColorClass = delta === null
    ? ''
    : delta > 0 ? 'u-color-pos' : 'u-color-neg';
  const deltaSign = delta === null || delta === 0 ? '' : delta > 0 ? '+' : '';

  return (
    <div className="modal-overlay" ref={overlayRef} onMouseDown={(e) => {
      if (e.target === overlayRef.current) onClose();
    }}>
      <div className="modal modal-md" role="dialog" aria-labelledby="relevo-title">
        <div className="modal-hd">
          <h3 id="relevo-title" className="u-m-0">Relevo de saldo — {caja.nombre}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <Icons.X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-bd">
          {/* Fecha */}
          <div className="form-row">
            <label className="form-label">Fecha del relevo</label>
            <input
              type="date"
              className="input"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              required
            />
          </div>

          {/* Saldo actual (readonly) */}
          <div className="form-row">
            <label className="form-label">Saldo actual (según sistema)</label>
            <div className="u-fw-600-fs-14-mb-4 mono">
              {fmtMoney(saldoActual, caja.moneda)}
            </div>
          </div>

          {/* Saldo nuevo (input) */}
          <div className="form-row">
            <label className="form-label" htmlFor="relevo-saldo-nuevo">
              Saldo nuevo (según la realidad) <span className="req">*</span>
            </label>
            <input
              id="relevo-saldo-nuevo"
              type="number"
              inputMode="decimal"
              step="0.01"
              className="input mono"
              value={saldoNuevoStr}
              onChange={(e) => setSaldoNuevoStr(e.target.value)}
              placeholder={`Ej: ${saldoActual}`}
              autoFocus
            />
            <div className="hint">
              Ingresá el saldo REAL de la caja (contá plata / verificá cuenta).
              Puede ser negativo (adelantos entregados no registrados).
            </div>
          </div>

          {/* Delta calculado */}
          {delta !== null && (
            <div className="form-row relevo-delta-panel">
              <label className="form-label">Diferencia calculada</label>
              <div className={`mono ${deltaColorClass} relevo-delta-value`}>
                {deltaSign}{fmtMoney(delta, caja.moneda)}
              </div>
              {delta === 0 && (
                <div className="hint u-color-warn">
                  El saldo nuevo es igual al actual. No hay ajuste que registrar.
                </div>
              )}
            </div>
          )}

          {/* TC (solo ARS/UYU) */}
          {requiereTc && delta !== null && delta !== 0 && (
            <div className="form-row">
              <label className="form-label" htmlFor="relevo-tc">
                Tipo de cambio ({caja.moneda}/USD) <span className="req">*</span>
              </label>
              <input
                id="relevo-tc"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0.01"
                className="input mono"
                value={tc}
                onChange={(e) => setTc(e.target.value)}
                placeholder="Ej: 1200"
                required
              />
              <div className="hint">
                Usado para el equivalente USD del movimiento (histórico).
              </div>
            </div>
          )}

          {/* Nota (obligatoria) */}
          <div className="form-row">
            <label className="form-label" htmlFor="relevo-nota">
              Motivo del relevo <span className="req">*</span>
            </label>
            <textarea
              id="relevo-nota"
              className="input"
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Ej: Arqueo mensual — encontré USD 500 más en el cajón / Pago olvidado a Kevin del 25/07 en efectivo"
              rows={3}
              maxLength={500}
              required
            />
            <div className="hint">
              Mínimo 10 caracteres. Aparece en el historial y audit trail.
              {' '}
              <span className={notaTrim.length < 10 ? 'u-color-warn' : 'u-color-muted'}>
                ({notaTrim.length}/500)
              </span>
            </div>
          </div>

          {/* Warning informativo */}
          <div className="hint relevo-warning-banner">
            <Icons.Alert size={14} />
            <div>
              Este ajuste <strong>NO impacta otras cajas</strong>, cuentas
              corrientes, ni KPIs del Dashboard (cobrado / pagado del mes).
              Queda registrado en el historial de esta caja con badge distintivo
              &quot;Relevo&quot;.
            </div>
          </div>

          {/* Error del backend */}
          {error && (
            <div className="u-color-neg-fs-13-mt-8">{error}</div>
          )}

          {/* Botones */}
          <div className="modal-ft">
            <button type="button" className="btn" onClick={onClose} disabled={saving}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary" disabled={!formOk}>
              {saving ? 'Registrando…' : 'Confirmar relevo'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
