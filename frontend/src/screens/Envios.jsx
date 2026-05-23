import { useState, useEffect, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { envios } from '../lib/api';

// ─── Formatter ────────────────────────────────────────────────────────────────
function fmt(n) {
  const v = Math.abs(Number(n));
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
  return Math.round(v).toLocaleString('es-AR');
}

function fmtFecha(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ─── Estado / Prioridad maps ──────────────────────────────────────────────────
// Backend values are capitalized with spaces: 'Pendiente', 'En camino', 'Entregado', 'Cancelado'
const ESTADO_DISPLAY = {
  'Pendiente': { label: 'Pendiente', tone: 'warn' },
  'En camino': { label: 'En camino', tone: 'info' },
  'Entregado': { label: 'Entregado', tone: 'pos' },
  'Cancelado': { label: 'Cancelado', tone: 'neg' },
};

const PRIO_DISPLAY = {
  'Alta':  { label: 'Alta',  tone: 'neg' },
  'Media': { label: 'Media', tone: 'warn' },
  'Baja':  { label: 'Baja',  tone: 'default' },
};

// ─── Helper components ────────────────────────────────────────────────────────
function Badge({ tone = 'default', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Seg({ value, options, onChange }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button
          key={o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function Envios() {
  const [enviosList, setEnviosList] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [estadoFilter, setEstadoFilter] = useState('todos');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [fechaLabel, setFechaLabel] = useState('Hoy');

  // ── Load on mount ──
  useEffect(() => {
    setLoading(true);
    envios
      .list({ limit: 100 })
      .then(res => {
        const list = res.data || res || [];
        setEnviosList(list);
        if (list.length > 0) setSelectedId(list[0].id);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // ── Client-side filter ──
  const filtered = useMemo(() => {
    return enviosList.filter(e => {
      const matchEstado = estadoFilter === 'todos' || e.estado === estadoFilter;
      const matchSearch =
        !search ||
        (e.cliente + ' ' + (e.direccion || '') + ' ' + (e.barrio || '') + ' ' +
          (e.items || []).map(i => i.descripcion || '').join(' '))
          .toLowerCase()
          .includes(search.toLowerCase());
      return matchEstado && matchSearch;
    });
  }, [enviosList, estadoFilter, search]);

  const selected = enviosList.find(e => e.id === selectedId) || null;

  // ── KPIs ──
  const kpiTotal = enviosList.length;
  const kpiEntregados = enviosList.filter(e => e.estado === 'Entregado').length;
  const kpiEnCamino = enviosList.filter(e => e.estado === 'En camino').length;
  const kpiPendientes = enviosList.filter(e => e.estado === 'Pendiente').length;
  const kpiCobros = enviosList.reduce(
    (s, e) =>
      s + (e.items || []).filter(i => i.tipo === 'pago').reduce((ss, i) => ss + Number(i.monto || 0), 0),
    0
  );

  // ── Update estado ──
  async function handleUpdateEstado(id, newEstado) {
    setUpdatingId(id);
    try {
      // Backend has no /estado sub-route — use the PUT endpoint with partial update
      await envios.update(id, { estado: newEstado });
      setEnviosList(prev => prev.map(e => e.id === id ? { ...e, estado: newEstado } : e));
    } catch (e) {
      alert(e.message);
    } finally {
      setUpdatingId(null);
    }
  }

  // ── Delete envío ──
  async function handleDelete(id) {
    if (!window.confirm('¿Eliminar este envío? Esta acción no se puede deshacer.')) return;
    setDeletingId(id);
    try {
      await envios.delete(id);
      setEnviosList(prev => prev.filter(e => e.id !== id));
      setSelectedId(prev => {
        if (prev !== id) return prev;
        const remaining = enviosList.filter(e => e.id !== id);
        return remaining.length > 0 ? remaining[0].id : null;
      });
    } catch (e) {
      alert(e.message);
    } finally {
      setDeletingId(null);
    }
  }

  // ── Badge helpers ──
  function estadoBadge(s) {
    const d = ESTADO_DISPLAY[s] || { label: s, tone: 'default' };
    return <Badge tone={d.tone}>{d.label}</Badge>;
  }

  function prioridadBadge(p) {
    if (!p) return null;
    const d = PRIO_DISPLAY[p] || { label: p, tone: 'default' };
    return <Badge tone={d.tone}>{d.label}</Badge>;
  }

  // ── Next-estado action label ──
  function nextEstadoLabel(estado) {
    if (estado === 'Pendiente') return 'Marcar en camino';
    if (estado === 'En camino') return 'Marcar entregado';
    return null;
  }

  function nextEstadoValue(estado) {
    if (estado === 'Pendiente') return 'En camino';
    if (estado === 'En camino') return 'Entregado';
    return null;
  }

  return (
    <div>
      {/* ── Page head ── */}
      <div className="page-head">
        <div>
          <h1 className="page-title">Envíos</h1>
          <div className="page-sub">Despachos a domicilio · prioridad · items producto y pago</div>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            onClick={() => {
              setLoading(true);
              envios.list({ limit: 100 }).then(res => {
                const list = res.data || res || [];
                setEnviosList(list);
              }).catch(console.error).finally(() => setLoading(false));
            }}
          >
            <Icons.Refresh size={14} /> Actualizar
          </button>
        </div>
      </div>

      {/* ── KPI row ── */}
      <div className="row" style={{ marginBottom: 18 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Total</div>
          <div className="kpi-value mono">{kpiTotal}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>en sistema</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Entregados</div>
          <div className="kpi-value mono pos">{kpiEntregados}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>esta semana</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">En camino</div>
          <div className="kpi-value mono" style={{ color: 'var(--info)' }}>{kpiEnCamino}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>ahora</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Pendientes</div>
          <div className="kpi-value mono" style={{ color: 'var(--warn)' }}>{kpiPendientes}</div>
          <div className="muted tiny" style={{ marginTop: 6 }}>por despachar</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Cobros en ruta</div>
          <div className="kpi-value">
            <span className="ccy">ARS</span>
            <span className="mono pos">{fmt(kpiCobros)}</span>
          </div>
          <div className="muted tiny" style={{ marginTop: 6 }}>items tipo "pago"</div>
        </div>
      </div>

      {/* ── Date nav + search + filter ── */}
      <div className="flex-between" style={{ marginBottom: 14 }}>
        <div className="flex-row" style={{ gap: 8 }}>
          <button className="icon-btn">
            <Icons.ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <div style={{ fontWeight: 600, fontSize: 14, minWidth: 80, textAlign: 'center' }}>
            {fechaLabel}
          </div>
          <button className="icon-btn">
            <Icons.ChevronRight size={14} />
          </button>
          <button className="btn btn-sm" onClick={() => setFechaLabel('Hoy')}>Hoy</button>
        </div>
        <div className="flex-row" style={{ gap: 8 }}>
          <div className="input-group" style={{ width: 280 }}>
            <span className="addon addon-l"><Icons.Search size={14} /></span>
            <input
              className="input"
              placeholder="Buscar cliente, producto, dirección…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Seg
            value={estadoFilter}
            options={[
              { value: 'todos',     label: 'Todos' },
              { value: 'Pendiente', label: 'Pendientes' },
              { value: 'En camino', label: 'En camino' },
              { value: 'Entregado', label: 'Entregados' },
              { value: 'Cancelado', label: 'Cancelados' },
            ]}
            onChange={setEstadoFilter}
          />
        </div>
      </div>

      {/* ── Loading state ── */}
      {loading && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '12px 0' }}>Cargando…</div>
      )}

      {/* ── Split layout ── */}
      {!loading && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '340px 1fr',
            gap: 12,
            alignItems: 'start',
          }}
        >
          {/* ── Left: envío list ── */}
          <div
            className="stack"
            style={{
              gap: 8,
              maxHeight: 'calc(100vh - 340px)',
              overflowY: 'auto',
              paddingRight: 2,
            }}
          >
            {filtered.length === 0 && (
              <div className="empty">Sin envíos</div>
            )}
            {filtered.map(e => {
              const productos = (e.items || []).filter(i => i.tipo === 'producto');
              const pagos = (e.items || []).filter(i => i.tipo === 'pago');
              const isSelected = selectedId === e.id;
              return (
                <div
                  key={e.id}
                  className="card card-tight"
                  onClick={() => setSelectedId(e.id)}
                  style={{
                    cursor: 'pointer',
                    borderColor: isSelected ? 'var(--accent)' : undefined,
                    background: isSelected ? 'var(--surface-2)' : undefined,
                    borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
                  }}
                >
                  <div className="flex-between" style={{ marginBottom: 8 }}>
                    <div className="flex-row" style={{ gap: 8 }}>
                      <span
                        className="mono tiny"
                        style={{ fontWeight: 700, color: 'var(--accent)', letterSpacing: '0.04em' }}
                      >
                        #{e.id}
                      </span>
                      {prioridadBadge(e.prioridad)}
                      {estadoBadge(e.estado)}
                    </div>
                    <div className="muted tiny mono">{e.horario || fmtFecha(e.fecha)}</div>
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{e.cliente}</div>
                  <div className="muted tiny" style={{ marginTop: 2 }}>{e.direccion}{e.barrio ? ' · ' + e.barrio : ''}</div>
                  <div className="flex-row" style={{ gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
                    {productos.length > 0 && (
                      <div className="flex-row" style={{ gap: 5, fontSize: 12 }}>
                        <Icons.Box size={13} className="muted" />
                        <span className="muted">{productos.length} {productos.length === 1 ? 'producto' : 'productos'}</span>
                      </div>
                    )}
                    {pagos.length > 0 && (
                      <div className="flex-row" style={{ gap: 5, fontSize: 12 }}>
                        <Icons.Dollar size={13} style={{ color: 'var(--pos)' }} />
                        <span className="pos mono" style={{ fontWeight: 600 }}>
                          ARS {fmt(pagos.reduce((s, p) => s + Number(p.monto || 0), 0))}
                        </span>
                      </div>
                    )}
                    {e.operador && (
                      <div className="flex-row" style={{ gap: 5, fontSize: 12, marginLeft: 'auto' }}>
                        <Icons.Users size={13} className="muted" />
                        <span className="muted">{e.operador}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Right: detail panel ── */}
          {selected ? (
            <div
              className="card card-flush"
              style={{ position: 'sticky', top: 16 }}
            >
              {/* Panel header */}
              <div className="card-hd">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      className="mono"
                      style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 13 }}
                    >
                      Envío #{selected.id}
                    </span>
                    {estadoBadge(selected.estado)}
                    {prioridadBadge(selected.prioridad)}
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 16, marginTop: 4 }}>{selected.cliente}</div>
                </div>
              </div>

              {/* Data rows */}
              <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
                <div className="stack" style={{ gap: 8 }}>
                  {[
                    ['Fecha',     fmtFecha(selected.fecha) + (selected.horario ? ' · ' + selected.horario : '')],
                    ['Dirección', selected.direccion + (selected.barrio ? ' · ' + selected.barrio : '')],
                    selected.operador && ['Operador', selected.operador],
                  ].filter(Boolean).map(([label, value]) => (
                    <div
                      key={label}
                      style={{
                        display: 'flex',
                        gap: 12,
                        alignItems: 'flex-start',
                        fontSize: 13,
                      }}
                    >
                      <span
                        className="muted"
                        style={{
                          minWidth: 72,
                          fontWeight: 600,
                          fontSize: 11,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          paddingTop: 1,
                        }}
                      >
                        {label}
                      </span>
                      <span style={{ fontWeight: 500 }}>{value}</span>
                    </div>
                  ))}
                </div>

                {selected.notas && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '10px 12px',
                      background: 'var(--warn-soft, rgba(234,179,8,0.08))',
                      borderLeft: '3px solid var(--warn)',
                      borderRadius: 6,
                      fontSize: 12.5,
                    }}
                  >
                    <strong>Nota:</strong> {selected.notas}
                  </div>
                )}
              </div>

              {/* Items section label */}
              <div
                style={{
                  padding: '10px 18px',
                  background: 'var(--bg-elev)',
                  borderBottom: '1px solid var(--border)',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.10em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                }}
              >
                Items del envío ({(selected.items || []).length})
              </div>

              {/* Items list */}
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                {(selected.items || []).length === 0 && (
                  <div className="empty">Sin items</div>
                )}
                {(selected.items || []).map((it, i, a) => (
                  <div
                    key={i}
                    style={{
                      padding: '12px 18px',
                      borderBottom: i < a.length - 1 ? '1px solid var(--hairline)' : 0,
                    }}
                  >
                    <div className="flex-between">
                      <div className="flex-row" style={{ gap: 10 }}>
                        {it.tipo === 'producto' ? (
                          <>
                            <Icons.Box size={14} className="muted" />
                            <span style={{ fontWeight: 600, fontSize: 13 }}>
                              {it.descripcion || '(sin descripción)'}
                            </span>
                          </>
                        ) : (
                          <>
                            <Icons.Dollar size={14} style={{ color: 'var(--pos)' }} />
                            <span style={{ fontWeight: 600, fontSize: 13 }} className="pos">
                              Cobrar: {it.metodo_pago || 'efectivo'}
                            </span>
                          </>
                        )}
                      </div>
                      {it.tipo === 'pago' && (
                        <span className="mono pos" style={{ fontWeight: 700, fontSize: 13 }}>
                          ARS {fmt(it.monto)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Action buttons */}
              <div style={{ padding: '12px 18px', display: 'flex', gap: 8, borderTop: '1px solid var(--border)' }}>
                {nextEstadoLabel(selected.estado) && (
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={updatingId === selected.id}
                    onClick={() => handleUpdateEstado(selected.id, nextEstadoValue(selected.estado))}
                  >
                    <Icons.Check size={13} />
                    {updatingId === selected.id ? 'Guardando…' : nextEstadoLabel(selected.estado)}
                  </button>
                )}
                {selected.telefono && (
                  <a
                    href={`tel:${selected.telefono}`}
                    className="btn btn-sm"
                    style={{ textDecoration: 'none' }}
                  >
                    <Icons.Phone size={13} /> {selected.telefono}
                  </a>
                )}
                <button
                  className="btn btn-sm"
                  style={{ marginLeft: 'auto', color: 'var(--neg)' }}
                  disabled={deletingId === selected.id}
                  onClick={() => handleDelete(selected.id)}
                >
                  <Icons.Trash size={13} />
                  {deletingId === selected.id ? 'Eliminando…' : 'Eliminar'}
                </button>
              </div>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: 200,
                color: 'var(--text-muted)',
                fontSize: 13,
                border: '1px dashed var(--border)',
                borderRadius: 12,
              }}
            >
              Seleccioná un envío
            </div>
          )}
        </div>
      )}
    </div>
  );
}
