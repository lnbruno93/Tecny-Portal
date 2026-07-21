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
// Auditoría 2026-06-30 F-02→05: multi-país. El KPI "ARS" y el lookup
// cajas.por_moneda.ARS estaban hardcoded — para tenants UY la card de moneda
// local aparecía vacía. Ahora derivamos el código de la moneda local
// (ARS/UYU) del tenant.
import { useMonedasTenant } from '../lib/useMonedasTenant';

function mesActualISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function mesAnteriorISO(mes) {
  const [y, m] = mes.split('-').map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}
// Suma/resta n meses a un mes ISO (YYYY-MM). n puede ser negativo.
function mesOffsetISO(mes, n) {
  const [y, m] = mes.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}
// Presets de período — espejo del estilo Hoy/Mes/Custom de Tarjetas y
// Transferencias (2026-06-15), pero a granularidad mes porque el endpoint
// del Resumen sigue siendo `?periodo=YYYY-MM`.
const MES_PRESETS = [
  { v: 'este',     l: 'Este mes' },
  { v: 'pasado',   l: 'Mes pasado' },
  { v: 'hace2',    l: 'Hace 2 meses' },
  { v: 'custom',   l: 'Personalizado' },
];
// Dado un periodo ISO actual, deduce qué preset corresponde (o 'custom' si
// no coincide con ninguno).
function presetParaMes(mes) {
  const hoy = mesActualISO();
  if (mes === hoy) return 'este';
  if (mes === mesOffsetISO(hoy, -1)) return 'pasado';
  if (mes === mesOffsetISO(hoy, -2)) return 'hace2';
  return 'custom';
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
    if (Number(valor) > 0) badge = <span className="badge badge-info u-fs-11">Nuevo</span>;
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
    <div className="card card-tight u-mw-min-0" role="figure" aria-label={`KPI: ${label}`}>
      <div className="muted tiny u-mb-4">{label}</div>
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
  // Auditoría 2026-06-30 F-02→05: moneda local del tenant (ARS para AR, UYU
  // para UY). Reemplaza los literales 'ARS' / '$' del bloque "Capital en cajas".
  const { monedaLocal } = useMonedasTenant();
  // Símbolo visual de la moneda local — alineado con fmtMoney:
  //   ARS → '$',  UYU → '$U'. Mantenemos un map chico en lugar de derivar de
  //   fmtMoney(0,...) porque KpiCard recibe `unidad` como string suelto.
  const simboloLocal = monedaLocal === 'UYU' ? '$U' : '$';
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
  // Auditoría 2026-06-30 F-02→05: leemos la key correspondiente a la moneda
  // local del tenant. El payload del backend tiene la forma
  // `cajas.por_moneda.{ARS|UYU|USD|USDT}` — antes solo se leía la key 'ARS'
  // y para tenants UY la card quedaba vacía aunque hubiera datos en UYU.
  const [localA,     localC]     = v(`cajas.por_moneda.${monedaLocal}`);
  const [usdA,       usdC]       = v('cajas.por_moneda.USD');
  const [usdtA,      usdtC]      = v('cajas.por_moneda.USDT');
  const [deudaCCA,   deudaCCC]   = v('deuda_cc.deuda_usd');
  const [deudaPrA,   deudaPrC]   = v('deuda_proveedores.deuda_usd');
  const [egresosA,   egresosC]   = v('egresos.total_usd');

  return (
    <div>
      {/* 2026-06-19: h1 + subtítulo deben ir EN UN DIV interno, no como
          siblings directos del .page-head — sino space-between los separa
          horizontalmente y el subtítulo termina flotando a la derecha. */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Resumen del mes</h1>
          <div className="page-sub">Comparativo de período + KPIs operativos consolidados.</div>
        </div>
      </div>

      {/* Selectores de período (2026-06-15): presets de mes en lugar de un
          <input type=month> pelado. Mismo estilo visual que Tarjetas y
          Transferencias para consistencia entre módulos. El comparativo
          queda siempre visible (auto-rellena al mes anterior, editable). */}
      <div className="card card-tight u-mb-16">
        <div className="flex-row u-gap-6-wrap-center">
          <span className="muted tiny u-mr-4">Período:</span>
          {MES_PRESETS.map(p => {
            const activo = presetParaMes(periodoActual) === p.v;
            return (
              <button key={p.v}
                className={'btn btn-sm ' + (activo ? 'btn-primary' : 'btn-ghost')}
                onClick={() => {
                  const hoy = mesActualISO();
                  if (p.v === 'este')     handleCambioPeriodo(hoy);
                  else if (p.v === 'pasado') handleCambioPeriodo(mesOffsetISO(hoy, -1));
                  else if (p.v === 'hace2')  handleCambioPeriodo(mesOffsetISO(hoy, -2));
                  // 'custom' no cambia el mes — solo muestra el input.
                }}>
                {p.l}
              </button>
            );
          })}
          {presetParaMes(periodoActual) === 'custom' && (
            <input
              type="month" className="input mono"
              style={{ width: 160, marginLeft: 6 }}
              value={periodoActual}
              onChange={e => handleCambioPeriodo(e.target.value)}
              max={mesActualISO()}
            />
          )}
          <span className="muted tiny u-ml-8">vs</span>
          <input
            type="month" className="input mono u-w-160"
            value={periodoComp}
            onChange={e => setPeriodoComp(e.target.value)}
            max={periodoActual}
            title="Comparar con"
          />
          <span className="muted tiny">
            {labelMes(periodoActual)} <span className="dim">vs</span> {labelMes(periodoComp)}
          </span>
          {data?.generado_en && (
            <div className="muted tiny u-ml-auto">
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
          <h3 className="u-mt-18-mb-8">Ventas</h3>
          <div className="row u-gap-12-flex-wrap">
            <div className="u-flex-1-1-200">
              <KpiCard label="Ventas totales" unidad="USD" valor={ventasUsdA} comparado={ventasUsdC} />
            </div>
            {/* 2026-07-04 (ventas.ver_ganancias): backend redacta ganancia_usd
                cuando el user no tiene la cap → gananciaA queda undefined y
                ocultamos la card entera. Owner/admin siempre ven; vendedor
                sin override, no. Modo "ocultar" (no "—") consensuado con Lucas. */}
            {gananciaA !== undefined && (
              <div className="u-flex-1-1-200" data-testid="kpi-ganancia">
                <KpiCard label="Ganancia bruta" unidad="USD" valor={gananciaA} comparado={gananciaC} />
              </div>
            )}
            <div className="u-flex-1-1-200">
              <KpiCard label="Ticket promedio" unidad="USD" valor={ticketA} comparado={ticketC} />
            </div>
            <div className="u-flex-1-1-200">
              <KpiCard label="Cantidad de ventas" valor={cantVtaA} comparado={cantVtaC} formatter={n => String(n)} />
            </div>
          </div>

          {/* ── Bloque 2: Cajas (capital) ── */}
          <h3 className="u-mt-18-mb-8">Capital en cajas <span className="muted tiny">(al fin del período)</span></h3>
          <div className="row u-gap-12-flex-wrap">
            <div className="u-flex-1-1-220">
              <KpiCard
                label="Capital total"
                unidad="USD eq."
                valor={capitalA}
                comparado={capitalC}
                hint={actual?.cajas?.tc_referencia ? null : 'Configurá un TC en Config → Alertas para ver capital agregado.'}
              />
            </div>
            <div className="u-flex-1-1-200">
              {/* Auditoría 2026-06-30 F-02→05: label y unidad dinámicas (ARS/$
                  en AR, UYU/$U en UY). */}
              <KpiCard label={monedaLocal} unidad={simboloLocal} valor={localA} comparado={localC} />
            </div>
            <div className="u-flex-1-1-200">
              <KpiCard label="USD" unidad="u$s" valor={usdA} comparado={usdC} />
            </div>
            <div className="u-flex-1-1-200">
              <KpiCard label="USDT" unidad="USDT" valor={usdtA} comparado={usdtC} />
            </div>
          </div>

          {/* ── Bloque 3: Deudas + Egresos ── */}
          <h3 className="u-mt-18-mb-8">Deudas y Egresos</h3>
          <div className="row u-gap-12-flex-wrap">
            <div className="u-flex-1-1-220">
              <KpiCard label="Nos deben (CC clientes)" unidad="USD" valor={deudaCCA} comparado={deudaCCC} />
            </div>
            <div className="u-flex-1-1-220">
              {/* Deuda a proveedores: más es peor → invertirSigno */}
              <KpiCard label="Debemos (Proveedores)" unidad="USD" valor={deudaPrA} comparado={deudaPrC} invertirSigno />
            </div>
            <div className="u-flex-1-1-220">
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
                  <thead><tr><th>Producto</th><th className="u-text-right">Cantidad</th><th className="u-text-right">USD</th></tr></thead>
                  <tbody>
                    {(actual.ventas.top_productos || []).map((p, i) => (
                      <tr key={i}>
                        <td>{p.producto}</td>
                        <td className="mono u-text-right">{p.cantidad}</td>
                        <td className="mono u-text-right">{fmt(p.total_usd)}</td>
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
                  <thead><tr><th>Vendedor</th><th className="u-text-right">Ventas</th><th className="u-text-right">USD</th></tr></thead>
                  <tbody>
                    {(actual.ventas.top_vendedores || []).map((v, i) => (
                      <tr key={i}>
                        <td>{v.vendedor}</td>
                        <td className="mono u-text-right">{v.ventas}</td>
                        <td className="mono u-text-right">{fmt(v.total_usd)}</td>
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
              <thead><tr><th>Método</th><th>Moneda</th><th className="u-text-right">USD</th></tr></thead>
              <tbody>
                {(actual.ventas.pagos_por_metodo || []).map((p, i) => (
                  <tr key={i}>
                    <td>{p.metodo}</td>
                    <td className="muted tiny">{p.moneda}</td>
                    <td className="mono u-text-right">{fmt(p.total_usd)}</td>
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
