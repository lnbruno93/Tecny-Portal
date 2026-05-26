import { useState, useEffect, useRef } from 'react';
import { Icons } from '../components/Icons';
import { historial as historialApi } from '../lib/api';
import { exportCsv } from '../lib/exportCsv';

// ─── Formatter ───────────────────────────────────────────────────────────────
function fmt(n) {
  const v = Math.abs(Number(n));
  return Math.round(v).toLocaleString('es-AR');
}

function rel(iso) {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
}

// accion from backend looks like "tabla: ACCION", e.g. "comprobantes: INSERT"
function parseAccion(accionStr) {
  if (!accionStr) return { tabla: '', accion: '' };
  const idx = accionStr.lastIndexOf(': ');
  if (idx === -1) return { tabla: '', accion: accionStr.toUpperCase() };
  return {
    tabla: accionStr.slice(0, idx),
    accion: accionStr.slice(idx + 2).toUpperCase(),
  };
}

const ACCION_DISPLAY = {
  INSERT: { label: 'CREAR',  cls: 'badge-pos'    },
  UPDATE: { label: 'EDITAR', cls: 'badge-info'   },
  DELETE: { label: 'BORRAR', cls: 'badge-neg'    },
  OCR:    { label: 'OCR',    cls: 'badge-accent' },
  LOGIN:  { label: 'LOGIN',  cls: 'badge-default'},
};

function AccionBadge({ raw }) {
  const { accion } = parseAccion(raw);
  const meta = ACCION_DISPLAY[accion];
  if (!meta) return <span className="badge badge-default">{accion || raw}</span>;
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>;
}

// Módulos auditados con etiqueta legible
const TABLAS_OPTS = [
  { value: 'comprobantes',           label: 'Comprobantes'      },
  { value: 'pagos',                  label: 'Pagos'             },
  { value: 'envios',                 label: 'Envíos'            },
  { value: 'contactos',              label: 'Contactos'         },
  { value: 'vendedores',             label: 'Vendedores'        },
  { value: 'clientes_cc',            label: 'Cuentas CC'        },
  { value: 'movimientos_cc',         label: 'CC Movimientos'    },
  { value: 'catalogo_usados',        label: 'Usados'            },
  { value: 'movimientos_deudas',     label: 'Cajas — Deudas'    },
  { value: 'movimientos_inversiones',label: 'Cajas — Inversiones'},
  { value: 'users',                  label: 'Usuarios'          },
  { value: 'config',                 label: 'Configuración'     },
];

export default function Historial() {
  const [rows, setRows]             = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(true);

  // Filtros
  const [q, setQ]                     = useState('');
  const [debouncedQ, setDebouncedQ]   = useState('');
  const [accionFilter, setAccionFilter] = useState('');
  const [tablaFilter, setTablaFilter]   = useState('');
  const [desde, setDesde]             = useState('');
  const [hasta, setHasta]             = useState('');

  // Detail modal
  const [detail, setDetail] = useState(null);

  // ── Debounce del campo de búsqueda ───────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 450);
    return () => clearTimeout(t);
  }, [q]);

  // ── Carga de datos (sin stale closure — todos los filtros son deps) ───────
  useEffect(() => {
    let mounted = true;
    setLoading(true);

    const params = { page, limit: 20 };
    if (debouncedQ.trim()) params.q     = debouncedQ.trim();
    if (accionFilter)       params.accion = accionFilter;
    if (tablaFilter)        params.tabla  = tablaFilter;
    if (desde)              params.desde  = desde;
    if (hasta)              params.hasta  = hasta;

    historialApi.list(params)
      .then(res => {
        if (!mounted) return;
        setRows(res.data || []);
        setPagination(res.pagination || null);
      })
      .catch(err => { if (mounted) console.error(err); })
      .finally(() => { if (mounted) setLoading(false); });

    return () => { mounted = false; };
  }, [page, debouncedQ, accionFilter, tablaFilter, desde, hasta]);

  // Handlers de filtros con select/date — siempre vuelven a pág 1
  function handleAccion(e)  { setAccionFilter(e.target.value); setPage(1); }
  function handleTabla(e)   { setTablaFilter(e.target.value);  setPage(1); }
  function handleDesde(e)   { setDesde(e.target.value);        setPage(1); }
  function handleHasta(e)   { setHasta(e.target.value);        setPage(1); }

  function handleQKeyDown(e) {
    if (e.key === 'Enter') {
      // Flush debounce inmediatamente
      setDebouncedQ(q);
      setPage(1);
    }
  }

  function clearFilters() {
    setQ(''); setDebouncedQ('');
    setAccionFilter(''); setTablaFilter('');
    setDesde(''); setHasta('');
    setPage(1);
  }

  const hayFiltros = q || accionFilter || tablaFilter || desde || hasta;

  // ── KPI counts desde la página actual ────────────────────────────────────
  const totalRows = pagination?.total ?? rows.length;
  const countByType = (keyword) =>
    rows.filter(r => parseAccion(r.accion).accion === keyword).length;
  const totalPages = pagination ? Math.ceil(pagination.total / 20) : 1;

  // ── Exportar CSV ─────────────────────────────────────────────────────────
  function handleExport() {
    const csvRows = rows.map(h => {
      const { tabla, accion } = parseAccion(h.accion);
      return { ...h, _tabla: tabla, _accion: accion };
    });
    exportCsv(
      'historial-' + new Date().toLocaleDateString('sv') + '.csv',
      csvRows,
      [
        { key: 'creado_en',      label: 'Fecha'    },
        { key: 'usuario_nombre', label: 'Usuario'  },
        { key: '_tabla',         label: 'Módulo'   },
        { key: '_accion',        label: 'Acción'   },
        { key: 'detalle',        label: 'Detalle'  },
      ]
    );
  }

  return (
    <div>
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div className="page-head">
        <div>
          <div className="page-title">Historial</div>
          <div className="page-sub">Auditoría completa · audit_logs con antes y después</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={handleExport}>
            <Icons.Download size={15} />
            Exportar
          </button>
        </div>
      </div>

      {/* ── KPI cards ─────────────────────────────────────────────────────── */}
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Total eventos</div>
          <div className="kpi-value mono">{fmt(totalRows)}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">INSERT</div>
          <div className="kpi-value mono"><span className="pos">{countByType('INSERT')}</span></div>
          <div className="muted tiny" style={{ marginTop: 2 }}>en esta página</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">UPDATE</div>
          <div className="kpi-value mono" style={{ color: 'var(--info)' }}>{countByType('UPDATE')}</div>
          <div className="muted tiny" style={{ marginTop: 2 }}>en esta página</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">DELETE</div>
          <div className="kpi-value mono"><span className="neg">{countByType('DELETE')}</span></div>
          <div className="muted tiny" style={{ marginTop: 2 }}>en esta página</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">OCR</div>
          <div className="kpi-value mono" style={{ color: 'var(--accent)' }}>{countByType('OCR')}</div>
          <div className="muted tiny" style={{ marginTop: 2 }}>en esta página</div>
        </div>
      </div>

      {/* ── Table card ────────────────────────────────────────────────────── */}
      <div className="card card-flush">
        <div className="card-hd" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            Eventos{hayFiltros ? ' · filtrado' : ''} — {fmt(totalRows)} resultado{totalRows !== 1 ? 's' : ''}
          </div>

          {/* ── Fila de filtros ─────────────────────────────────────────── */}
          <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Búsqueda libre */}
            <div className="input-group" style={{ width: 210 }}>
              <span className="addon addon-l"><Icons.Search size={14} /></span>
              <input
                className="input"
                placeholder="Buscar usuario, detalle…"
                value={q}
                onChange={e => setQ(e.target.value)}
                onKeyDown={handleQKeyDown}
              />
            </div>

            {/* Módulo */}
            <select
              className="input"
              style={{ width: 172 }}
              value={tablaFilter}
              onChange={handleTabla}
            >
              <option value="">Todos los módulos</option>
              {TABLAS_OPTS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>

            {/* Acción */}
            <select
              className="input"
              style={{ width: 148 }}
              value={accionFilter}
              onChange={handleAccion}
            >
              <option value="">Todas las acciones</option>
              <option value="INSERT">INSERT</option>
              <option value="UPDATE">UPDATE</option>
              <option value="DELETE">DELETE</option>
              <option value="OCR">OCR</option>
              <option value="LOGIN">LOGIN</option>
            </select>

            {/* Rango de fechas */}
            <input
              type="date"
              className="input"
              style={{ width: 136 }}
              title="Desde"
              value={desde}
              onChange={handleDesde}
            />
            <input
              type="date"
              className="input"
              style={{ width: 136 }}
              title="Hasta"
              value={hasta}
              onChange={handleHasta}
            />

            {/* Limpiar filtros */}
            {hayFiltros && (
              <button className="btn btn-ghost btn-sm" onClick={clearFilters} title="Limpiar filtros">
                <Icons.X size={13} />
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="empty">Cargando historial…</div>
        ) : rows.length === 0 ? (
          <div className="empty">Sin eventos para los filtros seleccionados.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Usuario</th>
                <th>Acción</th>
                <th>Módulo</th>
                <th>Detalle</th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(h => {
                const { tabla } = parseAccion(h.accion);
                return (
                  <tr key={h.id} className="tbl-row-click">
                    <td className="muted mono tiny" style={{ whiteSpace: 'nowrap' }}>
                      {rel(h.creado_en)}
                    </td>
                    <td style={{ fontWeight: 600 }}>
                      {h.usuario_nombre || <span className="dim">Sistema</span>}
                    </td>
                    <td><AccionBadge raw={h.accion} /></td>
                    <td className="mono tiny" style={{ color: 'var(--text-2)' }}>
                      {tabla || <span className="dim">—</span>}
                    </td>
                    <td className="tiny" style={{ fontSize: 12.5, maxWidth: 300 }}>
                      {h.detalle || <span className="dim">—</span>}
                    </td>
                    <td>
                      <button
                        className="icon-btn"
                        title="Ver detalle JSON"
                        onClick={() => setDetail(h)}
                      >
                        <Icons.Eye size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ────────────────────────────────────────────────────── */}
      <div className="flex-between" style={{ marginTop: 14 }}>
        <div className="muted tiny">
          Página {page} de {totalPages} · {fmt(totalRows)} evento{totalRows !== 1 ? 's' : ''}
        </div>
        <div className="flex-row" style={{ gap: 6 }}>
          <button
            className="btn btn-ghost btn-sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage(p => p - 1)}
          >
            Anterior
          </button>
          <span className="btn btn-primary btn-sm" style={{ pointerEvents: 'none' }}>
            {page}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage(p => p + 1)}
          >
            Siguiente
          </button>
        </div>
      </div>

      {/* ── Detail modal ──────────────────────────────────────────────────── */}
      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <span style={{ fontWeight: 600 }}>Detalle del evento #{detail.id}</span>
              <button className="icon-btn" onClick={() => setDetail(null)}>
                <Icons.X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="muted tiny" style={{ marginBottom: 8 }}>
                {detail.accion} · {detail.usuario_nombre || 'Sistema'} · {rel(detail.creado_en)}
              </div>
              <pre style={{
                fontSize: 12,
                lineHeight: 1.6,
                background: 'var(--surface-2)',
                borderRadius: 8,
                padding: 14,
                overflow: 'auto',
                maxHeight: 400,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {JSON.stringify(detail, null, 2)}
              </pre>
            </div>
            <div className="modal-ft">
              <button className="btn btn-ghost btn-sm" onClick={() => setDetail(null)}>
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
