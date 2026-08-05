/**
 * ResumenGraficos — sub-vista dedicada a los 6 gráficos analíticos del
 * Resumen del mes (task #310, split UX post-feedback Lucas).
 *
 * Fase 1 (#309/#310): 6 gráficos + selector período inline.
 * Fase 2 (#312): filtro por etiqueta + filtro por categoría + toggle
 *   "Comparar vs mes anterior". Todos sync con URL query params.
 *
 * Ruta:   /resumen/graficos?periodo=YYYY-MM&etiqueta_id=N&clase_id=UUID&comparar=1
 * Cap:    resumen.ver (misma que /resumen)
 *
 * Data flow:
 *  · Lee period + filtros del query param.
 *  · Fetch `/api/dashboard/resumen-mensual?periodo=X&comparar_con=Y&...`
 *    una vez → alimenta B1, B2, B3, C1, A2.
 *  · A1 (serie 6 meses) tiene su propio fetch — recibe filtros por props.
 *  · Comparativo: cuando ON, comparar_con = mes anterior (default: mismo mes).
 *  · Fetch de catálogos (etiquetas + clases) al mount para poblar dropdowns.
 */

import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router';
import { dashboard as dashApi, ventas as ventasApi, inventario as invApi } from '../lib/api';
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
  // Período + filtros del query param (deep-linkables). Defaults sensatos.
  const periodo    = searchParams.get('periodo')     || mesActualISO();
  const etiquetaId = searchParams.get('etiqueta_id') || '';
  const claseId    = searchParams.get('clase_id')    || '';
  const comparar   = searchParams.get('comparar') === '1';
  const backLink   = `/resumen?periodo=${periodo}`;

  // task #312: helper para actualizar múltiples params preservando los otros.
  // Aceptamos '' o null para borrar un param específico.
  function updateParams(patch) {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v == null || v === false) next.delete(k);
      else next.set(k, String(v));
    }
    setSearchParams(next, { replace: true });
  }

  // Catálogos para dropdowns (fetch al mount, no cambia entre re-renders).
  const [etiquetas, setEtiquetas] = useState([]);
  const [clases,    setClases]    = useState([]);
  useEffect(() => {
    let alive = true;
    Promise.all([
      ventasApi.etiquetas().catch(() => []),
      invApi.clases().catch(() => []),
    ]).then(([etqs, clss]) => {
      if (!alive) return;
      setEtiquetas(Array.isArray(etqs) ? etqs : []);
      setClases(Array.isArray(clss) ? clss : []);
    });
    return () => { alive = false; };
  }, []);

  // Data del período (+ comparado cuando toggle ON).
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    // Cuando comparar ON, comparar_con = mes anterior. Sino mismo mes (sin delta).
    const compararCon = comparar ? mesOffsetISO(periodo, -1) : periodo;
    const params = { periodo, comparar_con: compararCon };
    if (etiquetaId) params.etiqueta_id = etiquetaId;
    if (claseId)    params.clase_id    = claseId;
    dashApi.resumenMensual(params)
      .then(res => { if (alive) { setData(res); setLoading(false); } })
      .catch(err => {
        if (!alive) return;
        const msg = err.message || 'No pudimos cargar los gráficos';
        setError(msg);
        toast.error(msg);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [periodo, etiquetaId, claseId, comparar, toast]);

  const actual    = data?.actual;
  const comparado = data?.comparado;
  const filtrosActivos = !!(etiquetaId || claseId);

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

      {/* task #311: selector de período inline. task #312: dropdowns +
          toggle comparativo. Sync bidireccional con URL query params. */}
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
                  if (p.v === 'este')   updateParams({ periodo: hoy });
                  else if (p.v === 'pasado') updateParams({ periodo: mesOffsetISO(hoy, -1) });
                  else if (p.v === 'hace2')  updateParams({ periodo: mesOffsetISO(hoy, -2) });
                }}>
                {p.l}
              </button>
            );
          })}
          {presetParaMes(periodo) === 'custom' && (
            <input
              type="month" className="input mono u-resumen-month-input"
              value={periodo}
              onChange={e => updateParams({ periodo: e.target.value })}
              max={mesActualISO()}
            />
          )}
          <span className="muted tiny u-ml-8">{labelMes(periodo)}</span>
        </div>

        {/* task #312: segunda fila con filtros de composición + toggle comparativo. */}
        <div className="flex-row u-gap-6-wrap-center u-mt-8">
          <span className="muted tiny u-mr-4">Etiqueta:</span>
          <select
            className="input btn-sm"
            value={etiquetaId}
            onChange={e => updateParams({ etiqueta_id: e.target.value })}
          >
            <option value="">Todas</option>
            {etiquetas.map(e => (
              <option key={e.id} value={e.id}>{e.nombre}</option>
            ))}
          </select>

          <span className="muted tiny u-mr-4 u-ml-8">Categoría:</span>
          <select
            className="input btn-sm"
            value={claseId}
            onChange={e => updateParams({ clase_id: e.target.value })}
          >
            <option value="">Todas</option>
            {clases.map(c => (
              <option key={c.id} value={c.id}>{c.emoji || '📦'} {c.nombre}</option>
            ))}
          </select>

          <label className="u-flex-center-gap-8 u-ml-8 u-fs-13">
            <input
              type="checkbox"
              checked={comparar}
              onChange={e => updateParams({ comparar: e.target.checked ? '1' : '' })}
            />
            <span>Comparar vs mes anterior</span>
          </label>

          {filtrosActivos && (
            <button
              className="btn btn-sm btn-ghost u-ml-auto"
              onClick={() => updateParams({ etiqueta_id: '', clase_id: '' })}
              title="Quitar todos los filtros"
            >
              Limpiar filtros
            </button>
          )}
        </div>

        {filtrosActivos && (
          <div className="muted tiny u-mt-8">
            ⚠️ Con filtros activos, los <strong>egresos</strong> no se filtran
            (son operativos generales). El margen neto puede aparecer distorsionado.
          </div>
        )}
      </div>

      {loading && <div className="empty">Cargando gráficos…</div>}
      {error && !loading && <div className="empty">Error: {error}</div>}

      {!loading && !error && actual && (
        <>
          {/* Sección A — Facturación y rentabilidad */}
          <h3 className="u-mt-32-mb-12">Facturación y rentabilidad</h3>
          <div className="row charts-row">
            <div className="u-flex-11-380">
              <FacturacionEgresosChart
                hastaMes={periodo}
                meses={6}
                etiquetaId={etiquetaId || null}
                claseId={claseId || null}
              />
            </div>
            <div className="u-flex-1-1-220">
              <MargenNetoCard
                margenActual={actual?.margen_neto_pct}
                margenComparado={comparar ? comparado?.margen_neto_pct : null}
              />
            </div>
          </div>

          {/* Sección B — Composición de ventas.
              Cuando etiqueta_id activo, ocultamos B2 (dona por etiqueta) porque
              queda con 1 solo slice. Cuando clase_id activo, B1 y B3 muestran
              solo esa categoría (1 barra) — igual se muestran para transparencia. */}
          <h3 className="u-mt-32-mb-12">Composición de ventas</h3>
          <div className="row charts-row">
            <div className="u-flex-11-380">
              <UnidadesPorCategoriaChart data={actual?.ventas?.por_categoria} />
            </div>
            {!etiquetaId && (
              <div className="u-flex-11-380">
                <VentasPorEtiquetaChart data={actual?.ventas?.por_etiqueta} />
              </div>
            )}
          </div>
          <div className="row charts-row">
            <div className="u-flex-11-380">
              <FacturacionPorCategoriaChart data={actual?.ventas?.por_categoria} />
            </div>
          </div>

          {/* Sección C — Actividad diaria */}
          <h3 className="u-mt-32-mb-12">Actividad diaria</h3>
          <div className="row charts-row">
            <div className="u-flex-11-380">
              <VentasPorDiaChart data={actual?.ventas?.por_dia} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
