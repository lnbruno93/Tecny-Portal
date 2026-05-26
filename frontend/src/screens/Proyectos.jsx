import { useState, useEffect, useMemo } from 'react';
import { Icons } from '../components/Icons';
import { proyectos as proyApi, contactos as contactosApi } from '../lib/api';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';

function todayISO() { return new Date().toLocaleDateString('sv'); }
const nombreContacto = (c) => `${c.nombre}${c.apellido ? ' ' + c.apellido : ''}`;

const EMPTY_PROY = { nombre: '', objetivo: '', fecha_creacion: todayISO(), participantes: [] };
const EMPTY_MOV  = { fecha: todayISO(), detalle: '', categoria: '', monto: '', tc: '', monto_usd: '', inversor_contacto_id: '', comentarios: '' };

export default function Proyectos() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [list, setList] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [detalle, setDetalle] = useState(null);        // { ...proyecto, participantes, resumen }
  const [movs, setMovs] = useState([]);
  const [movsPag, setMovsPag] = useState({ page: 1, pages: 1, total: 0 });
  const [loadingMasMovs, setLoadingMasMovs] = useState(false);
  const [contactos, setContactos] = useState([]);

  // Modal alta proyecto
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_PROY);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Alta de movimiento (fila inline)
  const [mov, setMov] = useState(EMPTY_MOV);
  const [savingMov, setSavingMov] = useState(false);

  useEffect(() => { contactosApi.list().then(r => setContactos(Array.isArray(r) ? r : (r.data || []))).catch(() => {}); }, []);

  function loadList() {
    setLoadingList(true);
    proyApi.list(search ? { buscar: search } : {})
      .then(r => setList(r || [])).catch(e => toast.error(e.message))
      .finally(() => setLoadingList(false));
  }
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [search]);

  useEffect(() => {
    setPrimaryAction({ label: 'Nuevo proyecto', onClick: () => { setForm(EMPTY_PROY); setCreateError(''); setShowCreate(true); } });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);

  useEffect(() => {
    if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
  }, [list]); // eslint-disable-line

  useEffect(() => {
    if (!selectedId) { setDetalle(null); setMovs([]); return; }
    setDetalle(null); setMov(EMPTY_MOV);
    Promise.all([proyApi.get(selectedId), proyApi.movimientos(selectedId, { page: 1, limit: 100 })])
      .then(([det, m]) => { setDetalle(det); setMovs(m.data || []); setMovsPag(m.pagination || { page: 1, pages: 1, total: 0 }); })
      .catch(e => toast.error(e.message));
  }, [selectedId]); // eslint-disable-line

  function loadMasMovs() {
    if (!selectedId || loadingMasMovs) return;
    setLoadingMasMovs(true);
    proyApi.movimientos(selectedId, { page: movsPag.page + 1, limit: 100 })
      .then(r => { setMovs(prev => [...prev, ...(r.data || [])]); setMovsPag(r.pagination || movsPag); })
      .catch(e => toast.error(e.message)).finally(() => setLoadingMasMovs(false));
  }

  async function refreshDetalle() {
    const det = await proyApi.get(selectedId); setDetalle(det);
  }

  // USD calculado para la fila de carga: $ ÷ TC, o el USD directo
  const movUsdPreview = useMemo(() => {
    const m = parseFloat(mov.monto), t = parseFloat(mov.tc);
    if (m > 0 && t > 0) return Math.round((m / t) * 100) / 100;
    if (parseFloat(mov.monto_usd) > 0) return parseFloat(mov.monto_usd);
    return 0;
  }, [mov.monto, mov.tc, mov.monto_usd]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.nombre.trim()) { setCreateError('El nombre es obligatorio.'); return; }
    setCreating(true); setCreateError('');
    try {
      const nuevo = await proyApi.create({
        nombre: form.nombre.trim(),
        objetivo: form.objetivo.trim() || null,
        fecha_creacion: form.fecha_creacion,
        participantes: form.participantes,
      });
      setList(prev => [nuevo, ...prev]);
      setSelectedId(nuevo.id);
      setShowCreate(false);
      toast.success('Proyecto creado.');
    } catch (err) { setCreateError(err.message); } finally { setCreating(false); }
  }

  async function handleAddMov(e) {
    e.preventDefault();
    if (!(parseFloat(mov.monto) > 0) && !(parseFloat(mov.monto_usd) > 0) && !mov.detalle.trim()) {
      toast.error('Cargá al menos un monto ($ o USD) o un detalle.'); return;
    }
    setSavingMov(true);
    try {
      await proyApi.createMovimiento({
        proyecto_id: selectedId,
        fecha: mov.fecha,
        detalle: mov.detalle.trim() || null,
        categoria: mov.categoria.trim() || null,
        monto: parseFloat(mov.monto) || 0,
        tc: parseFloat(mov.tc) || null,
        monto_usd: parseFloat(mov.monto_usd) || null,
        inversor_contacto_id: mov.inversor_contacto_id ? Number(mov.inversor_contacto_id) : null,
        comentarios: mov.comentarios.trim() || null,
      });
      // recargar movimientos (página 1) + totales
      const m = await proyApi.movimientos(selectedId, { page: 1, limit: 100 });
      setMovs(m.data || []); setMovsPag(m.pagination || movsPag);
      await refreshDetalle();
      setMov({ ...EMPTY_MOV, fecha: mov.fecha });
      toast.success('Movimiento agregado.');
    } catch (err) { toast.error(err.message); } finally { setSavingMov(false); }
  }

  async function handleDeleteMov(id) {
    const ok = await confirm({ title: 'Eliminar movimiento', message: 'Esta acción no se puede deshacer.', confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await proyApi.deleteMovimiento(id);
      setMovs(prev => prev.filter(m => m.id !== id));
      await refreshDetalle();
    } catch (err) { toast.error(err.message); }
  }

  async function handleDeleteProy() {
    if (!detalle) return;
    const ok = await confirm({ title: 'Eliminar proyecto', message: `Se eliminará "${detalle.nombre}" y sus movimientos.`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await proyApi.delete(detalle.id);
      setList(prev => prev.filter(p => p.id !== detalle.id));
      setSelectedId(null); setDetalle(null);
      toast.success('Proyecto eliminado.');
    } catch (err) { toast.error(err.message); }
  }

  const r = detalle?.resumen || {};

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">Proyectos</div>
          <div className="page-sub">Desarrollo e inversiones por proyecto · línea de tiempo y totales</div>
        </div>
      </div>

      <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, alignItems: 'start' }}>
        {/* ── Lista ── */}
        <div className="card card-flush" style={{ maxHeight: '78vh', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 10 }}>
            <input className="input" placeholder="Buscar proyecto…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {loadingList ? <div className="empty">Cargando…</div>
              : list.length === 0 ? <div className="empty">Sin proyectos. Creá el primero arriba.</div>
              : list.map((p, i) => (
                <div key={p.id} onClick={() => setSelectedId(p.id)} style={{
                  padding: '10px 13px', cursor: 'pointer',
                  borderBottom: i < list.length - 1 ? '1px solid var(--hairline)' : 0,
                  background: selectedId === p.id ? 'var(--surface-2)' : 'transparent',
                  borderLeft: selectedId === p.id ? '3px solid var(--accent)' : '3px solid transparent',
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{p.nombre}</div>
                  <div className="muted tiny" style={{ marginTop: 2 }}>
                    {fmtFecha(p.fecha_creacion)} · {p.cant_movimientos} mov.
                  </div>
                  <div className="mono tiny" style={{ marginTop: 2, color: 'var(--accent)' }}>
                    u$s {fmt(p.total_usd)} {Number(p.total_ars) > 0 && <span className="muted">· $ {fmt(p.total_ars)}</span>}
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* ── Detalle ── */}
        {!detalle ? (
          <div className="card" style={{ minHeight: 200, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
            Elegí un proyecto
          </div>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            {/* Header */}
            <div className="card">
              <div className="flex-between" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 18 }}>{detalle.nombre}</div>
                  {detalle.objetivo && <div className="muted" style={{ marginTop: 4, maxWidth: 600 }}>{detalle.objetivo}</div>}
                  <div className="muted tiny" style={{ marginTop: 6 }}>Creado el {fmtFecha(detalle.fecha_creacion)}</div>
                  {detalle.participantes?.length > 0 && (
                    <div className="flex-row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
                      {detalle.participantes.map(c => <span key={c.id} className="badge badge-info">{nombreContacto(c)}</span>)}
                    </div>
                  )}
                </div>
                <button className="icon-btn" title="Eliminar proyecto" style={{ color: 'var(--neg)' }} onClick={handleDeleteProy}><Icons.Trash size={15} /></button>
              </div>
            </div>

            {/* KPIs */}
            <div className="row">
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Invertido · USD</div>
                <div className="kpi-value mono">u$s {fmt(r.total_usd)}</div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Invertido · $</div>
                <div className="kpi-value mono">$ {fmt(r.total_ars)}</div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Movimientos</div>
                <div className="kpi-value mono">{r.cant_movimientos || 0}</div>
              </div>
              <div className="card card-tight" style={{ flex: 1 }}>
                <div className="kpi-label">Período</div>
                <div className="mono" style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>
                  {r.desde ? `${fmtFecha(r.desde)} → ${fmtFecha(r.hasta)}` : '—'}
                </div>
              </div>
            </div>

            {/* Tabla de movimientos */}
            <div className="card card-flush">
              <div className="card-hd"><div style={{ fontWeight: 600, fontSize: 14 }}>Hoja del proyecto — {r.cant_movimientos || 0} movimientos</div></div>
              <div style={{ overflow: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Fecha</th><th>Detalle</th><th>Categoría</th>
                      <th style={{ textAlign: 'right' }}>$ ARS</th><th style={{ textAlign: 'right' }}>TC</th><th style={{ textAlign: 'right' }}>USD</th>
                      <th>Inversor</th><th>Comentarios</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {movs.map(m => (
                      <tr key={m.id}>
                        <td className="mono tiny">{fmtFecha(m.fecha)}</td>
                        <td>{m.detalle || '—'}</td>
                        <td>{m.categoria ? <span className="badge">{m.categoria}</span> : '—'}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{Number(m.monto) > 0 ? '$ ' + fmt(m.monto) : '—'}</td>
                        <td className="mono tiny" style={{ textAlign: 'right' }}>{m.tc ? fmt(m.tc) : '—'}</td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--accent)' }}>{Number(m.monto_usd) > 0 ? 'u$s ' + fmt(m.monto_usd) : '—'}</td>
                        <td className="tiny">{m.inversor_nombre || '—'}</td>
                        <td className="muted tiny">{m.comentarios || '—'}</td>
                        <td><button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => handleDeleteMov(m.id)}><Icons.Trash size={13} /></button></td>
                      </tr>
                    ))}

                    {/* Fila de carga */}
                    <tr style={{ background: 'rgba(99,102,241,0.05)' }}>
                      <td><input type="date" className="input" style={{ height: 30, fontSize: 12 }} value={mov.fecha} onChange={e => setMov(m => ({ ...m, fecha: e.target.value }))} /></td>
                      <td><input className="input" style={{ height: 30, fontSize: 12 }} placeholder="Detalle…" value={mov.detalle} onChange={e => setMov(m => ({ ...m, detalle: e.target.value }))} /></td>
                      <td><input className="input" list="proy-cats" style={{ height: 30, fontSize: 12 }} placeholder="Categoría" value={mov.categoria} onChange={e => setMov(m => ({ ...m, categoria: e.target.value }))} /></td>
                      <td><input type="number" min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right' }} placeholder="0" value={mov.monto} onChange={e => setMov(m => ({ ...m, monto: e.target.value }))} /></td>
                      <td><input type="number" min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right' }} placeholder="TC" value={mov.tc} onChange={e => setMov(m => ({ ...m, tc: e.target.value }))} /></td>
                      <td>
                        <input type="number" min="0" className="input mono" style={{ height: 30, fontSize: 12, textAlign: 'right', background: movUsdPreview > 0 && (parseFloat(mov.monto) > 0) ? 'rgba(99,102,241,0.08)' : 'var(--surface)' }}
                          placeholder="USD" value={(parseFloat(mov.monto) > 0 && parseFloat(mov.tc) > 0) ? movUsdPreview : mov.monto_usd}
                          readOnly={parseFloat(mov.monto) > 0 && parseFloat(mov.tc) > 0}
                          onChange={e => setMov(m => ({ ...m, monto_usd: e.target.value }))} />
                      </td>
                      <td>
                        <select className="input" style={{ height: 30, fontSize: 12 }} value={mov.inversor_contacto_id} onChange={e => setMov(m => ({ ...m, inversor_contacto_id: e.target.value }))}>
                          <option value="">Inversor…</option>
                          {contactos.map(c => <option key={c.id} value={c.id}>{nombreContacto(c)}</option>)}
                        </select>
                      </td>
                      <td><input className="input" style={{ height: 30, fontSize: 12 }} placeholder="Comentarios" value={mov.comentarios} onChange={e => setMov(m => ({ ...m, comentarios: e.target.value }))} /></td>
                      <td><button className="btn btn-primary btn-sm" disabled={savingMov} onClick={handleAddMov}>{savingMov ? '…' : 'Agregar'}</button></td>
                    </tr>
                  </tbody>
                </table>
                <datalist id="proy-cats">
                  {[...new Set(movs.map(m => m.categoria).filter(Boolean))].map(c => <option key={c} value={c} />)}
                </datalist>
              </div>
              {movsPag.page < movsPag.pages && (
                <div style={{ textAlign: 'center', padding: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={loadMasMovs} disabled={loadingMasMovs}>
                    {loadingMasMovs ? 'Cargando…' : `Ver más antiguos (${movs.length} de ${movsPag.total})`}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Modal: nuevo proyecto ── */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>Nuevo proyecto</h3><button className="icon-btn" onClick={() => setShowCreate(false)}><Icons.X size={16} /></button></div>
            <form onSubmit={handleCreate}>
              <div className="modal-body">
                <div className="stack" style={{ gap: 14 }}>
                  <div className="field">
                    <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                    <input className="input" placeholder="Ej: App iPro v2" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} autoFocus />
                  </div>
                  <div className="field">
                    <label className="field-label">Objetivo</label>
                    <textarea className="input" rows={2} placeholder="¿Qué se busca lograr?" value={form.objetivo} onChange={e => setForm(f => ({ ...f, objetivo: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="field-label">Fecha de creación</label>
                    <input type="date" className="input" value={form.fecha_creacion} onChange={e => setForm(f => ({ ...f, fecha_creacion: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="field-label">Participantes <span className="muted">(de tus contactos)</span></label>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6, maxHeight: 160, overflow: 'auto' }}>
                      {contactos.length === 0 && <div className="muted tiny">No hay contactos cargados.</div>}
                      {contactos.map(c => {
                        const on = form.participantes.includes(c.id);
                        return (
                          <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', border: `1px solid ${on ? 'var(--border-strong)' : 'var(--border)'}`, borderRadius: 8, cursor: 'pointer', background: on ? 'var(--surface-2)' : 'var(--surface)' }}>
                            <input type="checkbox" checked={on} onChange={e => setForm(f => ({ ...f, participantes: e.target.checked ? [...f.participantes, c.id] : f.participantes.filter(x => x !== c.id) }))} style={{ accentColor: 'var(--accent)' }} />
                            <span style={{ fontSize: 12 }}>{nombreContacto(c)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  {createError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{createError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={creating}>{creating ? 'Creando…' : 'Crear proyecto'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
