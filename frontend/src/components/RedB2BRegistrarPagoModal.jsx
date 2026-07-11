// Red B2B F4 — modal para registrar pago de una operación cross-tenant.
//
// Inputs:
//   - monto_usd (default saldo restante de la op)
//   - moneda_pago: radio USD / ARS
//   - tc_pago (default tc_used de la op)
//   - monto_pago: auto-calculado según moneda × tc (read-only display)
//   - caja_id: dropdown de cajas del propio tenant con moneda compatible
//   - fecha: default hoy
//
// Side se infiere de op.my_side. Preview de diferencia cambiaria si
// moneda_pago=ARS y tc_pago≠tc_venta (resaltar gain/loss).
//
// 2026-06-28 PR-A audit Red B2B (UX-2 BLOCKER): chrome del modal migrado
// del legacy `modal-backdrop / modal-content` (clases inexistentes en
// styles.css → render roto) al pattern del design system
// `modal-overlay > modal` con `modal-hd / modal-body / modal-ft` (mismo
// patrón que ConfirmModal/VentaB2BModal). Inputs/labels usan `field-label`
// + `input` para tipografía coherente. useModal aplicado para Esc cerrar
// + body scroll lock + focus trap (a11y W3C APG Dialog).

import { useState, useEffect, useMemo, useRef } from 'react';
import { redB2b, cajas as cajasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { fmtMoney } from '../lib/format';
import { Icons } from './Icons';
import useModal from '../lib/useModal';

const TODAY_ISO = () => new Date().toISOString().slice(0, 10);

export default function RedB2BRegistrarPagoModal({ operation, restanteUsd, onClose, onSuccess }) {
  const { toast } = useToast();

  const [monedaPago, setMonedaPago] = useState('USD');
  const [montoUsd, setMontoUsd] = useState(String(restanteUsd || ''));
  const [tcPago, setTcPago] = useState(String(operation?.tc_used || ''));
  const [cajaId, setCajaId] = useState('');
  const [fecha, setFecha] = useState(TODAY_ISO());
  const [notas, setNotas] = useState('');
  const [saving, setSaving] = useState(false);
  const [cajasList, setCajasList] = useState([]);

  // COR-1 audit 2026-07-06 (frontend integration 2026-07-11 P1-3 PR):
  // Idempotency-Key generado UNA VEZ al abrir el modal — cada intento de
  // submit (incluso retry por error transient o doble-click) usa el MISMO
  // UUID. El backend con la misma key devuelve el pago original (200 en vez
  // de crear duplicado). El key se genera con useState + inicializador
  // perezoso para que crypto.randomUUID() solo se ejecute en el 1er render
  // (React garantiza que el initializer no re-corre en re-renders).
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  // Filtrar cajas compatibles con moneda_pago.
  const cajasCompat = useMemo(() => {
    if (monedaPago === 'ARS') return cajasList.filter((c) => c.moneda === 'ARS');
    return cajasList.filter((c) => c.moneda === 'USD' || c.moneda === 'USDT');
  }, [cajasList, monedaPago]);

  useEffect(() => {
    // Auditoría 2026-06-30 Q-02/Q-03: `cajas.listMetodosPago()` devuelve array
    // plano. Antes había defensive logic `r.metodos_pago || r.cajas` que
    // ocultaba un mismatch del mock en RedB2B.test.jsx — ahora alineado.
    cajasApi.listMetodosPago()
      .then((r) => setCajasList(Array.isArray(r) ? r : []))
      .catch(() => setCajasList([]));
  }, []);

  // Reset caja_id si la moneda cambia y la caja seleccionada ya no es compat.
  useEffect(() => {
    if (cajaId && !cajasCompat.some((c) => String(c.id) === String(cajaId))) {
      setCajaId('');
    }
  }, [cajasCompat, cajaId]);

  // Calcular monto_pago derivado.
  const montoPagoCalc = useMemo(() => {
    const usd = Number(montoUsd) || 0;
    if (monedaPago === 'USD') return usd;
    const tc = Number(tcPago) || 0;
    return tc > 0 ? Math.round(usd * tc * 100) / 100 : 0;
  }, [montoUsd, monedaPago, tcPago]);

  // Diferencia cambiaria preview (si ARS y tc difiere del tc_used de la venta).
  const diferenciaPreview = useMemo(() => {
    if (monedaPago !== 'ARS') return 0;
    const usd = Number(montoUsd) || 0;
    const tcVenta = Number(operation?.tc_used) || 0;
    const tcPagoN = Number(tcPago) || 0;
    if (tcVenta <= 0 || tcPagoN <= 0) return 0;
    return Math.round((usd * tcPagoN - usd * tcVenta) * 100) / 100;
  }, [monedaPago, montoUsd, tcPago, operation]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!cajaId) {
      toast.error('Seleccioná una caja');
      return;
    }
    setSaving(true);
    try {
      await redB2b.pagos.register(operation.id, {
        monto_usd: Number(montoUsd),
        moneda_pago: monedaPago,
        monto_pago: montoPagoCalc,
        tc_pago: Number(tcPago),
        caja_id: Number(cajaId),
        side: operation.my_side,
        fecha,
        notas: notas.trim() || undefined,
      }, { idempotencyKey });
      toast.success('Pago registrado');
      onSuccess && onSuccess();
      onClose();
    } catch (err) {
      toast.error(err.message || 'No pudimos registrar el pago');
    } finally {
      setSaving(false);
    }
  }

  // useModal: Esc cierra + body scroll lock + focus trap. Mismo patrón
  // que VentaB2BModal/ConfirmModal — sin esto el modal era inaccesible
  // por teclado (foco se perdía al sidebar).
  const overlayRef = useRef(null);
  useModal({ open: true, onClose, overlayRef });

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rb2b-pago-title"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <h3 id="rb2b-pago-title">
            Registrar pago · operación #{operation?.id}
          </h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar modal">
            <Icons.X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <p className="muted" style={{ fontSize: 13, marginTop: 0, marginBottom: 14 }}>
              Saldo restante: <strong>{fmtMoney(restanteUsd, 'USD')}</strong>{' '}
              (de {fmtMoney(operation?.total_usd, 'USD')}, TC venta: {operation?.tc_used})
            </p>

            <div className="field" style={{ marginBottom: 12 }}>
              <label className="field-label" htmlFor="monto-usd">
                Monto a pagar (USD)
              </label>
              <input
                id="monto-usd"
                className="input"
                type="number"
                step="0.01"
                min="0"
                max={restanteUsd}
                value={montoUsd}
                onChange={(e) => setMontoUsd(e.target.value)}
                required
              />
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Moneda del pago</span>
              <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="radio"
                    name="moneda_pago"
                    value="USD"
                    checked={monedaPago === 'USD'}
                    onChange={() => setMonedaPago('USD')}
                  />
                  USD (sin re-cálculo)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="radio"
                    name="moneda_pago"
                    value="ARS"
                    checked={monedaPago === 'ARS'}
                    onChange={() => setMonedaPago('ARS')}
                  />
                  ARS (re-cálculo con TC del día)
                </label>
              </div>
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <label className="field-label" htmlFor="tc-pago">
                TC del pago {monedaPago === 'USD' && <span className="muted">(no aplica)</span>}
              </label>
              <input
                id="tc-pago"
                className="input mono"
                type="number"
                step="0.0001"
                min="0"
                value={tcPago}
                onChange={(e) => setTcPago(e.target.value)}
                disabled={monedaPago === 'USD'}
                required
              />
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <label className="field-label">
                Monto a cobrar/pagar ({monedaPago})
              </label>
              <input
                className="input mono"
                type="text"
                value={fmtMoney(montoPagoCalc, monedaPago)}
                readOnly
                style={{ background: 'var(--bg-subtle, var(--surface-2))' }}
              />
            </div>

            {monedaPago === 'ARS' && Math.abs(diferenciaPreview) >= 0.01 && (
              <div
                style={{
                  padding: 10,
                  background: diferenciaPreview > 0
                    ? 'var(--green-bg, rgba(34, 197, 94, 0.08))'
                    : 'var(--red-bg, rgba(239, 68, 68, 0.08))',
                  color: diferenciaPreview > 0
                    ? 'var(--pos, #16a34a)'
                    : 'var(--neg, #dc2626)',
                  borderRadius: 6,
                  marginBottom: 12,
                  fontSize: 13,
                }}
              >
                <strong>{diferenciaPreview > 0 ? 'Ganancia cambiaria' : 'Pérdida cambiaria'}: </strong>
                {fmtMoney(Math.abs(diferenciaPreview), 'ARS')}
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  Se asentará un movimiento en el módulo Cambios de Divisa de tu tenant.
                </div>
              </div>
            )}

            <div className="field" style={{ marginBottom: 12 }}>
              <label className="field-label" htmlFor="caja-id">
                Caja {operation?.my_side === 'seller' ? 'receptora (donde entra el dinero)' : 'emisora (de donde sale)'}
              </label>
              <select
                id="caja-id"
                className="input"
                value={cajaId}
                onChange={(e) => setCajaId(e.target.value)}
                required
              >
                <option value="">— Seleccioná una caja —</option>
                {cajasCompat.map((c) => (
                  <option key={c.id} value={c.id}>{c.nombre} ({c.moneda})</option>
                ))}
              </select>
              {cajasCompat.length === 0 && (
                <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  No tenés cajas {monedaPago === 'ARS' ? 'ARS' : 'USD/USDT'} activas.
                </p>
              )}
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <label className="field-label" htmlFor="fecha-pago">
                Fecha
              </label>
              <input
                id="fecha-pago"
                className="input"
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                required
              />
            </div>

            <div className="field" style={{ marginBottom: 0 }}>
              <label className="field-label" htmlFor="notas-pago">
                Notas (opcional)
              </label>
              <textarea
                id="notas-pago"
                className="input"
                value={notas}
                onChange={(e) => setNotas(e.target.value)}
                maxLength={500}
                rows={2}
                style={{ fontFamily: 'inherit', resize: 'vertical' }}
              />
            </div>
          </div>

          <div className="modal-ft">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || !cajaId}>
              {saving ? 'Registrando…' : 'Registrar pago'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
