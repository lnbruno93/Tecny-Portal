/**
 * MantenimientoSection — pantalla admin con herramientas operativas.
 *
 * Por ahora solo expone el backfill de caja Financiera (TANDA 2). Pensada
 * para crecer: invariants check, vaciar inventario, exportar audit logs, etc.
 *
 * Solo se renderiza dentro del tab "Mantenimiento" de Config, que el padre
 * monta solo si user.role === 'admin'. El backend además impone el role check
 * (defensa en profundidad).
 */
import { useState } from 'react';
import { Icons } from './Icons';
import { admin as adminApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';

function fmtARS(n) {
  return '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

export default function MantenimientoSection() {
  const { toast } = useToast();
  const confirm = useConfirm();

  // null = no se corrió aún | obj = último resultado (dry-run o apply).
  const [report, setReport] = useState(null);
  const [reportAt, setReportAt] = useState(null);   // hora del último report
  const [running, setRunning] = useState(null);     // 'report' | 'apply' | null

  async function handleReport() {
    setRunning('report');
    try {
      const data = await adminApi.backfillFinancieraReport();
      setReport(data);
      setReportAt(new Date());
      if (data.skipped) {
        toast.success('Sin movimientos pendientes — la trazabilidad está al día.');
      } else {
        toast.info(`${data.comprobantes} comprobantes + ${data.pagos} pagos pendientes.`);
      }
    } catch (err) {
      toast.error(err);
    } finally {
      setRunning(null);
    }
  }

  async function handleApply() {
    if (!report) {
      toast.error('Primero corré "Ver reporte" para chequear los movimientos pendientes.');
      return;
    }
    if (report.skipped) {
      toast.info('No hay nada pendiente.');
      return;
    }
    if (report.saldoProyectadoNegativo) {
      toast.error('El saldo proyectado quedaría negativo. Revisá los movimientos antes de aplicar.');
      return;
    }

    const ok = await confirm({
      title: 'Aplicar backfill',
      message: (
        <>
          <p>Se van a crear <b>{report.comprobantes} ingresos</b> y <b>{report.pagos} egresos</b> en la caja <b>{report.caja?.nombre}</b>.</p>
          <p>Saldo proyectado: <b>{fmtARS(report.saldoProyectado)}</b>.</p>
          <p>Esta operación es <b>reversible solo a mano</b> (borrando los caja_movimientos creados). ¿Continuar?</p>
        </>
      ),
      confirmLabel: 'Sí, aplicar',
      tone: 'danger',
    });
    if (!ok) return;

    setRunning('apply');
    try {
      const data = await adminApi.backfillFinancieraApply();
      setReport(data);
      setReportAt(new Date());
      toast.success(`✓ Backfill aplicado. Saldo final: ${fmtARS(data.saldoFinal)}.`);
    } catch (err) {
      toast.error(err);
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="card">
      <div className="card-hd">
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icons.Bolt size={16} />
          Backfill caja Financiera
        </h3>
      </div>

      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)' }}>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13.5 }}>
          Crea retroactivamente los <code>caja_movimientos</code> en la caja Financiera
          (la marcada como <code>es_financiera = true</code>) para los comprobantes manuales
          y pagos cargados antes de la trazabilidad automática. Operación idempotente:
          se puede correr varias veces sin duplicar.
        </p>
        <ul style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18, color: 'var(--text-muted)', fontSize: 13 }}>
          <li><b>Ver reporte</b>: sin tocar la DB, calcula cuánto sumaría/restaría.</li>
          <li><b>Aplicar</b>: ejecuta los inserts en una transacción + valida saldo final &gt;= 0.</li>
        </ul>
      </div>

      <div className="flex-row" style={{ gap: 8, padding: '14px 18px', flexWrap: 'wrap' }}>
        <button className="btn" onClick={handleReport} disabled={!!running}>
          <Icons.Search size={13} />
          {running === 'report' ? ' Calculando…' : ' Ver reporte (dry-run)'}
        </button>
        <button
          className="btn btn-primary"
          onClick={handleApply}
          disabled={!!running || !report || report.skipped || report.saldoProyectadoNegativo}
          title={
            !report ? 'Primero "Ver reporte"'
            : report.skipped ? 'Nada pendiente'
            : report.saldoProyectadoNegativo ? 'Proyección negativa — revisá antes'
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
            {report.apply ? '✓ Aplicado' : '· Reporte'} ·{' '}
            {reportAt ? reportAt.toLocaleTimeString('es-AR') : '—'}
            {report.caja && <> · Caja: <b>{report.caja.nombre}</b> ({report.caja.moneda})</>}
          </div>

          {report.skipped ? (
            <div style={{ color: 'var(--pos)', fontSize: 14, fontWeight: 600 }}>
              ✓ Nada pendiente. Todos los comprobantes y pagos ya impactan la caja FV.
            </div>
          ) : (
            <>
              <table className="tbl" style={{ width: 'auto' }}>
                <tbody>
                  <tr>
                    <td style={{ paddingRight: 16 }}>Saldo {report.apply ? 'previo' : 'actual'}</td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
                      {fmtARS(report.saldoAntes)}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ paddingRight: 16 }}>
                      + Comprobantes ({report.comprobantes})
                    </td>
                    <td className="mono" style={{ textAlign: 'right', color: 'var(--pos)' }}>
                      +{fmtARS(report.totalCompromisos)}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ paddingRight: 16 }}>
                      − Pagos ({report.pagos})
                    </td>
                    <td className="mono" style={{ textAlign: 'right', color: 'var(--neg)' }}>
                      −{fmtARS(report.totalPagos)}
                    </td>
                  </tr>
                  <tr style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ paddingRight: 16, fontWeight: 700, paddingTop: 6 }}>
                      Saldo {report.apply ? 'final' : 'proyectado'}
                    </td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 700, paddingTop: 6 }}>
                      {fmtARS(report.saldoFinal ?? report.saldoProyectado)}
                    </td>
                  </tr>
                </tbody>
              </table>

              {report.saldoProyectadoNegativo && !report.apply && (
                <div style={{ marginTop: 10, padding: 10, background: 'var(--neg-soft, #fee)', border: '1px solid var(--neg)', borderRadius: 6, fontSize: 13 }}>
                  ⚠️ La proyección quedaría negativa. Probablemente hay pagos sin sus
                  comprobantes contraparte. Investigá antes de aplicar.
                </div>
              )}

              {report.muestras && (report.muestras.comprobantes?.length > 0 || report.muestras.pagos?.length > 0) && (
                <details style={{ marginTop: 12, fontSize: 13 }}>
                  <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
                    Ver primeros 10 movimientos pendientes
                  </summary>
                  {report.muestras.comprobantes?.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>Comprobantes:</div>
                      <table className="tbl">
                        <thead>
                          <tr><th>Fecha</th><th>Cliente</th><th style={{ textAlign: 'right' }}>Neto</th></tr>
                        </thead>
                        <tbody>
                          {report.muestras.comprobantes.map(c => (
                            <tr key={c.id}>
                              <td className="mono tiny">{c.fecha}</td>
                              <td className="tiny">{c.cliente}</td>
                              <td className="mono tiny" style={{ textAlign: 'right' }}>{fmtARS(c.monto_neto)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {report.muestras.pagos?.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>Pagos:</div>
                      <table className="tbl">
                        <thead>
                          <tr><th>Fecha</th><th>Caja destino</th><th style={{ textAlign: 'right' }}>Monto</th></tr>
                        </thead>
                        <tbody>
                          {report.muestras.pagos.map(p => (
                            <tr key={p.id}>
                              <td className="mono tiny">{p.fecha}</td>
                              <td className="tiny">{p.caja_destino}</td>
                              <td className="mono tiny" style={{ textAlign: 'right' }}>{fmtARS(p.monto)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
