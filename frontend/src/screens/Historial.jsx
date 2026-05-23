import { useState, useEffect, useRef } from 'react';
import { Icons } from '../components/Icons';
import { historial as historialApi } from '../lib/api';

// ─── Formatter ───────────────────────────────────────────────────────────────
function fmt(n) {
  const v = Math.abs(Number(n));
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
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
// We extract the raw action keyword for badge rendering
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

export default function Historial() {
  const [rows, setRows]               = useState([]);
  const [pagination, setPagination]   = useState(null);
  const [page, setPage]               = useState(1);
  const [q, setQ]                     = useState('');
  const [accionFilter, setAccionFilter] = useState('');
  const [loading, setLoading]         = useState(true);

  // Detail modal
  const [detail, setDetail]           = useState(null);

  // Debounce ref for q
  const debounceRef = useRef(null);

  function triggerLoad(newPage) {
    setLoading(true);
    const params = { page: newPage, per_page: 20 };
    if (q.trim()) params.q = q.trim();
    if (accionFilter) params.accion = accionFilter;
    historialApi.list(params)
      .then(res => {
        setRows(res.data || res || []);
        setPagination(res.pagination || null);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }

  // Load when page or accionFilter changes
  useEffect(() => {
    triggerLoad(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, accionFilter]);

  function handleSearch() {
    setPage(1);
    triggerLoad(1);
  }

  function handleQChange(e) {
    setQ(e.target.value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      triggerLoad(1);
    }, 500);
  }

  function handleQKeyDown(e) {
    if (e.key === 'Enter') {
      clearTimeout(debounceRef.current);
      handleSearch();
    }
  }

  // ── KPI counts from current page rows ────────────────────────────────────
  const totalRows = pagination?.total ?? rows.length;
  const countByType = (keyword) =>
    rows.filter(r => {
      const { accion } = parseAccion(r.accion);
      return accion === keyword;
    }).length;

  const totalPages = pagination ? Math.ceil(pagination.total / 20) : 1;

  return (
    <div>
      {/* ── Page header ───────────────────────────────────────────────────── */}
      <div className="page-head">
        <div>
          <div className="page-title">Historial</div>
          <div className="page-sub">Auditoría completa · audit_logs con antes y después</div>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost">
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
        <div className="card-hd flex-between" style={{ flexWrap: 'wrap', gap: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            Eventos — {fmt(totalRows)} total
          </div>
          <div className="flex-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="input-group" style={{ width: 220 }}>
              <span className="addon addon-l"><Icons.Search size={14} /></span>
              <input
                className="input"
                placeholder="Buscar usuario, detalle…"
                value={q}
                onChange={handleQChange}
                onKeyDown={handleQKeyDown}
              />
            </div>
            <button className="btn btn-ghost btn-sm" onClick={handleSearch}>
              Buscar
            </button>
            <select
              className="input"
              style={{ width: 160 }}
              value={accionFilter}
              onChange={e => { setAccionFilter(e.target.value); setPage(1); }}
            >
              <option value="">Todas las acciones</option>
              <option value="INSERT">INSERT</option>
              <option value="UPDATE">UPDATE</option>
              <option value="DELETE">DELETE</option>
              <option value="OCR">OCR</option>
              <option value="LOGIN">LOGIN</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="empty">Cargando historial…</div>
        ) : rows.length === 0 ? (
          <div className="empty">Sin eventos en este período.</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Usuario</th>
                <th>Acción</th>
                <th>Entidad</th>
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
