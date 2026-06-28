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

import { useState, useEffect, useMemo } from 'react';
import { redB2b, cajas as cajasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { fmtMoney } from '../lib/format';

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

  // Filtrar cajas compatibles con moneda_pago.
  const cajasCompat = useMemo(() => {
    if (monedaPago === 'ARS') return cajasList.filter((c) => c.moneda === 'ARS');
    return cajasList.filter((c) => c.moneda === 'USD' || c.moneda === 'USDT');
  }, [cajasList, monedaPago]);

  useEffect(() => {
    cajasApi.listMetodosPago()
      .then((r) => {
        const list = Array.isArray(r) ? r : (r.metodos_pago || r.cajas || []);
        setCajasList(list);
      })
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
      });
      toast.success('Pago registrado');
      onSuccess && onSuccess();
      onClose();
    } catch (err) {
      toast.error(err.message || 'No pudimos registrar el pago');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rb2b-pago-title">
      <div className="modal-content" style={{ maxWidth: 520 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 id="rb2b-pago-title" style={{ margin: 0, fontSize: 18 }}>
            Registrar pago de operación #{operation?.id}
          </h2>
          <button type="button" onClick={onClose} className="btn-icon" aria-label="Cerrar">×</button>
        </header>

        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Saldo restante: <strong>{fmtMoney(restanteUsd, 'USD')}</strong>{' '}
          (de {fmtMoney(operation?.total_usd, 'USD')}, TC venta: {operation?.tc_used})
        </p>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="monto-usd" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
              Monto a pagar (USD)
            </label>
            <input
              id="monto-usd"
              type="number"
              step="0.01"
              min="0"
              max={restanteUsd}
              value={montoUsd}
              onChange={(e) => setMontoUsd(e.target.value)}
              required
              style={{ width: '100%', padding: 8 }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <span style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>Moneda del pago</span>
            <div style={{ display: 'flex', gap: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="radio"
                  name="moneda_pago"
                  value="USD"
                  checked={monedaPago === 'USD'}
                  onChange={() => setMonedaPago('USD')}
                />
                USD (sin re-cálculo)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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

          <div style={{ marginBottom: 12 }}>
            <label htmlFor="tc-pago" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
              TC del pago {monedaPago === 'USD' && <span className="muted">(no aplica)</span>}
            </label>
            <input
              id="tc-pago"
              type="number"
              step="0.0001"
              min="0"
              value={tcPago}
              onChange={(e) => setTcPago(e.target.value)}
              disabled={monedaPago === 'USD'}
              required
              style={{ width: '100%', padding: 8 }}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
              Monto a cobrar/pagar ({monedaPago})
            </label>
            <input
              type="text"
              value={fmtMoney(montoPagoCalc, monedaPago)}
              readOnly
              style={{ width: '100%', padding: 8, background: 'var(--bg-subtle, #f9fafb)' }}
            />
          </div>

          {monedaPago === 'ARS' && Math.abs(diferenciaPreview) >= 0.01 && (
            <div
              style={{
                padding: 10,
                background: diferenciaPreview > 0 ? 'var(--green-bg, #f0fdf4)' : 'var(--red-bg, #fef2f2)',
                color: diferenciaPreview > 0 ? 'var(--green-fg, #166534)' : 'var(--red-fg, #991b1b)',
                borderRadius: 4,
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

          <div style={{ marginBottom: 12 }}>
            <label htmlFor="caja-id" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
              Caja {operation?.my_side === 'seller' ? 'receptora (donde entra el dinero)' : 'emisora (de donde sale)'}
            </label>
            <select
              id="caja-id"
              value={cajaId}
              onChange={(e) => setCajaId(e.target.value)}
              required
              style={{ width: '100%', padding: 8 }}
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

          <div style={{ marginBottom: 12 }}>
            <label htmlFor="fecha-pago" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
              Fecha
            </label>
            <input
              id="fecha-pago"
              type="date"
              value={fecha}
              onChange={(e) => setFecha(e.target.value)}
              required
              style={{ width: '100%', padding: 8 }}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label htmlFor="notas-pago" style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>
              Notas (opcional)
            </label>
            <textarea
              id="notas-pago"
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              maxLength={500}
              rows={2}
              style={{ width: '100%', padding: 8, fontFamily: 'inherit', fontSize: 14 }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={saving || !cajaId}>
              {saving ? 'Registrando…' : 'Registrar pago'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
