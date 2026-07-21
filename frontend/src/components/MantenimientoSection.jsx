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
// TANDA 4 trazab: BackfillPanel + showApiError extraídos a components/admin/.
// Acá solo viven los renderers específicos (FinancieraReport, TarjetasReport)
// y la composición de los 2 paneles.
import { admin as adminApi } from '../lib/api';
import BackfillPanel from './admin/BackfillPanel';
import DiagnoseStockPanel from './admin/DiagnoseStockPanel';
import { Icons } from './Icons';

function fmtARS(n) {
  return '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');
}

// TANDA 3 trazab (UX M6): símbolo de moneda dinámico — el '$' siempre era
// engañoso para tarjetas USD/USDT. ARS y "" → "$"; USDT → "USDT "; USD → "US$ ".
function fmtMoneda(n, moneda) {
  const v = Math.round(Number(n) || 0).toLocaleString('es-AR');
  const m = String(moneda || 'ARS').toUpperCase();
  if (m === 'USD')  return `US$ ${v}`;
  if (m === 'USDT') return `USDT ${v}`;
  return `$ ${v}`;
}

// ─── Render del reporte para Financiera (1 caja) ────────────────────────────
function FinancieraReport({ report }) {
  if (report.skipped) {
    return (
      <div style={{ color: 'var(--pos)', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icons.Check size={14} aria-hidden="true"/> Nada pendiente. Todos los comprobantes y pagos ya impactan la caja FV.
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
            <div className="u-mt-8">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Comprobantes:</div>
              <table className="tbl">
                <thead><tr><th>Fecha</th><th>Cliente</th><th className="u-text-right">Neto</th></tr></thead>
                <tbody>
                  {report.muestras.comprobantes.map(c => (
                    <tr key={c.id}>
                      <td className="mono tiny">{c.fecha}</td>
                      <td className="tiny">{c.cliente || <span className="muted">Sin cliente</span>}</td>
                      <td className="mono tiny u-text-right">{fmtARS(c.monto_neto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {report.muestras.pagos?.length > 0 && (
            <div className="u-mt-10">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Pagos:</div>
              <table className="tbl">
                <thead><tr><th>Fecha</th><th>Caja destino</th><th className="u-text-right">Monto</th></tr></thead>
                <tbody>
                  {report.muestras.pagos.map(p => (
                    <tr key={p.id}>
                      <td className="mono tiny">{p.fecha}</td>
                      <td className="tiny">{p.caja_destino}</td>
                      <td className="mono tiny u-text-right">{fmtARS(p.monto)}</td>
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
      <div style={{ color: 'var(--pos)', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icons.Check size={14} aria-hidden="true"/> Nada pendiente. Todas las tarjetas ya tienen su trazabilidad al día.
      </div>
    );
  }
  return (
    <>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
        {report.cobros} cobros + {report.liquidaciones} liquidaciones pendientes.
        Detalle por tarjeta:
      </div>
      {/* TANDA 3 trazab (UX M1): overflow-x:auto evita que la tabla rompa el
          layout en viewports estrechos (< 500px). En desktop no cambia nada. */}
      <div className="u-overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Tarjeta</th>
              <th className="u-text-right">Saldo {report.apply ? 'previo' : 'actual'}</th>
              <th className="u-text-right">+ Cobros</th>
              <th className="u-text-right">− Liquidaciones</th>
              <th className="u-text-right">Saldo {report.apply ? 'final' : 'proyectado'}</th>
            </tr>
          </thead>
          <tbody>
            {report.porTarjeta.map(g => {
              const negativo = g.saldoProyectado < 0;
              // UX M6 (TANDA 3 trazab): formatter con moneda de la tarjeta —
              // antes mostraba "$ X" para tarjetas USDT, era engañoso.
              const fmt = (n) => fmtMoneda(n, g.tarjeta.moneda);
              return (
                <tr key={g.tarjeta.id}>
                  <td>
                    <b>{g.tarjeta.nombre}</b>
                    <span className="muted tiny u-ml-6">{g.tarjeta.moneda}</span>
                  </td>
                  <td className="mono tiny u-text-right">{fmt(g.saldoAntes)}</td>
                  <td className="mono tiny" style={{ textAlign: 'right', color: 'var(--pos)' }}>
                    {g.cobros > 0 ? `+${fmt(g.totalCobros)} (${g.cobros})` : '—'}
                  </td>
                  <td className="mono tiny" style={{ textAlign: 'right', color: 'var(--neg)' }}>
                    {g.liquidaciones > 0 ? `−${fmt(g.totalLiq)} (${g.liquidaciones})` : '—'}
                  </td>
                  <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: negativo ? 'var(--neg)' : 'inherit' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
                      {fmt(g.saldoProyectado)}
                      {negativo && <Icons.Alert size={12} aria-label="Saldo negativo" />}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── Render del reporte para Movimientos huérfanos ──────────────────────────
function OrphanMovsReport({ report }) {
  if (report.movs_count === 0) {
    return (
      <div style={{ color: 'var(--pos)', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icons.Check size={14} aria-hidden="true"/> Sin movimientos huérfanos. Todo en orden.
      </div>
    );
  }
  return (
    <>
      <table className="tbl" style={{ width: 'auto' }}>
        <tbody>
          <tr>
            <td style={{ paddingRight: 16 }}>Movimientos huérfanos detectados</td>
            <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{report.movs_count}</td>
          </tr>
          <tr>
            <td style={{ paddingRight: 16 }}>Deuda B2B asociada</td>
            <td className="mono u-text-right">US$ {Number(report.deuda_huerfana || 0).toLocaleString('es-AR')}</td>
          </tr>
          <tr>
            <td style={{ paddingRight: 16 }}>Caja movimientos a revertir</td>
            <td className="mono u-text-right">{report.caja_movs_a_revertir}</td>
          </tr>
        </tbody>
      </table>
      {report.muestras && report.muestras.length > 0 && (
        <details style={{ marginTop: 12, fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
            Ver primeros 10 movimientos huérfanos
          </summary>
          <div style={{ marginTop: 8, overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Cliente (borrado)</th>
                  <th>Tipo</th>
                  <th className="u-text-right">Monto</th>
                </tr>
              </thead>
              <tbody>
                {report.muestras.map(m => (
                  <tr key={m.id}>
                    <td className="mono tiny">{m.fecha}</td>
                    <td className="tiny">{[m.cliente_nombre, m.cliente_apellido].filter(Boolean).join(' ') || '—'}</td>
                    <td className="tiny"><b>{m.tipo}</b></td>
                    <td className="mono tiny u-text-right">US$ {Number(m.monto_total).toLocaleString('es-AR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {report.apply && Array.isArray(report.errores) && report.errores.length > 0 && (
        <div style={{ marginTop: 10, padding: 10, background: 'var(--surface-2)', borderRadius: 6, fontSize: 13, color: 'var(--neg)' }}>
          <b>{report.errores.length} movimiento(s) con error</b> — los demás se procesaron OK. Revisá y reintentá:
          <ul style={{ margin: '6px 0 0 18px' }}>
            {report.errores.slice(0, 5).map(e => <li key={e.mov_id}>Mov #{e.mov_id}: {e.error}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

// ─── Section principal ──────────────────────────────────────────────────────
export default function MantenimientoSection() {
  return (
    <>
      <DiagnoseStockPanel />

      <BackfillPanel
        title="Movimientos B2B huérfanos"
        descripcion={
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13.5 }}>
            Detecta movimientos B2B vivos cuyo cliente fue borrado. Hasta el 2026-06-09 el
            DELETE de cliente no cascadeaba, así que pueden quedar movimientos que siguen
            afectando stock (productos vendidos sin venta visible) y caja (ingresos huérfanos).
            Al aplicar, los cancela en bloque: restaura el stock + revierte caja + audit log.
            Idempotente.
          </p>
        }
        apiReport={adminApi.orphanMovsReport}
        apiApply={adminApi.orphanMovsApply}
        renderReport={(r) => <OrphanMovsReport report={r} />}
        confirmConfig={(r) => ({
          title: 'Limpiar movimientos huérfanos',
          message: (
            <>
              <p>Se van a cancelar <b>{r.movs_count} movimientos B2B huérfanos</b>:</p>
              <ul>
                <li>Productos volverán al stock disponible.</li>
                <li>{r.caja_movs_a_revertir} ingreso(s) se revertirán de las cajas.</li>
                <li>Cada movimiento queda en audit_logs con _origen='orphan_cleanup'.</li>
              </ul>
              <p>¿Continuar?</p>
            </>
          ),
          confirmLabel: 'Sí, limpiar',
          tone: 'danger',
        })}
        getStateChecks={{
          // No hay concepto de "saldo negativo" acá — el chequeo siempre pasa.
          hayNegativo: () => false,
          summaryToast: (r) => r.movs_count === 0
            ? 'Sin huérfanos pendientes.'
            : `${r.movs_count} movimiento(s) huérfanos detectados.`,
          successToast: (r) => `Limpieza aplicada: ${r.movs_procesados} movs procesados, ${r.productos_restaurados} productos restaurados.`,
        }}
      />

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
          successToast: (r) => `Backfill aplicado. Saldo final: ${fmtARS(r.saldoFinal)}.`,
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
          successToast: (r) => `Backfill aplicado en ${r.porTarjeta.length} tarjetas (${r.cobros + r.liquidaciones} movs).`,
        }}
      />
    </>
  );
}
