/**
 * Desglose 360 — vista pivot del inventario.
 *
 * Permite agrupar todo el stock por una dimensión (categoría, proveedor,
 * modelo, estado, depósito, GB, color) y aplicarle filtros globales. Cada
 * fila es clickeable: lleva al listado de Inventario con ese filtro aplicado
 * (drill-down). Acompaña los KPIs totales arriba y un export CSV.
 *
 * Decisiones de diseño:
 *   - Una sola dimensión a la vez (selector "Agrupar por") → la tabla
 *     queda enfocada y los números no se cortan en columnas chiquitas.
 *   - Backend hace el GROUP BY → no traemos miles de filas al cliente.
 *   - Drill-down via query params en /inventario (no rompe la navegación
 *     ni la URL si el usuario quiere compartir el link).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { inventario } from '../lib/api';
import { exportCsv } from '../lib/exportCsv';
import { fmt, fmtMoney } from '../lib/format'; // Hygiene H2 + U-05 auditoría 2026-06-10
// Auditoría 2026-06-30 F-02→05: multi-país. Las columnas "Inv ARS" /
// "Valorizado ARS" mostraban literal "ARS" — para tenants UY hay que
// rotular como "UYU". Datos del backend siguen viniendo en campos `inv_ars`
// / `valorizado_ars` (= moneda local del tenant). Refactor de shape API
// queda fuera de scope.
import { useMonedasTenant } from '../lib/useMonedasTenant';

// Alias local para no tocar todos los callsites — `money` se resuelve al
// helper compartido `fmtMoney` (DRY de wrappers duplicados en Inventario+Desglose360).
const money = fmtMoney;

const DIMENSIONES = [
  { value: 'categoria', label: 'Categoría' },
  { value: 'proveedor', label: 'Proveedor' },
  { value: 'modelo',    label: 'Modelo' },
  { value: 'estado',    label: 'Estado' },
  { value: 'deposito',  label: 'Depósito' },
  { value: 'gb',        label: 'GB' },
  { value: 'color',     label: 'Color' },
];

// Cómo construir la URL de drill-down según la dimensión.
// Para FKs usamos el id; para texto libre, el valor; para estado, su clave.
//
// 2026-07-11 (bug Lucas): las dimensiones que usan `valor_id` (categoria,
// deposito) hacían drilldown con `?categoria_id=null` cuando el row era
// "Sin colección" / "Sin depósito" — el backend rechaza (schema espera INT
// positivo) → toast "Datos inválidos" + chip feo "Colección #null". Fix:
// mismo patrón que proveedor/gb/color: si el row es "sin valor" (valor_id
// nulo), NO aplicamos filtro (drilldown va a Inventario sin restricción).
const DRILLDOWN_PARAM = {
  categoria: (row) => row.valor_id == null ? {} : ({ categoria_id: row.valor_id }),
  proveedor: (row) => row.valor === 'Sin proveedor' ? {} : ({ proveedor: row.valor }),
  modelo:    (row) => ({ nombre: row.valor }),
  estado:    (row) => ({ estado: row.valor }),
  deposito:  (row) => row.valor_id == null ? {} : ({ deposito_id: row.valor_id }),
  gb:        (row) => row.valor === '(sin GB)'    ? {} : ({ gb: row.valor }),
  color:     (row) => row.valor === '(sin color)' ? {} : ({ color: row.valor }),
};

// Etiqueta del estado en formato lindo para la grilla (la dim devuelve raw enum).
const ESTADO_LABEL = {
  disponible: 'Disponible',
  vendido:    'Vendido',
  en_tecnico: 'En técnico',
  reservado:  'Reservado',
};

export default function Desglose360() {
  const navigate = useNavigate();
  // Auditoría 2026-06-30 F-02→05: moneda local del tenant (ARS para AR,
  // UYU para UY) — usada en headers + subtítulos de KPIs + export CSV.
  const { monedaLocal } = useMonedasTenant();

  const [por, setPor] = useState('categoria');
  // F3.d-3: el filtro por categoría ahora usa clase_id (UUID de clases_producto).
  // Antes era `'celular' | 'accesorio'` pre-F1 hardcoded — enum obsoleto.
  const [claseId, setClaseId] = useState('');
  const [clases, setClases] = useState([]);
  const [estadoFiltro, setEstadoFiltro] = useState(''); // '' | 'disponible' | ...
  const [soloStock, setSoloStock] = useState(true);
  const [buscar, setBuscar] = useState('');

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ filas: [], totales: {} });
  // Error inline (no toast): si el fetch falla, lo mostramos en la pantalla.
  // Decisión deliberada — evitamos cualquier riesgo de cadena toast → render → effect
  // → toast → loop. La pantalla es read-only, no hay urgencia de notificación lateral.
  const [error, setError] = useState(null);

  // Carga con debounce para la búsqueda (no consultamos en cada tecla).
  useEffect(() => {
    const t = setTimeout(() => {
      const params = { por };
      if (claseId) params.clase_id = claseId;
      if (estadoFiltro) params.estado = estadoFiltro;
      if (soloStock) params.solo_stock = 'true';
      if (buscar.trim()) params.buscar = buscar.trim();

      setLoading(true);
      setError(null);
      inventario.desglose(params)
        .then(d => { setData(d); setError(null); })
        .catch(e => setError(e.message || 'No se pudo cargar el desglose'))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [por, claseId, estadoFiltro, soloStock, buscar]);

  // F3.d-3: cargar catálogo de clases_producto del tenant para poblar el dropdown.
  useEffect(() => {
    inventario.clases().then(setClases).catch(() => setClases([]));
  }, []);

  // Sort: por inversión total descendente (lo más invertido primero, "dónde está la plata").
  const filasOrdenadas = useMemo(() => {
    return [...(data.filas || [])].sort((a, b) => {
      const ta = (a.inv_usd || 0) + (a.inv_ars || 0) / 1000; // peso simbólico
      const tb = (b.inv_usd || 0) + (b.inv_ars || 0) / 1000;
      return tb - ta;
    });
  }, [data.filas]);

  function drillDown(row) {
    const params = (DRILLDOWN_PARAM[por] || (() => ({})))(row);
    const qs = new URLSearchParams(params).toString();
    navigate(`/inventario${qs ? `?${qs}` : ''}`);
  }

  function exportarCsv() {
    const dimLabel = DIMENSIONES.find(d => d.value === por)?.label || 'Dimensión';
    // Auditoría 2026-06-30 F-02→05: encabezados de moneda local dinámicos
    // (ARS para AR, UYU para UY).
    const rows = [
      [dimLabel, 'Productos', 'Stock (u)', 'Inv USD', `Inv ${monedaLocal}`, 'Valorizado USD', `Valorizado ${monedaLocal}`, 'Margen USD', `Margen ${monedaLocal}`],
      ...filasOrdenadas.map(f => [
        por === 'estado' ? (ESTADO_LABEL[f.valor] || f.valor) : f.valor,
        f.productos, f.stock,
        f.inv_usd, f.inv_ars, f.valorizado_usd, f.valorizado_ars,
        f.margen_usd, f.margen_ars,
      ]),
    ];
    exportCsv(rows, `desglose-${por}.csv`);
  }

  const tot = data.totales || {};

  return (
    <div>
      {/* ── Header ── */}
      <div className="page-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Link to="/inventario" className="btn btn-sm" title="Volver a Inventario">
              <Icons.ArrowRight size={13} style={{ transform: 'rotate(180deg)' }} /> Inventario
            </Link>
            <h1 className="page-title">Desglose 360</h1>
          </div>
          <div className="page-sub">Tu stock filtrado y agrupado · click en una fila para ver el detalle</div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={exportarCsv} disabled={loading || !filasOrdenadas.length}>
            <Icons.Download size={14} /> Exportar CSV
          </button>
        </div>
      </div>

      {/* ── KPIs ── */}
      <div className="row" style={{ marginBottom: 18, gap: 12, flexWrap: 'wrap' }}>
        <div className="card card-tight" style={{ flex: '1 1 180px' }}>
          <div className="kpi-label">Productos</div>
          <div className="kpi-value mono">{fmt(tot.productos)}</div>
          <div className="muted tiny u-mt-6">{fmt(tot.stock)} unidades en total</div>
        </div>
        <div className="card card-tight" style={{ flex: '1 1 180px' }}>
          <div className="kpi-label">Inversión USD</div>
          <div className="kpi-value mono">{money(tot.inv_usd, 'USD')}</div>
          {/* Auditoría 2026-06-30 F-02→05: moneda local dinámica (ARS/UYU). */}
          <div className="muted tiny u-mt-6">{tot.inv_ars ? money(tot.inv_ars, monedaLocal) + ' ' + monedaLocal : '—'}</div>
        </div>
        <div className="card card-tight" style={{ flex: '1 1 180px' }}>
          <div className="kpi-label">Valorizado venta USD</div>
          <div className="kpi-value mono pos">{money(tot.valorizado_usd, 'USD')}</div>
          <div className="muted tiny u-mt-6">{tot.valorizado_ars ? money(tot.valorizado_ars, monedaLocal) + ' ' + monedaLocal : '—'}</div>
        </div>
        <div className="card card-tight" style={{ flex: '1 1 180px' }}>
          <div className="kpi-label">Margen potencial USD</div>
          <div className="kpi-value mono" style={{ color: (tot.margen_usd || 0) >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
            {money(tot.margen_usd, 'USD')}
          </div>
          <div className="muted tiny u-mt-6">
            {tot.inv_usd ? `+${Math.round(((tot.margen_usd || 0) / tot.inv_usd) * 100)}%` : '—'} sobre la inversión
          </div>
        </div>
      </div>

      {/* ── Controles ── */}
      <div className="card card-tight u-mb-14">
        <div className="flex-row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div className="muted tiny u-mb-4">Agrupar por</div>
            <div className="seg">
              {DIMENSIONES.map(d => (
                <button key={d.value} className={por === d.value ? 'on' : ''} onClick={() => setPor(d.value)}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="u-flex-1" />
          <div>
            <div className="muted tiny u-mb-4">Categoría</div>
            <select className="input" style={{ minWidth: 130 }} value={claseId} onChange={e => setClaseId(e.target.value)}>
              <option value="">Todas</option>
              {clases.filter(c => c.activa && !c.es_sin_categoria).map(c => (
                <option key={c.id} value={c.id}>{c.emoji ? `${c.emoji} ${c.nombre}` : c.nombre}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="muted tiny u-mb-4">Estado</div>
            <select className="input" style={{ minWidth: 130 }} value={estadoFiltro} onChange={e => setEstadoFiltro(e.target.value)}>
              <option value="">Todos</option>
              <option value="disponible">Disponible</option>
              <option value="vendido">Vendido</option>
              <option value="en_tecnico">En técnico</option>
              <option value="reservado">Reservado</option>
            </select>
          </div>
          <label className="flex-row" style={{ gap: 6, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer', alignSelf: 'flex-end', paddingBottom: 8 }}>
            <input type="checkbox" checked={soloStock} onChange={e => setSoloStock(e.target.checked)} />
            Solo en stock
          </label>
          <div className="input-group" style={{ width: 240, alignSelf: 'flex-end' }}>
            <span className="addon addon-l"><Icons.Search size={14} /></span>
            <input className="input" placeholder="Buscar nombre, IMEI, color…" value={buscar} onChange={e => setBuscar(e.target.value)} />
          </div>
        </div>
      </div>

      {/* ── Estado / Tabla ── */}
      {error ? (
        <div className="card card-tight" style={{ background: 'rgba(255, 80, 80, 0.08)', border: '1px solid var(--neg)', color: 'var(--text)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <Icons.X size={16} className="u-color-neg" />
            <strong>No se pudo cargar el desglose</strong>
          </div>
          <div className="muted tiny u-mb-10">{error}</div>
          <div className="muted tiny">
            Si recién acabamos de subir esta vista, el backend puede estar todavía desplegando.
            Esperá un par de minutos e intentá de nuevo.
          </div>
        </div>
      ) : loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>Calculando…</div>
      ) : filasOrdenadas.length === 0 ? (
        <div className="empty">Sin resultados para los filtros aplicados.</div>
      ) : (
        <div className="card card-flush" style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>{DIMENSIONES.find(d => d.value === por)?.label}</th>
                <th className="u-text-right">Productos</th>
                <th className="u-text-right">Stock (u)</th>
                <th className="u-text-right">Inv USD</th>
                {/* Auditoría 2026-06-30 F-02→05: header moneda local (ARS/UYU). */}
                <th className="u-text-right">Inv {monedaLocal}</th>
                <th className="u-text-right">Valorizado USD</th>
                <th className="u-text-right">Valorizado {monedaLocal}</th>
                <th className="u-text-right">Margen USD</th>
                <th className="u-text-right">%</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filasOrdenadas.map((f, idx) => {
                const pct = f.inv_usd ? Math.round((f.margen_usd / f.inv_usd) * 100) : null;
                const label = por === 'estado' ? (ESTADO_LABEL[f.valor] || f.valor) : f.valor;
                return (
                  <tr key={(f.valor_id || '') + ':' + f.valor + ':' + idx} className="tbl-row-click" onClick={() => drillDown(f)} title="Ver el detalle en Inventario">
                    <td className="u-fw-600">{label}</td>
                    <td className="mono u-text-right">{fmt(f.productos)}</td>
                    <td className="mono u-text-right">{fmt(f.stock)}</td>
                    <td className="mono u-text-right">{f.inv_usd ? money(f.inv_usd, 'USD') : <span className="muted">—</span>}</td>
                    {/* Auditoría 2026-06-30 F-02→05: símbolo moneda local ($ AR / $U UY). */}
                    <td className="mono u-text-right">{f.inv_ars ? money(f.inv_ars, monedaLocal) : <span className="muted">—</span>}</td>
                    <td className="mono pos u-text-right">{f.valorizado_usd ? money(f.valorizado_usd, 'USD') : <span className="muted">—</span>}</td>
                    <td className="mono pos u-text-right">{f.valorizado_ars ? money(f.valorizado_ars, monedaLocal) : <span className="muted">—</span>}</td>
                    <td className="mono" style={{ textAlign: 'right', color: f.margen_usd >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                      {f.margen_usd ? money(f.margen_usd, 'USD') : <span className="muted">—</span>}
                    </td>
                    <td className="mono muted tiny u-text-right">{pct != null ? pct + '%' : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                      <Icons.ChevronRight size={14} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="muted tiny" style={{ marginTop: 10 }}>
        Tip: click en cualquier fila te lleva al inventario filtrado por ese valor.
      </div>
    </div>
  );
}
