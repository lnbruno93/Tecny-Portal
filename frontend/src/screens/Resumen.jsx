// Pantalla "Resumen mensual" — vista de gerencia con todos los KPIs del
// negocio en un período + comparativo vs otro período (default: mes anterior).
//
// Consume GET /api/dashboard/resumen-mensual que devuelve { actual, comparado }.
// Los deltas % se calculan en el front (más control de formato + decisiones
// de mostrar "—" cuando no hay base de comparación).

import { useState, useEffect, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { dashboard as dashApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { fmt, fmtFecha } from '../lib/format';

function mesActualISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function mesAnteriorISO(mes) {
  const [y, m] = mes.split('-').map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}
function labelMes(mes) {
  if (!/^\d{4}-\d{2}$/.test(mes)) return mes;
  const [y, m] = mes.split('-').map(Number);
  const nombres = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                   'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return `${nombres[m - 1]} ${y}`;
}

// Calcula delta % entre dos valores. Devuelve null si no hay base de comparación
// (base 0 → cualquier valor positivo es "nuevo", se muestra como '+∞' o solo
// el valor sin %). El front decide cómo formatear.
function delta(actual, comparado) {
  const a = Number(actual) || 0;
  const c = Number(comparado) || 0;
  if (c === 0) return a === 0 ? 0 : null;
  return ((a - c) / Math.abs(c)) * 100;
}

// KPI Card componente: muestra label + valor + delta vs comparado.
function KpiCard({ label, valor, unidad = '', comparado, formatter = fmt, invertirSigno = false, hint = null }) {
  // valor null marca "indefinido" (ej: capital_usd_equivalente sin TC ref).
  // Lo mostramos como "—" y omitimos el delta (no es 0, es desconocido).
  const valorIndefinido = valor === null || valor === undefined;
  const d = valorIndefinido ? null : delta(valor, comparado);
  let badge = null;
  if (valorIndefinido) {
    badge = hint ? <span className="muted tiny">{hint}</span> : null;
  } else if (d === null) {
    // Sin base de comparación: si el actual > 0, mostrar 'Nuevo'.
    if (Number(valor) > 0) badge = <span className="badge badge-info" style={{ fontSize: 11 }}>Nuevo</span>;
  } else if (Math.abs(d) < 0.5) {
    badge = <span className="muted tiny">≈ igual</span>;
  } else {
    // invertirSigno=true para KPIs donde "más es peor" (deuda, egresos).
    const positivo = invertirSigno ? d < 0 : d > 0;
    const tone = positivo ? 'pos' : 'neg';
    const arrow = d > 0 ? '↑' : '↓';
    badge = (
      <span style={{ color: `var(--${tone})`, fontSize: 12, fontWeight: 600 }}>
        {arrow} {Math.abs(d).toFixed(1)}%
      </span>
    );
  }
  return (
    <div className="card card-tight" style={{ minWidth: 0 }} role="figure" aria-label={`KPI: ${label}`}>
      <div className="muted tiny" style={{ marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 700 }}>
        {unidad && !valorIndefinido && <span style={{ fontSize: 14, color: 'var(--text-muted)', marginRight: 4 }}>{unidad}</span>}
        {valorIndefinido ? '—' : formatter(valor)}
      </div>
      <div style={{ marginTop: 4, minHeight: 16 }}>{badge}</div>
    </div>
  );
}

export default function Resumen() {
  const { toast } = useToast();
  const [periodoActual, setPeriodoActual]   = useState(mesActualISO());
  const [periodoComp,   setPeriodoComp]     = useState(mesAnteriorISO(mesActualISO()));
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    dashApi.resumenMensual({ periodo: periodoActual, comparar_con: periodoComp })
      .then(r => setData(r))
      .catch(e => { setError(e.message); toast.error(e.message); })
      .finally(() => setLoading(false));
  }, [periodoActual, periodoComp, toast]);

  // Cuando se cambia el período actual, auto-actualizar el comparado al
  // mes anterior — salvo que el usuario lo haya cambiado manualmente.
  // Por simplicidad: solo auto-actualizar si el comparado seguía siendo
  // "mes anterior" del período viejo.
  function handleCambioPeriodo(nuevo) {
    const auto = mesAnteriorISO(periodoActual);
    if (periodoComp === auto) {
      // Era el default → actualizar también.
      setPeriodoComp(mesAnteriorISO(nuevo));
    }
    setPeriodoActual(nuevo);
  }

  const actual    = data?.actual;
  const comparado = data?.comparado;

  // Helpers para acceso seguro.
  const v = (path) => {
    const a = path.split('.').reduce((o, k) => o?.[k], actual);
    const c = path.split('.').reduce((o, k) => o?.[k], comparado);
    return [a, c];
  };

  const [ventasUsdA, ventasUsdC] = v('ventas.ventas_usd');
  const [gananciaA,  gananciaC]  = v('ventas.ganancia_usd');
  const [ticketA,    ticketC]    = v('ventas.ticket_promedio_usd');
  const [cantVtaA,   cantVtaC]   = v('ventas.cant_ventas');
  const [capitalA,   capitalC]   = v('cajas.capital_usd_equivalente');
  const [arsA,       arsC]       = v('cajas.por_moneda.ARS');
  const [usdA,       usdC]       = v('cajas.por_moneda.USD');
  const [usdtA,      usdtC]      = v('cajas.por_moneda.USDT');
  const [deudaCCA,   deudaCCC]   = v('deuda_cc.deuda_usd');
  const [deudaPrA,   deudaPrC]   = v('deuda_proveedores.deuda_usd');
  const [egresosA,   egresosC]   = v('egresos.total_usd');

  return (
    <div>
      <div className="page-head">
        <h1>Resumen del mes</h1>
        <div className="muted tiny">Comparativo de período + KPIs operativos consolidados.</div>
      </div>

      {/* Selectores de período */}
      <div className="card card-tight" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 200 }}>
            <label className="field-label">Período</label>
            <input
              type="month" className="input mono"
              value={periodoActual}
              onChange={e => handleCambioPeriodo(e.target.value)}
              max={mesActualISO()}
            />
            <div className="muted tiny" style={{ marginTop: 2 }}>{labelMes(periodoActual)}</div>
          </div>
          <div className="field" style={{ width: 200 }}>
            <label className="field-label">Comparar con</label>
            <input
              type="month" className="input mono"
              value={periodoComp}
              onChange={e => setPeriodoComp(e.target.value)}
              max={periodoActual}
            />
            <div className="muted tiny" style={{ marginTop: 2 }}>{labelMes(periodoComp)}</div>
          </div>
          {data?.generado_en && (
            <div className="muted tiny" style={{ marginLeft: 'auto' }}>
              Actualizado: {fmtFecha(data.generado_en.slice(0, 10))}
            </div>
          )}
        </div>
      </div>

      {loading && <div className="empty">Calculando KPIs…</div>}
      {error && <div className="empty">Error: {error}</div>}

      {!loading && !error && actual && (
        <>
          {/* ── Bloque 1: Ventas ── */}
          <h3 style={{ marginTop: 18, marginBottom: 8 }}>Ventas</h3>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 200px' }}>
              <KpiCard label="Ventas totales" unidad="USD" valor={ventasUsdA} comparado={ventasUsdC} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <KpiCard label="Ganancia bruta" unidad="USD" valor={gananciaA} comparado={gananciaC} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <KpiCard label="Ticket promedio" unidad="USD" valor={ticketA} comparado={ticketC} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <KpiCard label="Cantidad de ventas" valor={cantVtaA} comparado={cantVtaC} formatter={n => String(n)} />
            </div>
          </div>

          {/* ── Bloque 2: Cajas (capital) ── */}
          <h3 style={{ marginTop: 18, marginBottom: 8 }}>Capital en cajas <span className="muted tiny">(al fin del período)</span></h3>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px' }}>
              <KpiCard
                label="Capital total"
                unidad="USD eq."
                valor={capitalA}
                comparado={capitalC}
                hint={actual?.cajas?.tc_referencia ? null : 'Configurá un TC en Config → Alertas para ver capital agregado.'}
              />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <KpiCard label="ARS" unidad="$" valor={arsA} comparado={arsC} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <KpiCard label="USD" unidad="u$s" valor={usdA} comparado={usdC} />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <KpiCard label="USDT" unidad="USDT" valor={usdtA} comparado={usdtC} />
            </div>
          </div>

          {/* ── Bloque 3: Deudas + Egresos ── */}
          <h3 style={{ marginTop: 18, marginBottom: 8 }}>Deudas y Egresos</h3>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px' }}>
              <KpiCard label="Nos deben (CC clientes)" unidad="USD" valor={deudaCCA} comparado={deudaCCC} />
            </div>
            <div style={{ flex: '1 1 220px' }}>
              {/* Deuda a proveedores: más es peor → invertirSigno */}
              <KpiCard label="Debemos (Proveedores)" unidad="USD" valor={deudaPrA} comparado={deudaPrC} invertirSigno />
            </div>
            <div style={{ flex: '1 1 220px' }}>
              {/* Egresos: más es peor → invertirSigno */}
              <KpiCard label="Egresos del mes" unidad="USD" valor={egresosA} comparado={egresosC} invertirSigno />
            </div>
          </div>

          {/* ── Bloque 4: Top 5 productos / vendedores ── */}
          <div className="row" style={{ gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 380px' }}>
              <div className="card card-flush">
                <div className="card-hd"><h3>Top productos</h3></div>
                <table className="tbl">
                  <thead><tr><th>Producto</th><th style={{ textAlign: 'right' }}>Cantidad</th><th style={{ textAlign: 'right' }}>USD</th></tr></thead>
                  <tbody>
                    {(actual.ventas.top_productos || []).map((p, i) => (
                      <tr key={i}>
                        <td>{p.producto}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{p.cantidad}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{fmt(p.total_usd)}</td>
                      </tr>
                    ))}
                    {(actual.ventas.top_productos || []).length === 0 && (
                      <tr><td colSpan={3} className="empty tiny">Sin ventas en este período</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ flex: '1 1 380px' }}>
              <div className="card card-flush">
                <div className="card-hd"><h3>Top vendedores</h3></div>
                <table className="tbl">
                  <thead><tr><th>Vendedor</th><th style={{ textAlign: 'right' }}>Ventas</th><th style={{ textAlign: 'right' }}>USD</th></tr></thead>
                  <tbody>
                    {(actual.ventas.top_vendedores || []).map((v, i) => (
                      <tr key={i}>
                        <td>{v.vendedor}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{v.ventas}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{fmt(v.total_usd)}</td>
                      </tr>
                    ))}
                    {(actual.ventas.top_vendedores || []).length === 0 && (
                      <tr><td colSpan={3} className="empty tiny">Sin ventas en este período</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* ── Bloque 5: Pagos por método ── */}
          <div className="card card-flush" style={{ marginTop: 18 }}>
            <div className="card-hd"><h3>Pagos por método</h3></div>
            <table className="tbl">
              <thead><tr><th>Método</th><th>Moneda</th><th style={{ textAlign: 'right' }}>USD</th></tr></thead>
              <tbody>
                {(actual.ventas.pagos_por_metodo || []).map((p, i) => (
                  <tr key={i}>
                    <td>{p.metodo}</td>
                    <td className="muted tiny">{p.moneda}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{fmt(p.total_usd)}</td>
                  </tr>
                ))}
                {(actual.ventas.pagos_por_metodo || []).length === 0 && (
                  <tr><td colSpan={3} className="empty tiny">Sin pagos registrados</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
