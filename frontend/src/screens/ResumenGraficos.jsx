/**
 * ResumenGraficos — sub-vista dedicada a los 6 gráficos analíticos del
 * Resumen del mes (task #310, split UX post-feedback Lucas).
 *
 * Contexto: cuando task #309 agregó los 6 charts al Resumen, el scroll
 * quedó muy largo (KPIs + tablas + gráficos + top productos + top
 * vendedores). Lucas pidió separar los gráficos en su propia "hoja" con
 * link "Ver gráficos →" desde el Resumen. Este es esa hoja.
 *
 * Ruta:   /resumen/graficos?periodo=YYYY-MM
 * Cap:    resumen.ver (misma que /resumen)
 *
 * Data flow:
 *  · Lee `periodo` del query param (default: mes actual).
 *  · Fetch `/api/dashboard/resumen-mensual?periodo=X` una vez → alimenta
 *    B1, B2, B3, C1, A2 (todos vienen en `data.actual`).
 *  · A1 (serie 6 meses) tiene su propio fetch dentro del componente.
 *  · Sin comparativo — el comparativo mensual solo tiene sentido para
 *    KPIs numéricos, no para el análisis gráfico (ya se ve la evolución
 *    en A1 y las tendencias en las barras).
 */

import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router';
import { dashboard as dashApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';

// Charts (task #309)
import FacturacionEgresosChart      from '../components/charts/FacturacionEgresosChart';
import MargenNetoCard               from '../components/charts/MargenNetoCard';
import UnidadesPorCategoriaChart    from '../components/charts/UnidadesPorCategoriaChart';
import VentasPorEtiquetaChart       from '../components/charts/VentasPorEtiquetaChart';
import FacturacionPorCategoriaChart from '../components/charts/FacturacionPorCategoriaChart';
import VentasPorDiaChart            from '../components/charts/VentasPorDiaChart';

// task #311: helpers de período — mismo pattern que Resumen.jsx.
// Duplicados a propósito por ahora (~30 LOC) — si aparece 3ra vista con
// mismos helpers, mover a lib/mesUtils.js.
function mesActualISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function mesOffsetISO(mes, n) {
  const [y, m] = mes.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}
const MES_PRESETS = [
  { v: 'este',   l: 'Este mes' },
  { v: 'pasado', l: 'Mes pasado' },
  { v: 'hace2',  l: 'Hace 2 meses' },
  { v: 'custom', l: 'Personalizado' },
];
function presetParaMes(mes) {
  const hoy = mesActualISO();
  if (mes === hoy) return 'este';
  if (mes === mesOffsetISO(hoy, -1)) return 'pasado';
  if (mes === mesOffsetISO(hoy, -2)) return 'hace2';
  return 'custom';
}
const MES_LABELS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
function labelMes(iso) {
  const [y, m] = iso.split('-').map(Number);
  return `${MES_LABELS[m - 1]} ${y}`;
}

export default function ResumenGraficos() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  // Período del query param (deep-linkable). Default: mes actual.
  const periodo = searchParams.get('periodo') || mesActualISO();
  const backLink = `/resumen?periodo=${periodo}`;

  // task #311: setter que actualiza el URL query param. `replace: true` para
  // que el browser back no acumule intermediates entre cambios de período.
  function setPeriodo(nuevo) {
    setSearchParams({ periodo: nuevo }, { replace: true });
  }

  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    dashApi.resumenMensual({ periodo, comparar_con: periodo })  // mismo mes → sin delta
      .then(res => { if (alive) { setData(res); setLoading(false); } })
      .catch(err => {
        if (!alive) return;
        const msg = err.message || 'No pudimos cargar los gráficos';
        setError(msg);
        toast.error(msg);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [periodo, toast]);

  const actual = data?.actual;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="u-flex-center-gap-8-mb-4">
            <Link to={backLink} className="btn-link u-fs-14">
              ← Volver al resumen
            </Link>
          </div>
          <h1 className="page-title">Gráficos — {labelMes(periodo)}</h1>
          <div className="page-sub">
            Visualización analítica: facturación, composición y actividad del período.
          </div>
        </div>
      </div>

      {/* task #311: selector de período inline (mismo pattern que /resumen).
          Sync bidireccional con el URL query param para preservar
          bookmarkability + browser back. */}
      <div className="card card-tight u-mb-16">
        <div className="flex-row u-gap-6-wrap-center">
          <span className="muted tiny u-mr-4">Período:</span>
          {MES_PRESETS.map(p => {
            const activo = presetParaMes(periodo) === p.v;
            return (
              <button key={p.v}
                className={'btn btn-sm ' + (activo ? 'btn-primary' : 'btn-ghost')}
                onClick={() => {
                  const hoy = mesActualISO();
                  if (p.v === 'este')   setPeriodo(hoy);
                  else if (p.v === 'pasado') setPeriodo(mesOffsetISO(hoy, -1));
                  else if (p.v === 'hace2')  setPeriodo(mesOffsetISO(hoy, -2));
                }}>
                {p.l}
              </button>
            );
          })}
          {presetParaMes(periodo) === 'custom' && (
            <input
              type="month" className="input mono u-resumen-month-input"
              value={periodo}
              onChange={e => setPeriodo(e.target.value)}
              max={mesActualISO()}
            />
          )}
          <span className="muted tiny u-ml-8">{labelMes(periodo)}</span>
        </div>
      </div>

      {loading && <div className="empty">Cargando gráficos…</div>}
      {error && !loading && <div className="empty">Error: {error}</div>}

      {!loading && !error && actual && (
        <>
          {/* Sección A — Facturación y rentabilidad */}
          <h3 className="u-mt-24-mb-12">Facturación y rentabilidad</h3>
          <div className="row u-gap-20-flex-wrap">
            <div className="u-flex-11-380">
              <FacturacionEgresosChart hastaMes={periodo} meses={6} />
            </div>
            <div className="u-flex-1-1-220">
              <MargenNetoCard margenActual={actual?.margen_neto_pct} />
            </div>
          </div>

          {/* Sección B — Composición de ventas */}
          <h3 className="u-mt-24-mb-12">Composición de ventas</h3>
          <div className="row u-gap-20-flex-wrap">
            <div className="u-flex-11-380">
              <UnidadesPorCategoriaChart data={actual?.ventas?.por_categoria} />
            </div>
            <div className="u-flex-11-380">
              <VentasPorEtiquetaChart data={actual?.ventas?.por_etiqueta} />
            </div>
          </div>
          <div className="row u-gap-20-flex-wrap">
            <div className="u-flex-11-380">
              <FacturacionPorCategoriaChart data={actual?.ventas?.por_categoria} />
            </div>
          </div>

          {/* Sección C — Actividad diaria */}
          <h3 className="u-mt-24-mb-12">Actividad diaria</h3>
          <div className="row u-gap-20-flex-wrap">
            <div className="u-flex-11-380">
              <VentasPorDiaChart data={actual?.ventas?.por_dia} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
