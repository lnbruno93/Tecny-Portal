/**
 * MantenimientoSection — pantalla admin con herramientas operativas.
 *
 * Hoy expone dos backfills paralelos:
 *   1. Caja Financiera (TANDA 2 Financiera, PR #120).
 *   2. Cajas Tarjeta (TANDA 2 Tarjetas, PR #123).
 *
 * Cada uno usa `<BackfillPanel/>` (un componente reutilizable abajo) con sus
 * propios endpoints + render del reporte. Si en el futuro hay más operaciones
 * admin (invariants check, vaciar inventario, etc.), agregar más Panels.
 *
 * Solo se renderiza dentro del tab "Mantenimiento" de Config, que el padre
 * monta solo si user.role === 'admin'. El backend también impone el role
 * check (defensa en profundidad).
 */
import { useState } from 'react';
import { Icons } from './Icons';
import { admin as adminApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmModal';

function fmtARS(n) {
  return '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

// H5 (TANDA 1 trazab): manejo coherente de errores de API.
//   · `toast.error(err)` con un Error object puede mostrar "[object Object]".
//   · "NO_AUTH" lo emite api.js cuando vence el JWT — el AuthContext ya
//     redirecciona, así que filtrarlo evita un toast confuso.
function showApiError(toast, err) {
  if (err?.message === 'NO_AUTH') return; // el AuthContext lo maneja
  toast.error(err?.message || 'Error inesperado. Revisá la consola.');
}

// ─── Render del reporte para Financiera (1 caja) ────────────────────────────
function FinancieraReport({ report }) {
  if (report.skipped) {
    return (
      <div style={{ color: 'var(--pos)', fontSize: 14, fontWeight: 600 }}>
        ✓ Nada pendiente. Todos los comprobantes y pagos ya impactan la caja FV.
      </div>
    );
  }
  return (
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
            <td style={{ paddingRight: 16 }}>+ Comprobantes ({report.comprobantes})</td>
            <td className="mono" style={{ textAlign: 'right', color: 'var(--pos)' }}>
              +{fmtARS(report.totalCompromisos)}
            </td>
          </tr>
          <tr>
            <td style={{ paddingRight: 16 }}>− Pagos ({report.pagos})</td>
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
      {report.muestras && (report.muestras.comprobantes?.length > 0 || report.muestras.pagos?.length > 0) && (
        <details style={{ marginTop: 12, fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
            Ver primeros 10 movimientos pendientes
          </summary>
          {report.muestras.comprobantes?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Comprobantes:</div>
              <table className="tbl">
                <thead><tr><th>Fecha</th><th>Cliente</th><th style={{ textAlign: 'right' }}>Neto</th></tr></thead>
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
                <thead><tr><th>Fecha</th><th>Caja destino</th><th style={{ textAlign: 'right' }}>Monto</th></tr></thead>
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
  );
}

// ─── Render del reporte para Tarjetas (N cajas) ─────────────────────────────
function TarjetasReport({ report }) {
  if (report.skipped) {
    return (
      <div style={{ color: 'var(--pos)', fontSize: 14, fontWeight: 600 }}>
        ✓ Nada pendiente. Todas las tarjetas ya tienen su trazabilidad al día.
      </div>
    );
  }
  return (
    <>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
        {report.cobros} cobros + {report.liquidaciones} liquidaciones pendientes.
        Detalle por tarjeta:
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Tarjeta</th>
            <th style={{ textAlign: 'right' }}>Saldo {report.apply ? 'previo' : 'actual'}</th>
            <th style={{ textAlign: 'right' }}>+ Cobros</th>
            <th style={{ textAlign: 'right' }}>− Liquidaciones</th>
            <th style={{ textAlign: 'right' }}>Saldo {report.apply ? 'final' : 'proyectado'}</th>
          </tr>
        </thead>
        <tbody>
          {report.porTarjeta.map(g => {
            const negativo = g.saldoProyectado < 0;
            return (
              <tr key={g.tarjeta.id}>
                <td>
                  <b>{g.tarjeta.nombre}</b>
                  <span className="muted tiny" style={{ marginLeft: 6 }}>{g.tarjeta.moneda}</span>
                </td>
                <td className="mono tiny" style={{ textAlign: 'right' }}>{fmtARS(g.saldoAntes)}</td>
                <td className="mono tiny" style={{ textAlign: 'right', color: 'var(--pos)' }}>
                  {g.cobros > 0 ? `+${fmtARS(g.totalCobros)} (${g.cobros})` : '—'}
                </td>
                <td className="mono tiny" style={{ textAlign: 'right', color: 'var(--neg)' }}>
                  {g.liquidaciones > 0 ? `−${fmtARS(g.totalLiq)} (${g.liquidaciones})` : '—'}
                </td>
                <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: negativo ? 'var(--neg)' : 'inherit' }}>
                  {fmtARS(g.saldoProyectado)} {negativo && '⚠️'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// ─── Panel reutilizable ─────────────────────────────────────────────────────
function BackfillPanel({ title, descripcion, apiReport, apiApply, renderReport, confirmConfig, getStateChecks }) {
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
      // B1: emitir evento global para que las pantallas de Cajas / 360 /
      // Tarjetas / Financiera refresquen sus saldos. El backend ya invalidó
      // su cache TTL — esto cierra el loop en el frontend (que tiene su
      // propio state local por screen).
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

// ─── Section principal ──────────────────────────────────────────────────────
export default function MantenimientoSection() {
  return (
    <>
      <BackfillPanel
        title="Backfill caja Financiera"
        descripcion={
          <>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13.5 }}>
              Crea retroactivamente los <code>caja_movimientos</code> en la caja Financiera
              (la marcada como <code>es_financiera = true</code>) para los comprobantes manuales
              y pagos cargados antes de la trazabilidad automática. Operación idempotente:
              se puede correr varias veces sin duplicar.
            </p>
          </>
        }
        apiReport={adminApi.backfillFinancieraReport}
        apiApply={adminApi.backfillFinancieraApply}
        renderReport={(r) => <FinancieraReport report={r} />}
        confirmConfig={(r) => ({
          title: 'Aplicar backfill Financiera',
          message: (
            <>
              <p>Se van a crear <b>{r.comprobantes} ingresos</b> (+{fmtARS(r.totalCompromisos)}) y <b>{r.pagos} egresos</b> (−{fmtARS(r.totalPagos)}) en la caja <b>{r.caja?.nombre}</b>.</p>
              <p>Saldo proyectado: <b>{fmtARS(r.saldoProyectado)}</b>.</p>
              <p>Para revertir hay que borrar los <code>caja_movimientos</code> creados desde la base directamente. ¿Continuar?</p>
            </>
          ),
          confirmLabel: 'Sí, aplicar',
          tone: 'danger',
        })}
        getStateChecks={{
          hayNegativo: (r) => !!r.saldoProyectadoNegativo,
          summaryToast: (r) => `${r.comprobantes} comprobantes + ${r.pagos} pagos pendientes.`,
          successToast: (r) => `✓ Backfill aplicado. Saldo final: ${fmtARS(r.saldoFinal)}.`,
        }}
      />

      <BackfillPanel
        title="Backfill cajas Tarjetas"
        descripcion={
          <>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13.5 }}>
              Reconstruye los <code>caja_movimientos</code> de cada tarjeta (los métodos de pago
              marcados como <code>es_tarjeta = true</code>) para los cobros (de venta o previos) y
              las liquidaciones cargados antes de la trazabilidad automática. Valida que ninguna
              tarjeta quede en saldo negativo. Idempotente.
            </p>
          </>
        }
        apiReport={adminApi.backfillTarjetasReport}
        apiApply={adminApi.backfillTarjetasApply}
        renderReport={(r) => <TarjetasReport report={r} />}
        confirmConfig={(r) => {
          // H6 (TANDA 1 trazab): mostrar total agregado para que el operador
          // dimensione la operación. Antes solo veía cantidad de movs sin monto.
          const totalCobros = r.porTarjeta.reduce((s, g) => s + Number(g.totalCobros || 0), 0);
          const totalLiq    = r.porTarjeta.reduce((s, g) => s + Number(g.totalLiq || 0), 0);
          return {
            title: 'Aplicar backfill Tarjetas',
            message: (
              <>
                <p>Se van a crear <b>{r.cobros} ingresos</b> (+{fmtARS(totalCobros)}) y <b>{r.liquidaciones} egresos</b> (−{fmtARS(totalLiq)}) distribuidos en <b>{r.porTarjeta.length} tarjetas</b>.</p>
                <p>Para revertir hay que borrar los <code>caja_movimientos</code> creados desde la base directamente. ¿Continuar?</p>
              </>
            ),
            confirmLabel: 'Sí, aplicar',
            tone: 'danger',
          };
        }}
        getStateChecks={{
          hayNegativo: (r) => !!r.hayNegativos,
          summaryToast: (r) => `${r.cobros} cobros + ${r.liquidaciones} liquidaciones en ${r.porTarjeta.length} tarjetas.`,
          successToast: (r) => `✓ Backfill aplicado en ${r.porTarjeta.length} tarjetas (${r.cobros + r.liquidaciones} movs).`,
        }}
      />
    </>
  );
}
