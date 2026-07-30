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
 * UX (espejo de RelevoCajaModal):
 *   1. Muestra saldo actual del proveedor en USD (readonly).
 *   2. User ingresa `saldo_nuevo_usd` deseado.
 *   3. Sistema calcula y muestra el DELTA en vivo (color rojo si -, verde si +).
 *   4. Nota OBLIGATORIA (min 10 chars) — audit forense.
 *   5. Warning explicando que el relevo NO impacta otros proveedores ni
 *      el Dashboard (cobrado/pagado).
 *   6. Confirmar → POST /api/proveedores/:id/relevo.
 *
 * Backend: ver `backend/src/routes/proveedores.js` handler POST /:id/relevo,
 * `backend/src/schemas/proveedores.js:proveedorRelevoSchema` y la fórmula
 * canónica en `backend/src/lib/saldoProveedor.js` (SALDO_CASE_M consume los
 * 2 tipos nuevos: relevo_incremento + relevo_reduccion).
 *
 * Convención del saldo:
 *   - Positivo = les debemos al proveedor (deuda pendiente).
 *   - Negativo = el proveedor nos debe (adelanto entregado sin mercadería
 *     recibida aún). El backend NO aplica guardia "no negativo" — el relevo
 *     ES el ajuste, aceptando la realidad tal cual es.
 *
 * Diferencia con proveedor.js (POST /movimientos):
 *   - Movimiento manual: user ingresa monto + tipo (compra/pago).
 *   - Relevo: user ingresa saldo_nuevo, server deriva tipo + monto.
 *   - Movimiento: nota opcional. Relevo: OBLIGATORIA min 10 chars.
 *
 * Todo se hace en USD (moneda funcional del proveedor) — no hay TC porque
 * la deuda del proveedor se lleva siempre en USD (fórmula canónica).
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

  // Signo semántico del delta para deuda:
  //   - delta > 0 → aumenta lo que les debemos → color rojo (peor situación).
  //   - delta < 0 → reduce lo que les debemos → color verde (mejor situación).
  // OJO: al revés que en cajas (donde + es bueno). Acá `saldo` = deuda.
  const deltaColorClass = delta === null || delta === 0
    ? ''
    : delta > 0 ? 'u-color-neg' : 'u-color-pos';
  const deltaSign = delta === null || delta === 0 ? '' : delta > 0 ? '+' : '';

  return (
    <div className="modal-overlay" ref={overlayRef} onMouseDown={(e) => {
      if (e.target === overlayRef.current) onClose();
    }}>
      <div className="modal modal-md" role="dialog" aria-labelledby="relevo-prov-title">
        <div className="modal-hd">
          <h3 id="relevo-prov-title" className="u-m-0">Relevo de saldo — {proveedor.nombre}</h3>
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
              {fmtMoneyUsd(saldoActual)}
            </div>
            <div className="hint">
              {saldoActual > 0 && 'Positivo = les debemos.'}
              {saldoActual < 0 && 'Negativo = el proveedor nos debe (adelanto entregado).'}
              {saldoActual === 0 && 'Cuenta en cero.'}
            </div>
          </div>

          {/* Saldo nuevo (input) */}
          <div className="form-row">
            <label className="form-label" htmlFor="relevo-prov-saldo-nuevo">
              Saldo nuevo (según la realidad) <span className="req">*</span>
            </label>
            <input
              id="relevo-prov-saldo-nuevo"
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
              Ingresá el saldo REAL en USD. Puede ser negativo (adelantos
              entregados no recibidos como mercadería).
            </div>
          </div>

          {/* Delta calculado */}
          {delta !== null && (
            <div className="form-row relevo-delta-panel">
              <label className="form-label">Diferencia calculada</label>
              <div className={`mono ${deltaColorClass} relevo-delta-value`}>
                {deltaSign}{fmtMoneyUsd(delta)}
              </div>
              <div className="hint">
                {delta > 0 && 'Aumenta lo que les debemos (más deuda).'}
                {delta < 0 && 'Reduce lo que les debemos (menos deuda).'}
                {delta === 0 && (
                  <span className="u-color-warn">
                    El saldo nuevo es igual al actual. No hay ajuste que registrar.
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Nota (obligatoria) */}
          <div className="form-row">
            <label className="form-label" htmlFor="relevo-prov-nota">
              Motivo del relevo <span className="req">*</span>
            </label>
            <textarea
              id="relevo-prov-nota"
              className="input"
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              placeholder="Ej: Pago olvidado a Kevin del 20/07 en efectivo por USD 300 / Mercadería recibida sin cargar el 25/07"
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
              Este ajuste <strong>NO impacta otros proveedores</strong>, cajas,
              ni KPIs del Dashboard (cobrado / pagado del mes). Queda registrado
              en el historial de esta cuenta con badge distintivo &quot;Relevo&quot;.
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
