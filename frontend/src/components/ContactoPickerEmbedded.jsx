// ContactoPickerEmbedded — picker de contacto con toggle Existente/+ Nuevo.
//
// Diseñado para el mega-form de Cajas (Deuda + Inversión): permite al usuario
// elegir un contacto existente del select, o crear uno nuevo en el momento
// con nombre/apellido/tipo. El backend (POST /api/cajas/deudas y /inversiones)
// acepta tanto `contacto_id` (existente) como `contacto_nuevo` (objeto) en el
// payload y crea ambos en una sola tx.
//
// Antes (PR #78) este bloque estaba duplicado ~55 líneas en dos lugares —
// Hygiene agent lo marcó como deuda técnica concreta. Extraído en TANDA 3.
//
// Props:
//   form     — { contactoMode, contacto_id, nuevoNombre, nuevoApellido, nuevoTipo }
//   setForm  — setState del form padre (recibe función updater)
//   allContacts — lista de contactos disponibles para el select
//   defaultNuevoTipo — 'amigo' (Deuda) | 'inversor' (Inversión), default para
//                     contactos creados desde acá. Solo afecta el initial.
import { Icons } from './Icons';
// task #290: tipos dinámicos per-tenant. Reemplaza el TIPO_LABEL hardcoded
// que había acá (mismo bug rebrand que Contactos.jsx + Cajas.jsx).
import { useContactoTipos } from '../lib/useContactoTipos';

export default function ContactoPickerEmbedded({ form, setForm, allContacts }) {
  const { tipos, labelFor } = useContactoTipos();
  return (
    <div className="field">
      <label className="field-label">Contacto <span className="u-color-neg">*</span></label>
      <div className="flex-row u-contacto-picker-seg">
        <button type="button"
                className={'btn btn-sm ' + (form.contactoMode === 'existente' ? 'btn-primary' : 'btn-ghost')}
                className="u-p-4-12"
                onClick={() => setForm(f => ({ ...f, contactoMode: 'existente' }))}>
          Existente
        </button>
        <button type="button"
                className={'btn btn-sm ' + (form.contactoMode === 'nuevo' ? 'btn-primary' : 'btn-ghost')}
                className="u-p-4-12"
                onClick={() => setForm(f => ({ ...f, contactoMode: 'nuevo' }))}>
          <Icons.Plus size={11} /> Nuevo
        </button>
      </div>
      {form.contactoMode === 'existente' ? (
        <select className="input"
                value={form.contacto_id}
                onChange={e => setForm(f => ({ ...f, contacto_id: e.target.value }))}
                autoFocus={!form.contacto_id}>
          <option value="">— Seleccionar —</option>
          {allContacts.map(c => (
            <option key={c.id} value={c.id}>
              {c.nombre}{c.apellido ? ` ${c.apellido}` : ''} ({labelFor(c.tipo)})
            </option>
          ))}
        </select>
      ) : (
        <div className="row u-gap-8">
          <div className="field u-flex-15">
            <label className="field-label tiny">Nombre <span className="u-color-neg">*</span></label>
            <input className="input" placeholder="ej. Martín" autoFocus
                   value={form.nuevoNombre}
                   onChange={e => setForm(f => ({ ...f, nuevoNombre: e.target.value }))} />
          </div>
          <div className="field u-flex-15">
            <label className="field-label tiny">Apellido</label>
            <input className="input" placeholder="ej. García"
                   value={form.nuevoApellido}
                   onChange={e => setForm(f => ({ ...f, nuevoApellido: e.target.value }))} />
          </div>
          <div className="field u-flex-1">
            <label className="field-label tiny">Tipo</label>
            <select className="input"
                    value={form.nuevoTipo}
                    onChange={e => setForm(f => ({ ...f, nuevoTipo: e.target.value }))}>
              {tipos.map(t => <option key={t.slug} value={t.slug}>{t.nombre}</option>)}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
