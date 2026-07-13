// Pantalla Sitio Público — editar contenido dinámico de la landing
// tecnyapp.com desde el admin. Fase 1 (2026-07-13): sección Contacto.
//
// Backend: GET/PATCH /api/super-admin/site-config (persisten en
// site_landing_config singleton). La landing pública consume
// GET /api/public/site-config con cache 5min HTTP + react-query.
//
// Flow:
//   1. GET /site-config al mount → popula el form.
//   2. Cada input actualiza el state local (dirty tracking implícito por diff).
//   3. Botón "Guardar cambios" hace PATCH con SOLO los campos que cambiaron
//      (evita UPDATEs no-op y hace el audit más limpio).
//   4. Toast/banner con "Guardado" y hint de que la landing tarda 5min máx.
//
// Fases futuras:
//   · Fase 2 (reseñas): sección con array editable + reorder.
//   · Fase 3 (footer): sección con 3 columnas (Empresa, Legal, Redes).

import { useEffect, useState } from 'react';
import { adminApi } from '../lib/api.js';
import { Btn, Card, PageHead } from '../components/primitives/index.jsx';
import { fmtDateTime } from '../lib/format.js';

// Campos de contacto en el orden que el operador espera verlos en el form.
// Cada uno tiene label + placeholder + hint (opcional) + input type.
const FIELDS = [
  {
    key: 'contact_email',
    label: 'Email de contacto',
    placeholder: 'hola@tecnyapp.com',
    type: 'email',
    hint: 'Aparece en la sección Contacto de la landing y en el botón "Escribinos".',
  },
  {
    key: 'contact_whatsapp',
    label: 'WhatsApp (solo dígitos, formato internacional)',
    placeholder: '5491126165007',
    type: 'text',
    hint: 'Sin +, sin espacios ni guiones. Ej: 5491126165007 para +54 9 11 2616-5007. Se usa para el link wa.me/*.',
    pattern: '\\d{8,15}',
  },
  {
    key: 'contact_whatsapp_display',
    label: 'WhatsApp (formato visible)',
    placeholder: '+54 9 11 2616-5007',
    type: 'text',
    hint: 'Cómo se muestra al usuario en la landing. Podés poner el formato que prefieras.',
  },
  {
    key: 'contact_address',
    label: 'Dirección / ubicación',
    placeholder: 'Av. del Libertador 6299, Buenos Aires',
    type: 'text',
    hint: 'Texto libre. Aparece en la card de Contacto y en el footer.',
  },
  {
    key: 'contact_instagram_handle',
    label: 'Instagram (handle sin @)',
    placeholder: 'tecny.app',
    type: 'text',
    hint: 'Solo el nombre, sin @. Ej: tecny.app',
  },
  {
    key: 'contact_instagram_url',
    label: 'Instagram (URL completa)',
    placeholder: 'https://instagram.com/tecny.app',
    type: 'url',
    hint: 'Link al perfil. Se usa en los botones de "Seguinos".',
  },
];

const EMPTY = FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: '' }), {});

export default function SitioPublico() {
  const [form, setForm]         = useState(EMPTY);
  const [original, setOriginal] = useState(EMPTY); // para calcular el diff al guardar
  const [meta, setMeta]         = useState({ updated_at: null });
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [savedMsg, setSavedMsg] = useState(null);
  const [error, setError]       = useState(null);

  async function cargar() {
    try {
      setLoading(true);
      const row = await adminApi.getSiteConfig();
      // Normalizar null → '' para inputs controlados.
      const normalized = FIELDS.reduce((acc, f) => {
        acc[f.key] = row?.[f.key] ?? '';
        return acc;
      }, {});
      setForm(normalized);
      setOriginal(normalized);
      setMeta({ updated_at: row?.updated_at || null });
    } catch (e) {
      setError(e.message || 'No se pudo cargar la config');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { cargar(); }, []);

  // Diff: solo enviamos los campos que cambiaron respecto al original.
  const dirtyKeys = FIELDS
    .map(f => f.key)
    .filter(k => (form[k] || '') !== (original[k] || ''));
  const isDirty = dirtyKeys.length > 0;

  async function guardar() {
    if (!isDirty) return;
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const patch = {};
      for (const k of dirtyKeys) patch[k] = form[k];
      const updated = await adminApi.updateSiteConfig(patch);
      // Re-normalizar respuesta (backend puede haber convertido '' a null).
      const normalized = FIELDS.reduce((acc, f) => {
        acc[f.key] = updated?.[f.key] ?? '';
        return acc;
      }, {});
      setForm(normalized);
      setOriginal(normalized);
      setMeta({ updated_at: updated?.updated_at || null });
      setSavedMsg('Guardado. Los cambios aparecen en tecnyapp.com en máx. 5 minutos.');
      setTimeout(() => setSavedMsg(null), 6000);
    } catch (e) {
      // El backend devuelve { error: '...', fields: {...} } — extraemos el
      // primer mensaje humano si viene de Zod.
      let msg = e.message || 'Error al guardar';
      if (e.response?.fields) {
        const firstField = Object.keys(e.response.fields)[0];
        msg = e.response.fields[firstField] || msg;
      }
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  function descartar() {
    setForm(original);
    setError(null);
  }

  return (
    <div className="page">
      <PageHead
        label="Sitio público"
        title="Landing tecnyapp.com"
        subtitle="Editá el contenido de la sección Contacto. Los cambios aparecen en la landing en máx. 5 minutos (cache HTTP)."
        actions={
          isDirty && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="ghost" onClick={descartar} disabled={saving}>
                Descartar
              </Btn>
              <Btn onClick={guardar} disabled={saving}>
                {saving ? 'Guardando…' : `Guardar ${dirtyKeys.length} cambio${dirtyKeys.length > 1 ? 's' : ''}`}
              </Btn>
            </div>
          )
        }
      />

      {loading ? (
        <div className="muted" style={{ padding: 32, textAlign: 'center' }}>Cargando…</div>
      ) : (
        <>
          <Card>
            <div style={{ padding: 20, display: 'grid', gap: 16 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Sección Contacto</h3>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                  Datos que aparecen en la landing pública. La primera vez que edites, los datos
                  viejos (@ipro.arg, gmail.com) se reemplazan por los tuyos.
                </p>
              </div>

              {FIELDS.map(f => {
                const changed = (form[f.key] || '') !== (original[f.key] || '');
                return (
                  <div key={f.key} className="field">
                    <label
                      className="field-label"
                      htmlFor={`sc-${f.key}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      {f.label}
                      {changed && (
                        <span
                          style={{
                            fontSize: 10, fontWeight: 700,
                            padding: '2px 6px', borderRadius: 4,
                            background: 'var(--accent-soft)', color: 'var(--accent)',
                          }}
                        >MODIFICADO</span>
                      )}
                    </label>
                    <input
                      id={`sc-${f.key}`}
                      type={f.type}
                      className="input"
                      placeholder={f.placeholder}
                      pattern={f.pattern}
                      value={form[f.key]}
                      onChange={e => setForm(x => ({ ...x, [f.key]: e.target.value }))}
                      disabled={saving}
                      style={{ width: '100%' }}
                    />
                    {f.hint && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        {f.hint}
                      </div>
                    )}
                  </div>
                );
              })}

              {error && (
                <div
                  role="alert"
                  style={{
                    padding: 10, borderRadius: 6, fontSize: 13,
                    background: 'rgba(220, 38, 38, 0.08)',
                    border: '1px solid rgba(220, 38, 38, 0.3)',
                    color: 'var(--neg)',
                  }}
                >
                  {error}
                </div>
              )}
              {savedMsg && (
                <div
                  role="status"
                  style={{
                    padding: 10, borderRadius: 6, fontSize: 13,
                    background: 'rgba(16, 185, 129, 0.08)',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    color: 'var(--pos)',
                  }}
                >
                  {savedMsg}
                </div>
              )}
            </div>
          </Card>

          {meta.updated_at && (
            <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
              Última edición: {fmtDateTime(meta.updated_at)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
