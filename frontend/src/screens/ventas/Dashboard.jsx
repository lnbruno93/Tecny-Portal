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
import { useMonedasTenant } from '../../lib/useMonedasTenant';
// F3.d-1 (2026-07-09): CLASES_LABELS y claseLabel se removieron. Los chips
// del KPI "Unidades vendidas" ahora usan directo el nombre + emoji del
// backend (shape array F3.c-2 PR-2 #533). El shape legacy F2 object
// {slug: n} también se removió del renderer 3-way — asumimos que el
// backend siempre responde con array. Si el backend antiguo estuviera
// activo (rollback), el frontend cae al bucket binario pre-F2.
import HourChart from './HourChart';

export default function Dashboard({ d }) {
  // 2026-07-08 (bug reportado por iOStoreUY): antes la card "INGRESOS
  // TOTALES" mostraba siempre `u$s{usd} + ${ars} ARS` hardcoded — en tenants
  // UY los pagos UYU desaparecían del display superior aunque el "USD
  // equivalente" sí los reflejara. Ahora leemos la moneda local del tenant
  // y mostramos el complemento correcto: UYU en tenants UY, ARS en AR.
  const { monedaLocal } = useMonedasTenant();
  if (!d) return null;
  const i = d.ingresos, dif = d.diferencias;
  // Complemento en moneda local. En AR toma `ars`, en UY toma `uyu`. Si el
  // backend devolvió el campo (ver computeDashboard 2026-07-08) lo usamos;
  // si no (rollback futuro o cache viejo pre-fix), fallback a 0 en vez de
  // undefined para que fmt() no muestre "NaN".
  const localAmt = monedaLocal === 'UYU' ? Number(i.uyu ?? 0) : Number(i.ars ?? 0);
  const localSymbol = monedaLocal === 'UYU' ? '$U' : '$';
  // 2026-07-04 (ventas.ver_ganancias): si el backend redactó el bloque de
  // ganancia (el user no tiene la cap), NO renderizamos la KPI card. Modo
  // "ocultar completamente" — no mostramos "—" ni placeholder porque queda
  // más limpio para el vendedor: el dashboard sigue teniendo Unidades /
  // Costos / Inversión canjes en las otras 3 columnas del grid.
  // Detectamos por `ganancia_neta_usd === undefined`: es el campo que el
  // backend saca cuando falta la cap. Si viniera 0 (período sin ventas)
  // igual debe verse. Owner/admin no entran acá — reciben todo.
  const showGanancias = d.ganancia_neta_usd !== undefined;
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div className="kpi-label">Ingresos totales</div>
        <div style={{ fontSize: 26, fontWeight: 700, margin: '4px 0' }}>
          <span className="mono">u$s{fmt(i.usd)}</span>{' '}
          <span className="muted" style={{ fontSize: 17 }}>+ {localSymbol}{fmt(localAmt)} {monedaLocal}</span>
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
        <div className="card card-tight" style={{ flex: 1 }} data-testid="kpi-unidades">
          <div className="kpi-label">Unidades vendidas</div>
          {/*
            F3.d-1 (2026-07-09): 2-way render.
            - Shape principal (F3.c-2 PR-2 #533): array pre-ordenado
              `[{clase_id, nombre, emoji, n}]` con labels editables por tenant.
            - Fallback: bucket binario `📱 celulares · 🎧 accesorios` cuando el
              array viene vacío/undefined (edge case: backend viejo post-rollback,
              o rango sin ventas donde el array queda []).

            El shape legacy F2 (object `{slug: n}`) se removió — asumimos que
            el backend siempre responde con array post PR #533. Si algún cache
            CDN sirviera el object legacy durante ~5min de rollout, cae al
            bucket binario silenciosamente (sin crash).
          */}
          {Array.isArray(d.unidades_por_clase) && d.unidades_por_clase.length > 0 ? (
            <div className="kpi-clases" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {d.unidades_por_clase.map(item => (
                <span
                  key={item.clase_id}
                  className="chip mono"
                  style={{ fontSize: 13 }}
                  title={`${item.n} unidad${item.n === 1 ? '' : 'es'} de ${item.nombre}`}
                >
                  {item.emoji ? `${item.emoji} ` : ''}{item.nombre} <strong>{item.n}</strong>
                </span>
              ))}
            </div>
          ) : (
            <div className="kpi-value" style={{ fontSize: 17 }}>
              📱 {d.unidades.celulares} · 🎧 {d.unidades.accesorios}
            </div>
          )}
        </div>
        {showGanancias && (
        <div className="card card-tight" style={{ flex: 1 }} data-testid="kpi-ganancia">
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
        )}
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

      {/* 2026-06-24 mobile (corrige sobre-fix anterior): .row es correcto acá.
          .kpi-grid es para FILAS de 4 KPIs simétricas — al usarlo con 2 cards
          dejaba huecos en desktop (las 2 cards ocupaban solo 2 de 4 cols).
          .row con flex-wrap + min-width:180 ya colapsa bien en mobile y
          distribuye 50/50 en desktop. */}
      <div className="row">
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

      {/* 2026-06-24 mobile (corrige sobre-fix anterior): .row es correcto acá.
          Mismo razonamiento que arriba — 3 cards en grid-4 dejan hueco a la
          derecha. .row distribuye 33/33/33 en desktop, colapsa en mobile. */}
      <div className="row" style={{ marginTop: 12 }}>
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
