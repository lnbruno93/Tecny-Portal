import { useState, useEffect } from 'react';
import { Icons } from '../components/Icons';
import { contactos as contactosApi } from '../lib/api';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';

// Origen: de qué módulo provino el contacto. 'manual' = cargado en la agenda.
const ORIGENES = [
  { value: 'manual',      label: 'Manual',      cls: 'badge' },
  { value: 'ventas',      label: 'Ventas',      cls: 'badge badge-info' },
  { value: 'b2b',         label: 'Gestión B2B', cls: 'badge badge-info' },
  { value: 'proveedores', label: 'Proveedores', cls: 'badge' },
  { value: 'envios',      label: 'Envíos',      cls: 'badge' },
  { value: 'proyectos',   label: 'Proyectos',   cls: 'badge badge-info' },
];
const TIPOS = ['cliente', 'amigo', 'familiar', 'inversor', 'ipro team'];
const origenMeta = (o) => ORIGENES.find(x => x.value === o) || { label: o || '—', cls: 'badge' };

const EMPTY = { nombre: '', apellido: '', telefono: '', dni: '', email: '', tipo: 'cliente', origen: 'manual' };

export default function Contactos() {
  const { toast } = useToast();
  const confirm   = useConfirm();
  const { setPrimaryAction } = usePageActions();

  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const dSearch = useDebouncedValue(search, 350);
  const [origenFilter, setOrigenFilter] = useState('');

  // Modal alta/edición (editId === null → alta)
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  function loadList() {
    setLoading(true);
    const params = {};
    if (dSearch) params.buscar = dSearch;
    if (origenFilter) params.origen = origenFilter;
    contactosApi.list(params)
      .then(r => setList(Array.isArray(r) ? r : (r.data || [])))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, [dSearch, origenFilter]);

  function openCreate() { setEditId(null); setForm(EMPTY); setFormError(''); setShowForm(true); }
  function openEdit(c) {
    setEditId(c.id);
    setForm({
      nombre: c.nombre || '', apellido: c.apellido || '', telefono: c.telefono || '',
      dni: c.dni || '', email: c.email || '', tipo: c.tipo || 'cliente', origen: c.origen || 'manual',
    });
    setFormError(''); setShowForm(true);
  }

  useEffect(() => {
    setPrimaryAction({ label: 'Nuevo contacto', onClick: openCreate });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.nombre.trim()) { setFormError('El nombre es obligatorio.'); return; }
    setSaving(true); setFormError('');
    const payload = {
      nombre: form.nombre.trim(),
      apellido: form.apellido.trim() || null,
      telefono: form.telefono.trim() || null,
      dni: form.dni.trim() || null,
      email: form.email.trim() || null,
      tipo: form.tipo,
      origen: form.origen,
    };
    try {
      if (editId) {
        const upd = await contactosApi.update(editId, payload);
        setList(prev => prev.map(c => c.id === editId ? upd : c));
        toast.success('Contacto actualizado.');
      } else {
        const nuevo = await contactosApi.create(payload);
        setList(prev => [nuevo, ...prev]);
        toast.success('Contacto creado.');
      }
      setShowForm(false);
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }

  async function handleDelete(c) {
    const ok = await confirm({ title: 'Eliminar contacto', message: `Se eliminará "${c.nombre}${c.apellido ? ' ' + c.apellido : ''}".`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    try {
      await contactosApi.delete(c.id);
      setList(prev => prev.filter(x => x.id !== c.id));
      toast.success('Contacto eliminado.');
    } catch (err) { toast.error(err.message); }
  }

  const total = list.length;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">Contactos</div>
          <div className="page-sub">Agenda central · clientes, proveedores y contactos de todo el sistema</div>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex-row" style={{ gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Buscar por nombre, mail, teléfono o DNI…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="input" style={{ maxWidth: 200 }} value={origenFilter} onChange={e => setOrigenFilter(e.target.value)}>
          <option value="">Todos los orígenes</option>
          {ORIGENES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="muted tiny" style={{ marginLeft: 'auto' }}>{total} contacto{total === 1 ? '' : 's'}</span>
      </div>

      <div className="card card-flush">
        {loading ? <div className="empty">Cargando…</div>
          : list.length === 0 ? <div className="empty">Sin contactos. Creá el primero con "Nuevo contacto".</div>
          : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Nombre y Apellido</th><th>Contacto</th><th>DNI</th><th>Mail</th><th>De dónde vino</th><th></th>
                </tr>
              </thead>
              <tbody>
                {list.map(c => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.nombre}{c.apellido ? ' ' + c.apellido : ''}</td>
                    <td className="mono tiny">{c.telefono || '—'}</td>
                    <td className="mono tiny">{c.dni || '—'}</td>
                    <td className="tiny">{c.email || '—'}</td>
                    <td><span className={origenMeta(c.origen).cls}>{origenMeta(c.origen).label}</span></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title="Editar" onClick={() => openEdit(c)}><Icons.Edit size={14} /></button>
                      <button className="icon-btn" title="Eliminar" style={{ color: 'var(--neg)' }} onClick={() => handleDelete(c)}><Icons.Trash size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* ── Modal: alta / edición ── */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>{editId ? 'Editar contacto' : 'Nuevo contacto'}</h3>
              <button className="icon-btn" onClick={() => setShowForm(false)}><Icons.X size={16} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="stack" style={{ gap: 14 }}>
                  <div className="row" style={{ gap: 12 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Nombre <span style={{ color: 'var(--neg)' }}>*</span></label>
                      <input className="input" value={form.nombre} onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))} autoFocus />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Apellido</label>
                      <input className="input" value={form.apellido} onChange={e => setForm(f => ({ ...f, apellido: e.target.value }))} />
                    </div>
                  </div>
                  <div className="row" style={{ gap: 12 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Contacto (teléfono / WhatsApp)</label>
                      <input className="input" value={form.telefono} onChange={e => setForm(f => ({ ...f, telefono: e.target.value }))} />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">DNI</label>
                      <input className="input" value={form.dni} onChange={e => setForm(f => ({ ...f, dni: e.target.value }))} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label">Mail</label>
                    <input type="email" className="input" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                  </div>
                  <div className="row" style={{ gap: 12 }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">De dónde vino</label>
                      <select className="input" value={form.origen} onChange={e => setForm(f => ({ ...f, origen: e.target.value }))}>
                        {ORIGENES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Tipo</label>
                      <select className="input" value={form.tipo} onChange={e => setForm(f => ({ ...f, tipo: e.target.value }))}>
                        {TIPOS.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                  {formError && <div style={{ color: 'var(--neg)', fontSize: 13 }}>{formError}</div>}
                </div>
              </div>
              <div className="modal-ft">
                <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Guardando…' : (editId ? 'Guardar cambios' : 'Crear contacto')}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
