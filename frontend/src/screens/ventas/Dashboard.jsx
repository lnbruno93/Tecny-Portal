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

import { useState } from 'react';
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
// 2026-07-09 (post-Fase 2b Inventario): rediseño del card "Unidades vendidas"
// bajo el patrón Opción C — resumen numérico + botón que abre modal detalle.
// Consistente con InventarioPorCategoriaModal (Fase 2b). Resuelve el desbalance
// vertical del card cuando el tenant vende en 8+ categorías del rango.
import VentasPorCategoriaModal from '../../components/VentasPorCategoriaModal';

export default function Dashboard({ d }) {
  // Estado del modal de detalle "Unidades vendidas por categoría". Local al
  // Dashboard porque el modal solo se usa desde el card KPI de acá — no hay
  // razón para elevarlo a un contexto compartido.
  const [showUnidadesModal, setShowUnidadesModal] = useState(false);
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
    <div className="u-mb-18">
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div className="kpi-label">Ingresos totales</div>
        <div style={{ fontSize: 26, fontWeight: 700, margin: '4px 0' }}>
          <span className="mono">u$s{fmt(i.usd)}</span>{' '}
          <span className="muted u-fs-17">+ {localSymbol}{fmt(localAmt)} {monedaLocal}</span>
        </div>
        <div className="muted u-fs-12">
          USD equivalente:{' '}
          <span className="pos mono u-fw-600">u$s{fmt(i.total_usd_equiv)}</span>
          {' · '}
          {d.ventas_count} venta{d.ventas_count === 1 ? '' : 's'}
        </div>
      </div>

      {/* 2026-06-24 mobile fix: .row → .kpi-grid. Antes los 4 cards quedaban
          exprimidos en 4 cols estrechas en <414px, los labels wrappeaban a
          3 líneas y se veía horrible. Reportado por Lucas con screenshot. */}
      <div className="kpi-grid u-mb-12">
        <div className="card card-tight u-flex-1" data-testid="kpi-unidades">
          <div className="kpi-label">Unidades vendidas</div>
          {/*
            2026-07-09 (Opción C rediseño post-Fase 2b): card compacto con
            total + top categoría al vuelo + botón que abre modal de detalle.
            Reemplaza el layout de chips inline que se desbalanceaba cuando
            el tenant vendía en 8+ categorías.

            2-way render:
            - Shape principal (F3.c-2 PR-2 #533): array pre-ordenado
              `[{clase_id, nombre, emoji, n}]` → resumen + botón → modal.
            - Fallback: bucket binario pre-F2 `📱 celulares · 🎧 accesorios`
              cuando el array viene vacío/undefined (edge case: backend viejo
              post-rollback, o rango sin ventas del período).

            El shape legacy F2 (object `{slug: n}`) también cae al fallback
            binario porque no pasa `Array.isArray`. No mantenemos path para
            el object — Se removió en F3.d-1.
          */}
          {Array.isArray(d.unidades_por_clase) && d.unidades_por_clase.length > 0 ? (
            (() => {
              // Total agregado + top categoría por count DESC. Cálculo local
              // (backend ya viene ordenado pero por si acaso). Cheap: N chico.
              const filas = d.unidades_por_clase;
              const total = filas.reduce((s, r) => s + (Number(r.n) || 0), 0);
              const top = filas.slice().sort((a, b) => (Number(b.n) || 0) - (Number(a.n) || 0))[0];
              const catsConVentas = filas.filter(r => (Number(r.n) || 0) > 0).length;
              return (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
                    <span className="kpi-value mono u-fs-17">{fmt(total)}</span>
                    <span className="muted tiny">en {catsConVentas} {catsConVentas === 1 ? 'categoría' : 'categorías'}</span>
                  </div>
                  {top && (
                    <div className="muted tiny u-mt-4" title={`Top: ${top.nombre} (${top.n} unidades)`}>
                      Top: {top.emoji ? `${top.emoji} ` : ''}{top.nombre} <strong style={{ color: 'var(--fg)' }}>{top.n}</strong>
                    </div>
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ marginTop: 8, fontSize: 12 }}
                    onClick={() => setShowUnidadesModal(true)}
                    title="Ver detalle por categoría"
                  >
                    Ver detalle →
                  </button>
                </>
              );
            })()
          ) : (
            <div className="kpi-value u-fs-17">
              📱 {d.unidades.celulares} · 🎧 {d.unidades.accesorios}
            </div>
          )}
        </div>
        {showGanancias && (
        <div className="card card-tight u-flex-1" data-testid="kpi-ganancia">
          <div className="kpi-label">Ganancia neta</div>
          <div className="kpi-value mono pos u-fs-17">u$s{fmt(d.ganancia_neta_usd)}</div>
          {/*
            Tema C.4 (2026-06-13): desglose de la cascada que llega a la neta.
            Lucas pidió aprobar "B" — ver bruta + costo financiero + neta para que
            quede claro cuánto retiene el método de pago vs cuánto egreso operativo
            descuenta. Mostramos la cuenta sobre ACREDITADAS (es la base del KPI
            neto). Si el backend trae 0 en costo_financiero, no agregamos esa
            línea para no ruidar (ej. periodos sin ventas con tarjeta).
          */}
          <div className="muted tiny u-mt-4">
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
          <div className="muted tiny u-mt-2">
            {d.margen_pct}% margen
          </div>
        </div>
        )}
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Costos productos</div>
          <div className="kpi-value mono u-fs-17">u$s{fmt(d.costos_usd)}</div>
        </div>
        <div className="card card-tight u-flex-1">
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
        <div className="card card-tight u-flex-1">
          <div className="kpi-label u-mb-8">Métodos de pago</div>
          <table className="table u-fs-12">
            <tbody>
              {d.metodos_pago.length === 0 && <tr><td className="muted">Sin pagos</td></tr>}
              {d.metodos_pago.map((m, k) => (
                <tr key={k}>
                  <td>{m.metodo_nombre}</td>
                  <td className="mono u-td-right-fw-600">
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
        <div className="card card-tight u-flex-1">
          <div className="kpi-label u-mb-8">Ventas por horario</div>
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
      <div className="row u-mt-12">
        <div className="card card-tight u-flex-1">
          <div className="kpi-label">Ticket promedio</div>
          <div className="kpi-value mono u-fs-17">u$s{fmt(d.ticket_promedio_usd)}</div>
          <div className="muted tiny u-mt-4">
            {d.ventas_count} venta{d.ventas_count === 1 ? '' : 's'}
          </div>
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label u-mb-8">Top productos</div>
          {(d.top_productos || []).length === 0
            ? <div className="muted tiny">—</div>
            : d.top_productos.map((p, k) => (
                <div key={k} className="flex-between" style={{ fontSize: 12, padding: '2px 0' }}>
                  <span>{p.descripcion}</span>
                  <span className="mono muted">{p.unidades}u</span>
                </div>
              ))}
        </div>
        <div className="card card-tight u-flex-1">
          <div className="kpi-label u-mb-8">Top vendedores</div>
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

      {/* Modal de detalle del KPI "Unidades vendidas" (Opción C rediseño).
          Le pasamos el array crudo — el modal maneja filtrado, orden y
          total agregado. Solo se monta cuando `showUnidadesModal=true` (el
          componente hace `if (!open) return null` internamente). */}
      <VentasPorCategoriaModal
        open={showUnidadesModal}
        onClose={() => setShowUnidadesModal(false)}
        unidadesPorClase={d.unidades_por_clase || []}
      />
    </div>
  );
}
