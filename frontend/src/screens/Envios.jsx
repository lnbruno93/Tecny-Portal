import { useState, useEffect, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { envios, cajas as cajasApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';

// ─── Formatter ────────────────────────────────────────────────────────────────
function fmt(n) {
  const v = Math.abs(Number(n));
  return Math.round(v).toLocaleString('es-AR');
}

function fmtFecha(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate.includes('T') ? isoDate : isoDate + 'T00:00:00');
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// ─── Create modal helpers ─────────────────────────────────────────────────────
const EMPTY_FORM = {
  fecha: new Date().toLocaleDateString('sv'),
  cliente: '', telefono: '', direccion: '', barrio: '',
  horario: '', operador: '', notas: '',
  prioridad: '', estado: 'Pendiente',
};
const EMPTY_ITEM = { tipo: 'producto', descripcion: '', monto: '', metodo_pago: '', metodo_pago_id: '' };

// ─── Estado / Prioridad maps ──────────────────────────────────────────────────
// Backend values are capitalized with spaces: 'Pendiente', 'En camino', 'Entregado', 'Cancelado'
const ESTADO_DISPLAY = {
  'Pendiente': { label: 'Pendiente', tone: 'info' },
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
  const { toast } = useToast();
  const confirm   = useConfirm();
  const [enviosList, setEnviosList] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [estadoFilter, setEstadoFilter] = useState('todos');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  // dateFilter: null = todos | 'YYYY-MM-DD' = día específico
  const [dateFilter, setDateFilter] = useState(null);
  const [cajasArs, setCajasArs] = useState([]); // cajas ARS para asignar el cobro

  useEffect(() => {
    cajasApi.listCajas()
      .then(list => setCajasArs((list || []).filter(c => c.activo !== false && c.moneda === 'ARS')))
      .catch(console.error);
  }, []);

  // ── Create modal ──
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState([{ ...EMPTY_ITEM }]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const setF = (field, val) => setForm(f => ({ ...f, [field]: val }));
  const addItem = () => setItems(i => [...i, { ...EMPTY_ITEM }]);
  const rmItem = (idx) => setItems(i => i.filter((_, j) => j !== idx));
  const setItem = (idx, field, val) =>
    setItems(i => i.map((it, j) => j === idx ? { ...it, [field]: val } : it));

  function openCreate() {
    setForm(EMPTY_FORM);
    setItems([{ ...EMPTY_ITEM }]);
    setCreateError('');
    setShowCreate(true);
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.cliente.trim()) { setCreateError('El cliente es obligatorio.'); return; }
    if (!form.direccion.trim()) { setCreateError('La dirección es obligatoria.'); return; }
    setCreating(true);
    setCreateError('');
    try {
      const payload = {
        fecha: form.fecha,
        cliente: form.cliente.trim(),
        telefono: form.telefono.trim() || null,
        direccion: form.direccion.trim(),
        barrio: form.barrio.trim() || null,
        horario: form.horario.trim() || null,
        operador: form.operador.trim() || null,
        notas: form.notas.trim() || null,
        prioridad: form.prioridad || null,
        estado: form.estado || 'Pendiente',
        costo_envio: 0,
        total_cobrado: items.filter(i => i.tipo === 'pago').reduce((s, i) => s + (Number(i.monto) || 0), 0),
        items: items
          .filter(i => i.descripcion.trim() || i.tipo === 'pago')
          .map(i => ({
            tipo: i.tipo,
            descripcion: i.descripcion.trim() || null,
            monto: Number(i.monto) || 0,
            metodo_pago: i.metodo_pago.trim() || null,
            metodo_pago_id: (i.tipo === 'pago' && i.metodo_pago_id) ? Number(i.metodo_pago_id) : null,
          })),
      };
      const nuevo = await envios.create(payload);
      setEnviosList(prev => [{ ...nuevo, items: payload.items }, ...prev]);
      setSelectedId(nuevo.id);
      setShowCreate(false);
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  }

  // ── Register global + action ──
  const { setPrimaryAction } = usePageActions();
  useEffect(() => {
    setPrimaryAction({ label: 'Nuevo envío', onClick: openCreate });
    return () => setPrimaryAction(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPrimaryAction]);

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

  // ── Date helpers ──────────────────────────────────────────────────────────
  function todayStr() { return new Date().toLocaleDateString('sv'); } // 'sv' = YYYY-MM-DD
  function shiftDate(isoStr, days) {
    const d = new Date(isoStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('sv');
  }
  function dateLabel(isoStr) {
    if (!isoStr) return 'Todos los días';
    const today = todayStr();
    const yesterday = shiftDate(today, -1);
    const tomorrow  = shiftDate(today, +1);
    if (isoStr === today)     return 'Hoy';
    if (isoStr === yesterday) return 'Ayer';
    if (isoStr === tomorrow)  return 'Mañana';
    const d = new Date(isoStr + 'T00:00:00');
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  // ── Client-side filter ──
  const filtered = useMemo(() => {
    return enviosList.filter(e => {
      const matchEstado = estadoFilter === 'todos' || e.estado === estadoFilter;
      const matchDate   = !dateFilter || (e.fecha && e.fecha.startsWith(dateFilter));
      const matchSearch =
        !search ||
        (e.cliente + ' ' + (e.direccion || '') + ' ' + (e.barrio || '') + ' ' +
          (e.items || []).map(i => i.descripcion || '').join(' '))
          .toLowerCase()
          .includes(search.toLowerCase());
      return matchEstado && matchDate && matchSearch;
    });
  }, [enviosList, estadoFilter, dateFilter, search]);

  const selected = enviosList.find(e => e.id === selectedId) || null;

  // ── KPIs ──
  // "esta semana" = lunes al domingo de la semana actual
  const weekStart = useMemo(() => {
    const d = new Date();
    const day = d.getDay(); // 0 = domingo
    const diff = day === 0 ? -6 : 1 - day; // ajustar a lunes
    d.setDate(d.getDate() + diff);
    return d.toLocaleDateString('sv');
  }, []);

  const kpiTotal = enviosList.length;
  const kpiEntregados = enviosList.filter(e =>
    e.estado === 'Entregado' && e.fecha && e.fecha >= weekStart
  ).length;
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
      toast.error(e.message);
    } finally {
      setUpdatingId(null);
    }
  }

  // ── Delete envío ──
  async function handleDelete(id) {
    const ok = await confirm({ title: 'Eliminar envío', message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    setDeletingId(id);
    try {
      await envios.delete(id);
      const remaining = enviosList.filter(e => e.id !== id);
      setEnviosList(remaining);
      setSelectedId(prev => prev === id ? (remaining[0]?.id ?? null) : prev);
      toast.success('Envío eliminado.');
    } catch (e) {
      toast.error(e.message);
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
          <button
            className="icon-btn"
            title="Día anterior"
            onClick={() => setDateFilter(d => d ? shiftDate(d, -1) : shiftDate(todayStr(), -1))}
          >
            <Icons.ChevronRight size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <div style={{ fontWeight: 600, fontSize: 14, minWidth: 96, textAlign: 'center' }}>
            {dateLabel(dateFilter)}
          </div>
          <button
            className="icon-btn"
            title="Día siguiente"
            onClick={() => setDateFilter(d => d ? shiftDate(d, +1) : shiftDate(todayStr(), +1))}
          >
            <Icons.ChevronRight size={14} />
          </button>
          <button
            className="btn btn-sm"
            style={dateFilter === todayStr() ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : {}}
            onClick={() => setDateFilter(todayStr())}
          >
            Hoy
          </button>
          {dateFilter && (
            <button className="btn btn-sm btn-ghost" onClick={() => setDateFilter(null)}>
              Todos
            </button>
          )}
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

      {/* ── Modal: Nuevo envío ─────────────────────────────────────────── */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" style={{ maxWidth: 600 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>Nuevo envío</h3>
              <button className="icon-btn" onClick={() => setShowCreate(false)}>
                <Icons.X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                <div className="stack" style={{ gap: 16 }}>

                  {/* Fila 1: fecha + estado + prioridad */}
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Fecha <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input type="date" className="input" value={form.fecha}
                        onChange={e => setF('fecha', e.target.value)} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Estado</label>
                      <select className="input" value={form.estado} onChange={e => setF('estado', e.target.value)}>
                        <option>Pendiente</option>
                        <option>En camino</option>
                        <option>Entregado</option>
                        <option>Cancelado</option>
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Prioridad</label>
                      <select className="input" value={form.prioridad} onChange={e => setF('prioridad', e.target.value)}>
                        <option value="">Sin prioridad</option>
                        <option>Alta</option>
                        <option>Media</option>
                        <option>Baja</option>
                      </select>
                    </div>
                  </div>

                  {/* Fila 2: cliente + teléfono */}
                  <div className="row">
                    <div className="field" style={{ flex: 2 }}>
                      <label className="field-label">Cliente <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className="input" placeholder="Nombre del cliente"
                        value={form.cliente} onChange={e => setF('cliente', e.target.value)} autoFocus />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Teléfono</label>
                      <input className="input" placeholder="ej. 3416123456"
                        value={form.telefono} onChange={e => setF('telefono', e.target.value)} />
                    </div>
                  </div>

                  {/* Fila 3: dirección + barrio */}
                  <div className="row">
                    <div className="field" style={{ flex: 2 }}>
                      <label className="field-label">Dirección <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className="input" placeholder="ej. San Martín 450"
                        value={form.direccion} onChange={e => setF('direccion', e.target.value)} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Barrio</label>
                      <input className="input" placeholder="ej. Centro"
                        value={form.barrio} onChange={e => setF('barrio', e.target.value)} />
                    </div>
                  </div>

                  {/* Fila 4: horario + operador */}
                  <div className="row">
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Horario</label>
                      <input className="input" placeholder="ej. 10:00-12:00"
                        value={form.horario} onChange={e => setF('horario', e.target.value)} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Operador</label>
                      <input className="input" placeholder="Quién despacha"
                        value={form.operador} onChange={e => setF('operador', e.target.value)} />
                    </div>
                  </div>

                  {/* Notas */}
                  <div className="field">
                    <label className="field-label">Notas</label>
                    <input className="input" placeholder="Instrucciones, detalles…"
                      value={form.notas} onChange={e => setF('notas', e.target.value)} />
                  </div>

                  {/* Items */}
                  <div>
                    <div className="flex-between" style={{ marginBottom: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>Items del envío</div>
                      <button type="button" className="btn btn-sm" onClick={addItem}>
                        <Icons.Plus size={13} /> Agregar item
                      </button>
                    </div>
                    <div className="stack" style={{ gap: 8 }}>
                      {items.map((it, idx) => (
                        <div key={idx} className="card card-tight" style={{ padding: '10px 12px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 120px auto', gap: 8, alignItems: 'end' }}>
                            <div className="field" style={{ marginBottom: 0 }}>
                              <label className="field-label">Tipo</label>
                              <select className="input" value={it.tipo}
                                onChange={e => setItem(idx, 'tipo', e.target.value)}>
                                <option value="producto">Producto</option>
                                <option value="pago">Pago</option>
                              </select>
                            </div>
                            <div className="field" style={{ marginBottom: 0 }}>
                              <label className="field-label">Descripción</label>
                              <input className="input" placeholder={it.tipo === 'pago' ? 'Método de pago…' : 'Producto…'}
                                value={it.descripcion} onChange={e => setItem(idx, 'descripcion', e.target.value)} />
                            </div>
                            <div className="field" style={{ marginBottom: 0 }}>
                              <label className="field-label">Monto ARS</label>
                              <input type="number" className="input mono" placeholder="0"
                                value={it.monto} onChange={e => setItem(idx, 'monto', e.target.value)} />
                            </div>
                            <button type="button" className="icon-btn"
                              style={{ marginBottom: 1, visibility: items.length > 1 ? 'visible' : 'hidden' }}
                              onClick={() => rmItem(idx)}>
                              <Icons.X size={14} />
                            </button>
                          </div>
                          {it.tipo === 'pago' && cajasArs.length > 0 && (
                            <div className="field" style={{ marginBottom: 0, marginTop: 8 }}>
                              <label className="field-label">Caja (ARS) donde ingresa el cobro</label>
                              <select className="input" value={it.metodo_pago_id}
                                onChange={e => setItem(idx, 'metodo_pago_id', e.target.value)}>
                                <option value="">Sin caja (no impacta)…</option>
                                {cajasArs.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                              </select>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {createError && (
                    <div style={{ color: 'var(--neg)', fontSize: 13 }}>{createError}</div>
                  )}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Guardando…' : 'Crear envío'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
