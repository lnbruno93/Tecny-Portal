import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Icons } from '../components/Icons';
import { egresos as egresosApi, cajas as cajasApi } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { fmt, fmtFecha } from '../lib/format';
import { blockInvalidNumberKeys } from '../lib/inputUtils'; // #F-1
import CajaSelectHint from '../components/CajaSelectHint';
import TcWarning from '../components/TcWarning';
import useModal from '../lib/useModal';
// 2026-06-29 Multi-país F3: dropdowns moneda gated por tenant.pais.
import { useMonedasTenant } from '../lib/useMonedasTenant';


const thisMonth = () => new Date().toISOString().slice(0, 7); // YYYY-MM
const lastDay = (periodo) => { const [y, m] = periodo.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const cajaNombre = (c) => `${c.nombre}${c.moneda ? ' · ' + c.moneda : ''}`;
const EMPTY = { fecha: new Date().toISOString().slice(0, 10), concepto: '', categoria_id: '', monto: '', moneda: 'USD', tc: '', metodo_pago_id: '', estado: 'pendiente', notas: '' };

export default function EgresosPanel() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  // 2026-06-29 Multi-país F3: monedas operativas según país del tenant.
  const { monedas } = useMonedasTenant();

  const [periodo, setPeriodo] = useState(thisMonth());
  const [estadoFiltro, setEstadoFiltro] = useState('');
  const [catFiltro, setCatFiltro] = useState('');
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cajas, setCajas] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [recurrentes, setRecurrentes] = useState([]);

  // Modales
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [showCats, setShowCats] = useState(false);
  const [showRec, setShowRec] = useState(false);
  const formModalRef = useRef(null);
  useModal({ open: showForm, onClose: () => setShowForm(false), overlayRef: formModalRef });

  const loadList = useCallback(() => {
    setLoading(true);
    const params = { desde: `${periodo}-01`, hasta: `${periodo}-${String(lastDay(periodo)).padStart(2, '0')}`, limit: 500 };
    if (estadoFiltro) params.estado = estadoFiltro;
    if (catFiltro) params.categoria_id = catFiltro;
    egresosApi.list(params)
      .then(r => setList(r.data || []))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [periodo, estadoFiltro, catFiltro, toast]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => {
    cajasApi.listCajas().then(r => setCajas(Array.isArray(r) ? r : [])).catch(() => {});
    egresosApi.categorias().then(setCategorias).catch(() => {});
    egresosApi.recurrentes().then(setRecurrentes).catch(() => {});
  }, []);

  const totales = useMemo(() => list.reduce((a, e) => {
    const usd = Number(e.monto_usd || 0);
    if (e.estado === 'pagado') a.pagado += usd; else a.pendiente += usd;
    return a;
  }, { pagado: 0, pendiente: 0 }), [list]);

  function openCreate() { setEditId(null); setForm(EMPTY); setFormError(''); setShowForm(true); }
  function openEdit(e) {
    setEditId(e.id);
    setForm({
      fecha: e.fecha?.slice(0, 10) || EMPTY.fecha, concepto: e.concepto || '', categoria_id: e.categoria_id || '',
      monto: e.monto ?? '', moneda: e.moneda || 'USD', tc: e.tc ?? '', metodo_pago_id: e.metodo_pago_id || '',
      estado: e.estado || 'pendiente', notas: e.notas || '',
    });
    setFormError(''); setShowForm(true);
  }

  async function handleSubmit(ev) {
    ev.preventDefault();
    if (!form.concepto.trim()) { setFormError('El concepto es obligatorio.'); return; }
    if (form.estado === 'pagado' && !form.metodo_pago_id) { setFormError('Para marcar pagado, elegí la caja de donde sale.'); return; }
    setSaving(true); setFormError('');
    const payload = {
      fecha: form.fecha, concepto: form.concepto.trim(),
      categoria_id: form.categoria_id ? Number(form.categoria_id) : null,
      monto: Number(form.monto) || 0, moneda: form.moneda, tc: form.tc ? Number(form.tc) : null,
      metodo_pago_id: form.metodo_pago_id ? Number(form.metodo_pago_id) : null,
      estado: form.estado, notas: form.notas.trim() || null,
    };
    try {
      if (editId) await egresosApi.update(editId, payload);
      else await egresosApi.create(payload);
      setShowForm(false); loadList();
      toast.success(editId ? 'Egreso actualizado.' : 'Egreso creado.');
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }

  async function togglePagado(e) {
    if (e.estado === 'pendiente' && !e.metodo_pago_id) { openEdit({ ...e, estado: 'pagado' }); return; }
    try {
      await egresosApi.update(e.id, { estado: e.estado === 'pagado' ? 'pendiente' : 'pagado' });
      loadList();
    } catch (err) { toast.error(err.message); }
  }

  async function handleDelete(e) {
    const ok = await confirm({ title: 'Eliminar egreso', message: `Se eliminará "${e.concepto}".${e.estado === 'pagado' ? ' Se revertirá el movimiento en la caja.' : ''}`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await egresosApi.delete(e.id); loadList(); toast.success('Egreso eliminado.'); }
    catch (err) { toast.error(err.message); }
  }

  async function generarPeriodo() {
    try {
      const r = await egresosApi.generar(periodo);
      toast.success(r.generados > 0 ? `${r.generados} egreso(s) generado(s).` : 'No hay nuevos egresos para generar.');
      loadList();
    } catch (err) { toast.error(err.message); }
  }

  return (
    <div>
      {/* Filtros + acciones */}
      <div className="flex-row" style={{ gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="month" className="input" style={{ maxWidth: 160 }} value={periodo} onChange={e => setPeriodo(e.target.value)} />
        <select className="input" style={{ maxWidth: 160 }} value={estadoFiltro} onChange={e => setEstadoFiltro(e.target.value)}>
          <option value="">Todos</option><option value="pendiente">Pendientes</option><option value="pagado">Pagados</option>
        </select>
        <select className="input" style={{ maxWidth: 180 }} value={catFiltro} onChange={e => setCatFiltro(e.target.value)}>
          <option value="">Todas las categorías</option>
          {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowCats(true)}><Icons.Tag size={13} /> Categorías</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowRec(true)}><Icons.Refresh size={13} /> Recurrentes</button>
          <button className="btn btn-ghost btn-sm" onClick={generarPeriodo}><Icons.Calendar size={13} /> Generar del mes</button>
          <button className="btn btn-primary btn-sm" onClick={openCreate}><Icons.Plus size={13} /> Nuevo egreso</button>
        </div>
      </div>

      {/* KPIs */}
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Pendiente · USD</div>
          <div className="kpi-value mono" style={{ color: 'var(--warn, #d97706)' }}>u$s {fmt(totales.pendiente)}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Pagado · USD</div>
          <div className="kpi-value mono" style={{ color: 'var(--neg)' }}>u$s {fmt(totales.pagado)}</div>
        </div>
        <div className="card card-tight" style={{ flex: 1 }}>
          <div className="kpi-label">Total del mes · USD</div>
          <div className="kpi-value mono">u$s {fmt(totales.pendiente + totales.pagado)}</div>
        </div>
      </div>

      <div className="card card-flush">
        {loading ? <div className="empty">Cargando…</div>
          : list.length === 0 ? <div className="empty">Sin egresos en el período. Cargá uno o generá los recurrentes.</div>
          : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Caja</th>
                  <th style={{ textAlign: 'right' }}>Monto</th><th style={{ textAlign: 'right' }}>USD</th><th>Estado</th><th></th>
                </tr>
              </thead>
              <tbody>
                {list.map(e => (
                  <tr key={e.id}>
                    <td className="mono tiny">{fmtFecha(e.fecha)}</td>
                    <td style={{ fontWeight: 600 }}>{e.concepto}{e.recurrente_id ? <span className="muted tiny" title="Generado de un recurrente"> ↻</span> : ''}</td>
                    <td>{e.categoria_nombre ? <span className="badge">{e.categoria_nombre}</span> : '—'}</td>
                    <td className="tiny">{e.caja_nombre || '—'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{Number(e.monto) > 0 ? `${e.moneda === 'ARS' ? '$' : 'u$s'} ${fmt(e.monto)}` : '—'}</td>
                    <td className="mono" style={{ textAlign: 'right', color: 'var(--neg)' }}>u$s {fmt(e.monto_usd)}</td>
                    <td>
                      <button className={'badge ' + (e.estado === 'pagado' ? 'badge-info' : '')} style={{ cursor: 'pointer', border: 'none' }}
                        title={e.estado === 'pagado' ? 'Marcar pendiente' : 'Marcar pagado'} onClick={() => togglePagado(e)}>
                        {e.estado === 'pagado' ? 'Pagado ✓' : 'Pendiente'}
                      </button>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title="Editar" onClick={() => openEdit(e)}><Icons.Edit size={14} /></button>
                      <button className="icon-btn" title="Eliminar" style={{ color: 'var(--neg)' }} onClick={() => handleDelete(e)}><Icons.Trash size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* Modal alta/edición */}
      {showForm && (
        <div ref={formModalRef} className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><h3>{editId ? 'Editar egreso' : 'Nuevo egreso'}</h3><button className="icon-btn" onClick={() => setShowForm(false)}><Icons.X size={16} /></button></div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="stack" style={{ gap: 12 }}>
                  <div className="row" style={{ gap: 12 }}>
                    {/* 2026-06-25 UX-6 (audit pre-live): marker `*` rojo consistente
                        con el patrón usado en el resto del proyecto (Contactos,
                        Usuarios, CuentasCC). EgresosPanel era el único que usaba
                        `*` plano sin estilizar — desprolijo visto lado a lado. */}
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Fecha <span style={{ color: 'var(--neg)' }}>*</span></label><input type="date" className="input" value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} /></div>
                    <div className="field" style={{ flex: 2 }}><label className="field-label">Concepto <span style={{ color: 'var(--neg)' }}>*</span></label><input className="input" placeholder="Alquiler, sueldos…" value={form.concepto} onChange={e => setForm(f => ({ ...f, concepto: e.target.value }))} autoFocus /></div>
                  </div>
                  <div className="row" style={{ gap: 12 }}>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Categoría</label>
                      <select className="input" value={form.categoria_id} onChange={e => setForm(f => ({ ...f, categoria_id: e.target.value }))}>
                        <option value="">— Sin categoría —</option>
                        {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Monto</label>
                      <div className="flex-row" style={{ gap: 6 }}>
                        <input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" placeholder="0" value={form.monto} onChange={e => setForm(f => ({ ...f, monto: e.target.value }))} style={{ flex: 1 }} />
                        <select className="input" style={{ width: 80 }} value={form.moneda} onChange={e => setForm(f => ({ ...f, moneda: e.target.value }))}>{Array.from(new Set([...monedas, form.moneda].filter(Boolean))).map(m => <option key={m} value={m}>{m}</option>)}</select>
                      </div>
                    </div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">TC (si es ARS)</label><input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" placeholder="1425" value={form.tc} onChange={e => setForm(f => ({ ...f, tc: e.target.value }))} /><TcWarning tc={form.tc} /></div>
                  </div>
                  <div className="row" style={{ gap: 12 }}>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Caja {form.estado === 'pagado' && <span style={{ color: 'var(--neg)' }}>*</span>}</label>
                      <select className="input" value={form.metodo_pago_id} onChange={e => setForm(f => ({ ...f, metodo_pago_id: e.target.value }))}>
                        <option value="">— Elegir caja —</option>
                        {cajas.map(c => <option key={c.id} value={c.id}>{cajaNombre(c)}</option>)}
                        <CajaSelectHint />
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}><label className="field-label">Estado</label>
                      <select className="input" value={form.estado} onChange={e => setForm(f => ({ ...f, estado: e.target.value }))}>
                        <option value="pendiente">Pendiente</option><option value="pagado">Pagado (descuenta de la caja)</option>
                      </select>
                    </div>
                  </div>
                  <div className="field"><label className="field-label">Notas</label><input className="input" value={form.notas} onChange={e => setForm(f => ({ ...f, notas: e.target.value }))} /></div>
                  {formError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{formError}</div>}
                </div>
              </div>
              <div className="modal-ft"><button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancelar</button><button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Guardando…' : (editId ? 'Guardar' : 'Crear egreso')}</button></div>
            </form>
          </div>
        </div>
      )}

      {showCats && <CategoriasModal categorias={categorias} onClose={() => setShowCats(false)} onChange={() => egresosApi.categorias().then(setCategorias)} toast={toast} confirm={confirm} />}
      {showRec && <RecurrentesModal recurrentes={recurrentes} categorias={categorias} cajas={cajas} onClose={() => setShowRec(false)} onChange={() => egresosApi.recurrentes().then(setRecurrentes)} toast={toast} confirm={confirm} />}
    </div>
  );
}

// ── Sub-modal: categorías ──
function CategoriasModal({ categorias, onClose, onChange, toast, confirm }) {
  const [nombre, setNombre] = useState('');
  const overlayRef = useRef(null);
  useModal({ open: true, onClose, overlayRef });
  async function add() {
    if (!nombre.trim()) return;
    try { await egresosApi.createCategoria({ nombre: nombre.trim() }); setNombre(''); onChange(); }
    catch (e) { toast.error(e.message); }
  }
  async function del(c) {
    const ok = await confirm({ title: 'Eliminar categoría', message: `Eliminar "${c.nombre}"?`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await egresosApi.deleteCategoria(c.id); onChange(); } catch (e) { toast.error(e.message); }
  }
  return (
    <div ref={overlayRef} className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd"><h3>Categorías de egreso</h3><button className="icon-btn" onClick={onClose}><Icons.X size={16} /></button></div>
        <div className="modal-body">
          <div className="flex-row" style={{ gap: 6, marginBottom: 12 }}>
            <input className="input" style={{ flex: 1 }} placeholder="Nueva categoría…" value={nombre} onChange={e => setNombre(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
            <button className="btn btn-primary btn-sm" onClick={add} disabled={!nombre.trim()}>+ Agregar</button>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            {categorias.length === 0 && <div className="muted tiny">Sin categorías.</div>}
            {categorias.map(c => (
              <div key={c.id} className="flex-between" style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
                <span style={{ fontSize: 13 }}>{c.nombre}</span>
                <button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => del(c)}><Icons.Trash size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-modal: recurrentes ──
function RecurrentesModal({ recurrentes, categorias, cajas, onClose, onChange, toast, confirm }) {
  // Multi-país F3 fix: el hook se llamaba en el padre pero el sub-component
  // RecurrentesModal usa `monedas` en el dropdown línea 326 — había un
  // ReferenceError silencioso (no-undef en lint). Llamar acá garantiza scope.
  const { monedas } = useMonedasTenant();
  const EMPTY_R = { concepto: '', categoria_id: '', monto: '', moneda: 'USD', tc: '', metodo_pago_id: '', dia_del_mes: 1 };
  const [form, setForm] = useState(EMPTY_R);
  const overlayRef = useRef(null);
  useModal({ open: true, onClose, overlayRef });
  async function add() {
    if (!form.concepto.trim()) return;
    try {
      await egresosApi.createRecurrente({
        concepto: form.concepto.trim(), categoria_id: form.categoria_id ? Number(form.categoria_id) : null,
        monto: Number(form.monto) || 0, moneda: form.moneda, tc: form.tc ? Number(form.tc) : null,
        metodo_pago_id: form.metodo_pago_id ? Number(form.metodo_pago_id) : null, dia_del_mes: Number(form.dia_del_mes) || 1,
      });
      setForm(EMPTY_R); onChange();
    } catch (e) { toast.error(e.message); }
  }
  async function del(r) {
    const ok = await confirm({ title: 'Eliminar recurrente', message: `Eliminar "${r.concepto}"?`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try { await egresosApi.deleteRecurrente(r.id); onChange(); } catch (e) { toast.error(e.message); }
  }
  return (
    <div ref={overlayRef} className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd"><h3>Egresos recurrentes (mensuales)</h3><button className="icon-btn" onClick={onClose}><Icons.X size={16} /></button></div>
        <div className="modal-body">
          <div className="row" style={{ gap: 8, marginBottom: 6, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 2 }}><label className="field-label tiny">Concepto</label><input className="input" placeholder="Alquiler…" value={form.concepto} onChange={e => setForm(f => ({ ...f, concepto: e.target.value }))} /></div>
            <div className="field" style={{ flex: 1 }}><label className="field-label tiny">Monto</label><div className="flex-row" style={{ gap: 4 }}><input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" placeholder="0" value={form.monto} onChange={e => setForm(f => ({ ...f, monto: e.target.value }))} style={{ flex: 1 }} /><select className="input" style={{ width: 70 }} value={form.moneda} onChange={e => setForm(f => ({ ...f, moneda: e.target.value }))}>{Array.from(new Set([...monedas, form.moneda].filter(Boolean))).map(m => <option key={m} value={m}>{m}</option>)}</select></div></div>
            {form.moneda === 'ARS' && (
              <div className="field" style={{ width: 80 }}><label className="field-label tiny">TC</label><input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="0" className="input mono" placeholder="1425" value={form.tc} onChange={e => setForm(f => ({ ...f, tc: e.target.value }))} /><TcWarning tc={form.tc} /></div>
            )}
            <div className="field" style={{ width: 70 }}><label className="field-label tiny">Día</label><input type="number" inputMode="decimal" onKeyDown={blockInvalidNumberKeys} min="1" max="31" className="input mono" value={form.dia_del_mes} onChange={e => setForm(f => ({ ...f, dia_del_mes: e.target.value }))} /></div>
          </div>
          <div className="row" style={{ gap: 8, marginBottom: 10, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1 }}><label className="field-label tiny">Categoría</label><select className="input" value={form.categoria_id} onChange={e => setForm(f => ({ ...f, categoria_id: e.target.value }))}><option value="">—</option>{categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></div>
            <div className="field" style={{ flex: 1 }}><label className="field-label tiny">Caja</label><select className="input" value={form.metodo_pago_id} onChange={e => setForm(f => ({ ...f, metodo_pago_id: e.target.value }))}><option value="">—</option>{cajas.map(c => <option key={c.id} value={c.id}>{c.nombre}{c.moneda ? ' · ' + c.moneda : ''}</option>)}<CajaSelectHint /></select></div>
            <button className="btn btn-primary btn-sm" onClick={add} disabled={!form.concepto.trim()}>+ Agregar</button>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            {recurrentes.length === 0 && <div className="muted tiny">Sin recurrentes. Agregá uno y usá "Generar del mes".</div>}
            {recurrentes.map(r => (
              <div key={r.id} className="flex-between" style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
                <span style={{ fontSize: 13 }}>{r.concepto} · <span className="mono">{r.moneda === 'ARS' ? '$' : 'u$s'} {fmt(r.monto)}</span> <span className="muted tiny">· día {r.dia_del_mes}{r.categoria_nombre ? ' · ' + r.categoria_nombre : ''}</span></span>
                <button className="icon-btn" style={{ color: 'var(--neg)' }} onClick={() => del(r)}><Icons.Trash size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
