// Dashboard — bloque KPI superior de Ventas. Solo lectura, recibe la data
// agregada del endpoint /api/ventas/dashboard ya calculada por el backend
// (no hace cálculos propios). Si la data es null/undefined, no renderiza
// nada (el padre maneja el estado de carga).
//
// Layout:
//   ┌─────────────────────────────────────────────────┐
//   │ Ingresos totales (USD + ARS + equivalente)      │
//   ├──────────┬──────────┬──────────┬────────────────┤
//   │ Unidades │ Ganancia │ Costos   │ Inversión cnj  │
//   ├──────────┴──────────┼──────────┴────────────────┤
//   │ Métodos de pago     │ Ventas por horario        │
//   ├──────────┬──────────┴───────────────┬───────────┤
//   │ Ticket   │ Top productos            │ Top vend. │
//   └──────────┴──────────────────────────┴───────────┘

import { fmt } from '../../lib/format';
import { sym } from './utils';
import HourChart from './HourChart';

export default function Dashboard({ d }) {
  if (!d) return null;
  const i = d.ingresos, dif = d.diferencias;
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div className="kpi-label">Ingresos totales</div>
        <div style={{ fontSize: 26, fontWeight: 700, margin: '4px 0' }}>
          <span className="mono">u$s{fmt(i.usd)}</span>{' '}
          <span className="muted" style={{ fontSize: 17 }}>+ ${fmt(i.ars)} ARS</span>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          USD equivalente:{' '}
          <span className="pos mono" style={{ fontWeight: 600 }}>u$s{fmt(i.total_usd_equiv)}</span>
          {' · '}
          {d.ventas_count} venta{d.ventas_count === 1 ? '' : 's'}
        </div>
      </div>

      {/* 2026-06-24 mobile fix: .row → .kpi-grid. Antes los 4 cards quedaban
          exprimidos en 4 cols estrechas en <414px, los labels wrappeaban a
          3 líneas y se veía horrible. Reportado por Lucas con screenshot. */}
      <div className="kpi-grid" style={{ marginBottom: 12 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Unidades vendidas</div>
          <div className="kpi-value" style={{ fontSize: 17 }}>
            📱 {d.unidades.celulares} · 🎧 {d.unidades.accesorios}
          </div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Ganancia neta</div>
          <div className="kpi-value mono pos" style={{ fontSize: 17 }}>u$s{fmt(d.ganancia_neta_usd)}</div>
          {/*
            Tema C.4 (2026-06-13): desglose de la cascada que llega a la neta.
            Lucas pidió aprobar "B" — ver bruta + costo financiero + neta para que
            quede claro cuánto retiene el método de pago vs cuánto egreso operativo
            descuenta. Mostramos la cuenta sobre ACREDITADAS (es la base del KPI
            neto). Si el backend trae 0 en costo_financiero, no agregamos esa
            línea para no ruidar (ej. periodos sin ventas con tarjeta).
          */}
          <div className="muted tiny" style={{ marginTop: 4 }}>
            Bruta <span className="mono">u$s{fmt(d.ganancia_bruta_acreditada_usd)}</span>
            {Number(d.costo_financiero_acreditado_usd) > 0 && (
              <>
                {' · '}
                <span
                  className="neg"
                  title="Comisión retenida por tarjeta de crédito y transferencias del período"
                >
                  −fin <span className="mono">u$s{fmt(d.costo_financiero_acreditado_usd)}</span>
                </span>
              </>
            )}
            {' · '}
            <span className="neg">−egr <span className="mono">u$s{fmt(d.egresos_usd)}</span></span>
          </div>
          <div className="muted tiny" style={{ marginTop: 2 }}>
            {d.margen_pct}% margen
          </div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Costos productos</div>
          <div className="kpi-value mono" style={{ fontSize: 17 }}>u$s{fmt(d.costos_usd)}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Inversión canjes</div>
          <div className="kpi-value mono" style={{ fontSize: 17, color: 'var(--warn)' }}>
            u$s{fmt(d.inversion_canjes_usd)}
          </div>
        </div>
      </div>

      {/* 2026-06-24 mobile: .row → .kpi-grid. Las 2 cards (Métodos de pago +
          Ventas por horario) tienen tablas internas que se exprimen mucho
          en <414px. .kpi-grid las apila en single col en mobile. */}
      <div className="kpi-grid">
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label" style={{ marginBottom: 8 }}>Métodos de pago</div>
          <table className="table" style={{ fontSize: 12 }}>
            <tbody>
              {d.metodos_pago.length === 0 && <tr><td className="muted">Sin pagos</td></tr>}
              {d.metodos_pago.map((m, k) => (
                <tr key={k}>
                  <td>{m.metodo_nombre}</td>
                  <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
                    {sym(m.moneda)}{fmt(m.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 11, marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            Diferencias — sobrepagos <span className="pos">u$s{fmt(dif.sobrepagos)}</span>
            {' · '}
            faltantes <span className="neg">u$s{fmt(dif.faltantes)}</span>
            {' · '}
            neto <strong>u$s{fmt(dif.neto)}</strong>
          </div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label" style={{ marginBottom: 8 }}>Ventas por horario</div>
          <HourChart data={d.por_horario} />
          <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
            Etiquetas:{' '}
            {d.por_etiqueta.length
              ? d.por_etiqueta.map((e, k) => (
                  <span key={k} className="badge badge-default" style={{ marginRight: 6 }}>
                    {e.etiqueta}: {e.n}
                  </span>
                ))
              : '—'}
          </div>
        </div>
      </div>

      {/* 2026-06-24 mobile: .row → .kpi-grid. 3 cards (Ticket + Top productos + Top vendedores). */}
      <div className="kpi-grid" style={{ marginTop: 12 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Ticket promedio</div>
          <div className="kpi-value mono" style={{ fontSize: 17 }}>u$s{fmt(d.ticket_promedio_usd)}</div>
          <div className="muted tiny" style={{ marginTop: 4 }}>
            {d.ventas_count} venta{d.ventas_count === 1 ? '' : 's'}
          </div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label" style={{ marginBottom: 8 }}>Top productos</div>
          {(d.top_productos || []).length === 0
            ? <div className="muted tiny">—</div>
            : d.top_productos.map((p, k) => (
                <div key={k} className="flex-between" style={{ fontSize: 12, padding: '2px 0' }}>
                  <span>{p.descripcion}</span>
                  <span className="mono muted">{p.unidades}u</span>
                </div>
              ))}
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label" style={{ marginBottom: 8 }}>Top vendedores</div>
          {(d.top_vendedores || []).length === 0
            ? <div className="muted tiny">—</div>
            : d.top_vendedores.map((v, k) => (
                <div key={k} className="flex-between" style={{ fontSize: 12, padding: '2px 0' }}>
                  <span>{v.vendedor}</span>
                  <span className="mono pos">u$s{fmt(v.total_usd)}</span>
                </div>
              ))}
        </div>
      </div>
    </div>
  );
}
