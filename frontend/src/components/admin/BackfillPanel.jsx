/**
 * BackfillPanel — UI genérica para operaciones admin de backfill.
 *
 * Pattern dry-run → confirm → apply. Cada instancia recibe sus endpoints API
 * y un renderReport para mostrar el resultado en su formato propio. Se usa
 * desde MantenimientoSection (TANDA 4 trazab: extraído desde inline).
 *
 * Si suma una 3ra operación admin (vaciar inventario, recalcular invariants,
 * etc.) reusa este componente con sus propios endpoints + render.
 *
 * Emite `window event 'cajas-changed'` post-apply para que las pantallas de
 * Cajas / 360 / Tarjetas / Financiera refresquen sus saldos (B1 trazab).
 */
import { useState } from 'react';
import { Icons } from '../Icons';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../ConfirmModal';

// Manejo coherente de errores de API (H5 TANDA 1 trazab):
//   · toast.error(err) con un Error object puede mostrar "[object Object]".
//   · "NO_AUTH" lo emite api.js cuando vence el JWT — el AuthContext ya
//     redirecciona, filtrarlo evita un toast confuso.
export function showApiError(toast, err) {
  if (err?.message === 'NO_AUTH') return;
  toast.error(err?.message || 'Error inesperado. Revisá la consola.');
}

export default function BackfillPanel({
  title,
  descripcion,
  apiReport,
  apiApply,
  renderReport,
  confirmConfig,
  getStateChecks,
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [report, setReport] = useState(null);
  const [reportAt, setReportAt] = useState(null);
  const [running, setRunning] = useState(null);

  async function handleReport() {
    setRunning('report');
    try {
      const data = await apiReport();
      setReport(data);
      setReportAt(new Date());
      if (data.skipped) toast.success('Sin movimientos pendientes — la trazabilidad está al día.');
      else toast.info(getStateChecks.summaryToast(data));
    } catch (err) {
      showApiError(toast, err);
    } finally {
      setRunning(null);
    }
  }

  async function handleApply() {
    if (!report) { toast.error('Primero corré "Ver reporte".'); return; }
    if (report.skipped) { toast.info('No hay nada pendiente.'); return; }
    if (getStateChecks.hayNegativo(report)) {
      toast.error('Hay saldo proyectado negativo. Revisá antes de aplicar.');
      return;
    }
    const ok = await confirm(confirmConfig(report));
    if (!ok) return;

    setRunning('apply');
    try {
      const data = await apiApply();
      setReport(data);
      setReportAt(new Date());
      toast.success(getStateChecks.successToast(data));
      // B1 trazab: el backend ya invalidó cacheCajas — el evento cierra el
      // loop en frontend (state local por pantalla).
      window.dispatchEvent(new Event('cajas-changed'));
    } catch (err) {
      showApiError(toast, err);
    } finally {
      setRunning(null);
    }
  }

  const applyDisabled =
    !!running || !report || report.skipped || getStateChecks.hayNegativo(report);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-hd">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icons.Bolt size={16} /> {title}
        </h3>
      </div>

      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)' }}>
        {descripcion}
      </div>

      <div className="flex-row" style={{ gap: 8, padding: '14px 18px', flexWrap: 'wrap' }}>
        <button className="btn" onClick={handleReport} disabled={!!running}>
          <Icons.Search size={13} />
          {running === 'report' ? ' Calculando…' : ' Ver reporte (dry-run)'}
        </button>
        <button
          className="btn btn-primary"
          onClick={handleApply}
          disabled={applyDisabled}
          title={
            !report ? 'Primero "Ver reporte"'
            : report.skipped ? 'Nada pendiente'
            : getStateChecks.hayNegativo(report) ? 'Proyección negativa — revisá antes'
            : 'Aplicar backfill'
          }
        >
          <Icons.Check size={13} />
          {running === 'apply' ? ' Aplicando…' : ' Aplicar'}
        </button>
      </div>

      {report && (
        <div style={{ padding: '14px 18px', borderTop: '1px solid var(--hairline)', background: 'var(--surface-2)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            {report.apply ? '✓ Aplicado' : '· Reporte'} · {reportAt ? reportAt.toLocaleTimeString('es-AR') : '—'}
          </div>
          {renderReport(report)}
        </div>
      )}
    </div>
  );
}
