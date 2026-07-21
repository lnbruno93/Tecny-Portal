import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icons } from '../components/Icons';
import { contactos as contactosApi } from '../lib/api';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { downloadBlob } from '../lib/downloadBlob';
import { usePageActions } from '../contexts/PageActionsContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmModal';
import { SkeletonRow } from '../components/Skeleton';
import useModal from '../lib/useModal';
import useFormFields from '../lib/useFormFields';
import { exportCsv } from '../lib/exportCsv';
import { writeXlsx } from '../lib/xlsx';

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
  // 2026-07-14 (bug reportado por TekHaus vía Lucas): al clickear un resultado
  // en el CommandPalette (⌘K), navegamos a /contactos?q=<término> para pre-
  // llenar el filtro. Sin esta lectura, la navegación ocurría pero el input
  // quedaba vacío y visualmente "no pasaba nada". Init con el param del URL,
  // el resto sigue como state local (no persistimos el filtro en URL).
  const [searchParams] = useSearchParams();
  const initialSearch = searchParams.get('q') || '';
  const [search, setSearch] = useState(initialSearch);
  const dSearch = useDebouncedValue(search, 350);
  const [origenFilter, setOrigenFilter] = useState('');

  // Modal alta/edición (editId === null → alta)
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  // 2026-07-16 (task #145 UX B): validación inline con useFormFields.
  // Antes: el error mostraba una string en formError al submit. Ahora
  // cada field tiene su propio error debajo, se limpia al empezar a
  // corregir. Menos frustración cuando fallás con 2+ campos a la vez.
  const {
    form,
    setForm,
    setField,
    fieldErrors,
    setFieldErrors,
    validate: validateForm,
    resetErrors,
  } = useFormFields(EMPTY, (f) => {
    const errs = {};
    if (!f.nombre.trim()) errs.nombre = 'Requerido.';
    // Email: si el user cargó algo, tiene que parecer email. Si dejó vacío, OK.
    if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) {
      errs.email = 'Formato inválido. Ej: nombre@dominio.com';
    }
    return Object.keys(errs).length ? errs : null;
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const formModalRef = useRef(null);
  useModal({ open: showForm, onClose: () => setShowForm(false), overlayRef: formModalRef });

  // 2026-07-16 (task #144 UX A): cleanup flag para evitar race condition.
  // Antes: si el user cambiaba dSearch/origenFilter rápido, un fetch tardío
  // podía pisar el estado con datos de una request anterior (ordering no
  // determinístico). El flag `cancelled` corta el setList si el effect ya
  // se re-ejecutó. Mismo pattern que Historial.jsx:92 y Novedades.jsx:117.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = {};
    if (dSearch) params.buscar = dSearch;
    if (origenFilter) params.origen = origenFilter;
    contactosApi.list(params)
      .then(r => { if (!cancelled) setList(Array.isArray(r) ? r : (r.data || [])); })
      .catch(e => { if (!cancelled) toast.error(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dSearch, origenFilter]);

  function openCreate() {
    setEditId(null);
    setForm(EMPTY);
    resetErrors();
    setFormError('');
    setShowForm(true);
  }
  function openEdit(c) {
    setEditId(c.id);
    setForm({
      nombre: c.nombre || '', apellido: c.apellido || '', telefono: c.telefono || '',
      dni: c.dni || '', email: c.email || '', tipo: c.tipo || 'cliente', origen: c.origen || 'manual',
    });
    resetErrors();
    setFormError('');
    setShowForm(true);
  }

  useEffect(() => {
    setPrimaryAction({ label: 'Nuevo contacto', onClick: openCreate });
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);

  async function handleSubmit(e) {
    e.preventDefault();
    // 2026-07-16 (task #145 UX B): validación inline. Si falla, cada field
    // muestra su error debajo, no un banner genérico al final del form.
    if (!validateForm()) return;
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
    } catch (err) {
      // Si el backend devolvió `fields`, mapearlos a fieldErrors (mismos
      // keys) — patrón consistente con admin-frontend/Novedades.jsx.
      if (err.status === 400 && err.body?.fields) {
        setFieldErrors(err.body.fields);
      } else {
        setFormError(err.message);
      }
    } finally { setSaving(false); }
  }

  // 2026-07-04 (#508) — Dropdown "Exportar mails" con 3 acciones:
  //   1. Copiar al portapapeles (dedup, solo emails)  → contactosApi.emails()
  //   2. Descargar CSV (ficha completa)               → contactosApi.export()
  //   3. Descargar XLSX (ficha completa)              → contactosApi.export()
  // El menu se cierra al elegir opción o al hacer click afuera. `exportando`
  // deshabilita el botón mientras corre la request (evita doble-click).
  const [exportOpen, setExportOpen] = useState(false);
  const [exportando, setExportando] = useState(false);
  const exportMenuRef = useRef(null);
  // Click-outside + Esc cierran el menú. useEffect con listeners globales
  // registrados solo mientras está abierto (evita cost cuando no aplica).
  // Audit 2026-07-04 P2: teclas Esc en dropdowns — antes solo click-outside,
  // los usuarios con teclado no tenían forma de cerrar sin desenfocar/click.
  useEffect(() => {
    if (!exportOpen) return;
    function onDocClick(e) {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setExportOpen(false);
      }
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') setExportOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [exportOpen]);

  async function copiarMails() {
    setExportOpen(false);
    setExportando(true);
    try {
      const r = await contactosApi.emails();
      const list = r?.emails || [];
      if (!list.length) return toast.error('No hay contactos con email cargado.');
      // navigator.clipboard requiere HTTPS o localhost — nuestro caso siempre.
      await navigator.clipboard.writeText(list.join(', '));
      toast.success(`Copiaste ${list.length} email${list.length === 1 ? '' : 's'} al portapapeles.`);
    } catch (e) {
      toast.error(e.message || 'No se pudo copiar la lista.');
    } finally {
      setExportando(false);
    }
  }

  // Ficha completa por contacto (no dedup): nombre, apellido, tel, DNI,
  // email, tipo, origen. Sirve para importar a otro CRM, Mailchimp, Excel.
  const EXPORT_COLS = [
    { key: 'nombre',   label: 'Nombre' },
    { key: 'apellido', label: 'Apellido' },
    { key: 'telefono', label: 'Teléfono' },
    { key: 'dni',      label: 'DNI' },
    { key: 'email',    label: 'Email' },
    { key: 'tipo',     label: 'Tipo' },
    { key: 'origen',   label: 'Origen' },
  ];
  function fechaSlug() {
    const d = new Date();
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }
  async function descargarCsv() {
    setExportOpen(false);
    setExportando(true);
    try {
      const r = await contactosApi.export();
      const rows = r?.contactos || [];
      if (!rows.length) return toast.error('No hay contactos para exportar.');
      exportCsv(`contactos_${fechaSlug()}.csv`, rows, EXPORT_COLS);
      toast.success(`Descargaste ${rows.length} contacto${rows.length === 1 ? '' : 's'} en CSV.`);
    } catch (e) {
      toast.error(e.message || 'No se pudo descargar el CSV.');
    } finally {
      setExportando(false);
    }
  }
  async function descargarXlsx() {
    setExportOpen(false);
    setExportando(true);
    try {
      const r = await contactosApi.export();
      const rows = r?.contactos || [];
      if (!rows.length) return toast.error('No hay contactos para exportar.');
      // writeXlsx recibe array-of-arrays (headers + filas). Todas las celdas
      // como texto — nombres, teléfonos y DNIs no son números aritméticos.
      const aoa = [
        EXPORT_COLS.map(c => c.label),
        ...rows.map(r2 => EXPORT_COLS.map(c => r2[c.key] ?? '')),
      ];
      const blob = writeXlsx(aoa, { sheetName: 'Contactos' });
      downloadBlob(blob, `contactos_${fechaSlug()}.xlsx`);
      toast.success(`Descargaste ${rows.length} contacto${rows.length === 1 ? '' : 's'} en XLSX.`);
    } catch (e) {
      toast.error(e.message || 'No se pudo descargar el XLSX.');
    } finally {
      setExportando(false);
    }
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
          <h1 className="page-title">Contactos</h1>
          <div className="page-sub">Agenda central · clientes, proveedores y contactos de todo el sistema</div>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex-row" style={{ gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="search" inputMode="search" aria-label="Buscar contactos" className="input" style={{ maxWidth: 320 }} placeholder="Buscar por nombre, mail, teléfono o DNI…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="input" style={{ maxWidth: 200 }} value={origenFilter} onChange={e => setOrigenFilter(e.target.value)}>
          <option value="">Todos los orígenes</option>
          {ORIGENES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="muted tiny" style={{ marginLeft: 'auto' }}>{total} contacto{total === 1 ? '' : 's'}</span>
        {/* 2026-07-04 (#508): dropdown Exportar mails con 3 acciones.
            Menú se cierra por click-outside (registrado condicionalmente en useEffect). */}
        <div ref={exportMenuRef} className="u-pos-rel">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setExportOpen(o => !o)}
            disabled={exportando}
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            title="Exportar la agenda para mailing masivo o importar a otro CRM"
          >
            <Icons.Download size={13} /> {exportando ? 'Exportando…' : 'Exportar mails'} ▾
          </button>
          {exportOpen && (
            <div
              role="menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                right: 0,
                minWidth: 260,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
                padding: 6,
                zIndex: 50,
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="btn btn-ghost"
                style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', padding: '8px 10px' }}
                onClick={copiarMails}
              >
                <Icons.Copy size={13} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <strong className="u-fs-13">Copiar al portapapeles</strong>
                  <span className="muted tiny">Solo emails, listos para pegar en Gmail</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn btn-ghost"
                style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', padding: '8px 10px' }}
                onClick={descargarCsv}
              >
                <Icons.Download size={13} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <strong className="u-fs-13">Descargar CSV</strong>
                  <span className="muted tiny">Ficha completa · Excel, Mailchimp, otros CRM</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="btn btn-ghost"
                style={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', padding: '8px 10px' }}
                onClick={descargarXlsx}
              >
                <Icons.Download size={13} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <strong className="u-fs-13">Descargar XLSX</strong>
                  <span className="muted tiny">Ficha completa · abre directo en Excel</span>
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="card card-flush">
        {/* 2026-06-25 UX-3 (audit pre-live): skeleton rows en lugar de "Cargando…"
            plano. Reduce perceived loading time y mantiene el layout estable. */}
        {loading ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>Nombre y Apellido</th><th>Contacto</th><th>DNI</th><th>Mail</th><th>De dónde vino</th><th></th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} columns={6} />)}
            </tbody>
          </table>
        ) : list.length === 0 ? (
          // 2026-07-16 (task #144 UX A): empty state diferenciado. Antes:
          // mismo mensaje sin importar si el user filtró o si aún no
          // cargó contactos. Ahora sabemos qué caso es y damos la acción
          // correcta (crear vs limpiar filtros).
          <div className="empty" style={{ textAlign: 'center', padding: '32px 20px' }}>
            {(dSearch || origenFilter) ? (
              <>
                <div style={{ fontSize: 14, marginBottom: 8 }}>
                  Ningún contacto matchea con esos filtros.
                </div>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => { setSearch(''); setOrigenFilter(''); }}
                >
                  Limpiar filtros
                </button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 14, marginBottom: 8 }}>
                  Todavía no cargaste contactos.
                </div>
                <button className="btn btn-sm btn-primary" onClick={openCreate}>
                  <Icons.Plus size={13} /> Nuevo contacto
                </button>
              </>
            )}
          </div>
        )
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
                    <td className="u-fw-600">{c.nombre}{c.apellido ? ' ' + c.apellido : ''}</td>
                    <td className="mono tiny">{c.telefono || '—'}</td>
                    <td className="mono tiny">{c.dni || '—'}</td>
                    <td className="tiny">{c.email || '—'}</td>
                    <td><span className={origenMeta(c.origen).cls}>{origenMeta(c.origen).label}</span></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" title="Editar" onClick={() => openEdit(c)}><Icons.Edit size={14} /></button>
                      <button className="icon-btn u-color-neg" title="Eliminar" onClick={() => handleDelete(c)}><Icons.Trash size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* ── Modal: alta / edición ── */}
      {showForm && (
        <div ref={formModalRef} className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal u-mw-520" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <h3>{editId ? 'Editar contacto' : 'Nuevo contacto'}</h3>
              <button className="icon-btn" onClick={() => setShowForm(false)}><Icons.X size={16} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="stack u-gap-14">
                  <div className="row u-gap-12">
                    <div className="field u-flex-1">
                      <label className="field-label" htmlFor="contacto-nombre">Nombre <span className="u-color-neg">*</span></label>
                      <input id="contacto-nombre" className={'input' + (fieldErrors.nombre ? ' input-error' : '')} value={form.nombre} onChange={e => setField('nombre', e.target.value)} autoFocus aria-invalid={!!fieldErrors.nombre} />
                      {fieldErrors.nombre && <div className="field-error">{fieldErrors.nombre}</div>}
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label" htmlFor="contacto-apellido">Apellido</label>
                      <input id="contacto-apellido" className="input" value={form.apellido} onChange={e => setField('apellido', e.target.value)} />
                    </div>
                  </div>
                  <div className="row u-gap-12">
                    <div className="field u-flex-1">
                      <label className="field-label" htmlFor="contacto-tel">Contacto (teléfono / WhatsApp)</label>
                      <input id="contacto-tel" type="tel" inputMode="tel" autoComplete="tel" className="input" value={form.telefono} onChange={e => setField('telefono', e.target.value)} />
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label" htmlFor="contacto-dni">DNI</label>
                      <input id="contacto-dni" inputMode="numeric" pattern="[0-9]*" className="input" value={form.dni} onChange={e => setField('dni', e.target.value)} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="contacto-email">Mail</label>
                    <input id="contacto-email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" className={'input' + (fieldErrors.email ? ' input-error' : '')} value={form.email} onChange={e => setField('email', e.target.value)} aria-invalid={!!fieldErrors.email} />
                    {fieldErrors.email && <div className="field-error">{fieldErrors.email}</div>}
                  </div>
                  <div className="row u-gap-12">
                    <div className="field u-flex-1">
                      <label className="field-label">De dónde vino</label>
                      <select className="input" value={form.origen} onChange={e => setField('origen', e.target.value)}>
                        {ORIGENES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div className="field u-flex-1">
                      <label className="field-label">Tipo</label>
                      <select className="input" value={form.tipo} onChange={e => setField('tipo', e.target.value)}>
                        {TIPOS.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                  {formError && <div className="u-color-neg-fs-13">{formError}</div>}
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
