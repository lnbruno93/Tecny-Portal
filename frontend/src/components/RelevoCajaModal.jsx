/**
 * RelevoCajaModal — ajuste manual del saldo de una caja contra la realidad.
 *
 * Feature RELEVO (2026-07-29): el user con capability `cajas.relevar` (owner
 * o admin) ajusta el saldo de una caja al valor REAL (arqueo físico, pago
 * olvidado, gasto fuera del sistema, etc.).
 *
 * UX (rediseño 2026-07-30 post feedback Lucas "muy poco estético"):
 *   1. Muestra saldo actual en card destacada (fondo surface-2, monto grande).
 *   2. User ingresa `saldo_nuevo` deseado — input grande.
 *   3. Sistema calcula y muestra el DELTA en card tinted (bg verde si +, rojo si -)
 *      con hint semántico ("Ingresa a caja / Egresa de caja").
 *   4. Nota OBLIGATORIA (min 10 chars) — audit forense, con contador visible.
 *   5. Warning banner destacado (amber) explicando que el relevo NO impacta
 *      otras cajas ni Dashboard.
 *   6. Confirmar → POST /api/cajas/cajas/:id/relevo.
 *
 * Backend: ver `backend/src/routes/cajas.js` handler POST /:id/relevo y
 * `backend/src/schemas/cajas.js:cajaRelevoSchema`.
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

  const deltaPanelClass = delta === null || delta === 0
    ? 'relevo-delta-panel'
    : delta > 0 ? 'relevo-delta-panel is-pos' : 'relevo-delta-panel is-neg';
  const deltaSign = delta === null || delta === 0 ? '' : delta > 0 ? '+' : '';

  return (
    <div className="modal-overlay" ref={overlayRef} onMouseDown={(e) => {
      if (e.target === overlayRef.current) onClose();
    }}>
      <div className="modal u-mw-520" role="dialog" aria-labelledby="relevo-title">
        <div className="modal-hd">
          <div>
            <h3 id="relevo-title">Relevo de saldo</h3>
            <div className="page-sub">{caja.nombre} · {caja.moneda}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar" title="Cerrar">
            <Icons.X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body relevo-body">
          {/* Saldo actual — card destacada */}
          <div className="relevo-saldo-actual">
            <div className="relevo-saldo-label">Saldo actual (según sistema)</div>
            <div className="relevo-saldo-value mono">{fmtMoney(saldoActual, caja.moneda)}</div>
          </div>

          {/* Fecha */}
          <div className="field">
            <label className="field-label" htmlFor="relevo-fecha">Fecha del relevo</label>
            <input
              id="relevo-fecha"
              type="date"
              className="input"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              required
            />
          </div>

          {/* Saldo nuevo */}
          <div className="field">
            <label className="field-label" htmlFor="relevo-saldo-nuevo">
              Saldo nuevo (según la realidad) <span className="u-color-neg">*</span>
            </label>
            <input
              id="relevo-saldo-nuevo"
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
              Contá plata / verificá cuenta. Puede ser negativo (adelantos entregados).
            </div>
          </div>

          {/* Delta calculado — solo cuando hay valor */}
          {delta !== null && (
            <div className={deltaPanelClass}>
              <div className="relevo-delta-label">Diferencia calculada</div>
              <div className={`relevo-delta-value mono ${delta > 0 ? 'u-color-pos' : delta < 0 ? 'u-color-neg' : ''}`}>
                {deltaSign}{fmtMoney(delta, caja.moneda)}
              </div>
              {delta > 0 && (
                <div className="relevo-delta-hint">Ingreso a caja (aumenta el saldo).</div>
              )}
              {delta < 0 && (
                <div className="relevo-delta-hint">Egreso de caja (reduce el saldo).</div>
              )}
              {delta === 0 && (
                <div className="relevo-delta-hint u-color-warn">
                  Sin diferencia — no hay ajuste que registrar.
                </div>
              )}
            </div>
          )}

          {/* TC (solo ARS/UYU) */}
          {requiereTc && delta !== null && delta !== 0 && (
            <div className="field">
              <label className="field-label" htmlFor="relevo-tc">
                Tipo de cambio ({caja.moneda}/USD) <span className="u-color-neg">*</span>
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
              <div className="muted tiny">Se usa para el equivalente USD histórico del movimiento.</div>
            </div>
          )}

          {/* Nota */}
          <div className="field">
            <label className="field-label" htmlFor="relevo-nota">
              Motivo del relevo <span className="u-color-neg">*</span>
            </label>
            <textarea
              id="relevo-nota"
              className="input u-textarea-vcenter"
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Ej: Encontré USD 500 más en el cajón (arqueo del mes)"
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
              Este ajuste <strong>no impacta otras cajas</strong>, cuentas corrientes
              ni KPIs del Dashboard (cobrado / pagado del mes). Queda registrado en el
              historial de esta caja con badge distintivo &quot;Relevo&quot;.
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
