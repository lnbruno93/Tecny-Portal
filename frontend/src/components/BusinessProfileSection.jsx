// BusinessProfileSection — perfil del negocio del tenant (#multi-tenant fix
// Cotizador 2026-06-22).
//
// Edita los campos que se usan para personalizar el mensaje de cotización
// generado en el Cotizador: ficha de Google (activada/desactivada), nombre
// del negocio en Google, cantidad aproximada de reseñas.
//
// Permisos: el form completo solo se renderiza para admins del tenant
// (el padre Config.jsx pasa `isAdmin`). Para vendedores comunes, mostramos
// una vista read-only con un nudge "pedile a tu admin que lo configure".
// El backend igual rechaza el PUT con 403 si llega de un member.

import { useEffect, useState } from 'react';
import { Icons } from './Icons';
import { tenantProfile as tenantProfileApi } from '../lib/api';
import { blockInvalidNumberKeys } from '../lib/inputUtils';

export default function BusinessProfileSection({ isAdmin }) {
  const [profile, setProfile] = useState(null);  // shape del backend, o null mientras carga
  const [enabled, setEnabled] = useState(false);
  const [name, setName]       = useState('');
  const [count, setCount]     = useState('');     // string para el input, se convierte a int al guardar
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    tenantProfileApi.get()
      .then((p) => {
        setProfile(p);
        setEnabled(!!p.google_business_enabled);
        setName(p.google_business_name || '');
        setCount(p.google_reviews_count != null ? String(p.google_reviews_count) : '');
      })
      .catch((err) => setError(err?.message || 'No pudimos cargar el perfil.'))
      .finally(() => setLoading(false));
  }, []);

  // Dirty-state: comparamos contra el snapshot del backend. Permite mostrar
  // botón "Guardar" disabled cuando no hay cambios.
  const original = profile || {};
  const isDirty = (
    enabled !== !!original.google_business_enabled ||
    (enabled ? name.trim() : '') !== (original.google_business_name || '') ||
    (enabled ? (count.trim() || '') : '') !== (original.google_reviews_count != null ? String(original.google_reviews_count) : '')
  );

  // Validación cliente. Devuelve el primer error encontrado, o null si OK.
  // Reflejamos las reglas del schema backend para fail-fast.
  function validate() {
    if (enabled) {
      const n = name.trim();
      if (!n) return 'Si activás Google, necesitás cargar el nombre del negocio.';
      if (n.length > 200) return 'Nombre demasiado largo (máx 200 caracteres).';
      if (count.trim() !== '') {
        const c = Number(count);
        if (!Number.isInteger(c) || c < 0) return 'Cantidad de reseñas debe ser entero >= 0.';
        if (c > 1_000_000) return 'Cantidad de reseñas demasiado alta.';
      }
    }
    return null;
  }

  async function handleSave() {
    setError('');
    setSaved(false);
    const v = validate();
    if (v) { setError(v); return; }

    setSaving(true);
    try {
      const body = {
        google_business_enabled: enabled,
        google_business_name: enabled ? name.trim() : null,
        google_reviews_count: enabled && count.trim() !== '' ? Number(count) : null,
      };
      const updated = await tenantProfileApi.update(body);
      setProfile(updated);
      // Re-sincronizar el form con el shape devuelto por el server (que aplicó
      // normalizaciones, ej. si desactivó devuelve name/count null).
      setEnabled(!!updated.google_business_enabled);
      setName(updated.google_business_name || '');
      setCount(updated.google_reviews_count != null ? String(updated.google_reviews_count) : '');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err?.message || 'No pudimos guardar los cambios.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="card u-mb-16">
        <div className="muted tiny">Cargando perfil del negocio…</div>
      </div>
    );
  }

  // Read-only para no-admins. Mostramos cómo se ve hoy y un nudge para
  // que el admin lo configure si todavía está en defaults.
  if (!isAdmin) {
    return (
      <div className="card u-mb-16">
        <div className="card-hd">
          <div className="u-fw-600-fs-15">Perfil del negocio</div>
          <div className="muted tiny u-mt-2">
            Datos que se usan en los mensajes generados por el Cotizador.
          </div>
        </div>
        <div className="stack u-gap-8">
          <div>
            <div className="muted tiny">Ficha de Google</div>
            <div>{profile?.google_business_enabled ? 'Habilitada' : 'Sin configurar'}</div>
          </div>
          {profile?.google_business_enabled && (
            <>
              <div>
                <div className="muted tiny">Nombre en Google</div>
                <div>{profile.google_business_name || '—'}</div>
              </div>
              <div>
                <div className="muted tiny">Reseñas aproximadas</div>
                <div>{profile.google_reviews_count != null ? `+${profile.google_reviews_count}` : '—'}</div>
              </div>
            </>
          )}
          <div className="muted tiny u-mt-6">
            Pedile a un administrador del equipo que actualice estos datos si están desactualizados.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card u-mb-16">
      <div className="card-hd">
        <div className="u-fw-600-fs-15">Perfil del negocio</div>
        <div className="muted tiny u-mt-2">
          Datos que se usan en los mensajes generados por el Cotizador y otras
          partes del portal donde aparece el nombre del negocio.
        </div>
      </div>

      <div className="stack u-gap-14">
        {/* Toggle: ¿tenés ficha de Google? */}
        <label className="flex-row u-biz-toggle-label">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={saving}
          />
          <div>
            <div className="u-fw-500">Tengo una ficha de negocio en Google</div>
            <div className="muted tiny">
              Si está desactivado, el mensaje del Cotizador no menciona Google ni reseñas.
            </div>
          </div>
        </label>

        {/* Campos visibles solo si está habilitado. Mantenemos los inputs en
            el DOM con disabled para que el state no se pierda si el usuario
            destildó por error y vuelve a marcar. */}
        <div className="field">
          <div className="field-label">Nombre del negocio en Google</div>
          <input
            className="input"
            type="text"
            placeholder='ej: "Tu Negocio | Tu Rubro"'
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!enabled || saving}
            maxLength={200}
          />
          <div className="muted tiny u-mt-4">
            Tal cual aparece en tu ficha de Google Maps / Google Business.
          </div>
        </div>

        <div className="field">
          <div className="field-label">Cantidad aproximada de reseñas (opcional)</div>
          {/* Fix incidental: había 2 className props (React silencia el primero).
              Consolidado en un solo string. */}
          <input
            className="input mono u-mw-200-max"
            type="number"
            onKeyDown={blockInvalidNumberKeys}
            placeholder="ej: 320"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            disabled={!enabled || saving}
            min="0"
            step="1"
          />
          <div className="muted tiny u-mt-4">
            Actualizá este número cuando tu ficha crezca. Si lo dejás vacío, el
            mensaje menciona Google pero sin números.
          </div>
        </div>

        {error && (
          <div role="alert" className="banner u-biz-banner u-biz-banner-neg">
            {error}
          </div>
        )}
        {saved && (
          <div role="status" className="banner u-biz-banner u-biz-banner-pos">
            <Icons.Check size={14} /> Cambios guardados.
          </div>
        )}

        <div className="flex-row u-gap-8-justify-end">
          <button
            type="button"
            className={'btn btn-primary' + (!isDirty || saving ? ' disabled' : '')}
            onClick={handleSave}
            disabled={!isDirty || saving}
          >
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}
