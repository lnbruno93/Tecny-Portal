// EditTenantModal — PATCH /api/super-admin/tenants/:id (#353).
//
// Cubre plan + custom MRR + notas en una sola operación atómica (el
// backend wrapea todo en tx + audit trail). El `reason` es opcional pero
// recomendado: queda guardado en audit_logs para forensics.
//
// Comportamiento clave:
//   · Construimos un body "diff": solo enviamos campos que cambiaron vs
//     el tenant original. Si nada cambió, NO llamamos al backend — solo
//     cerramos el modal. Esto evita escribir audit entries vacíos.
//   · El input `custom_mrr_usd` solo se muestra si plan === 'enterprise'.
//     El backend igual limpia el campo automáticamente al cambiar de
//     enterprise → otro plan; mostrarlo solo en enterprise es para no
//     confundir al super-admin sugiriendo que aplica fuera de ese plan.
//   · El backend acepta `custom_mrr_usd: null` para borrar el override
//     (volver al pricing del plan). Si el field queda vacío → enviamos null.

import { useEffect, useId, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn, Badge } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';
import { planLabel } from '../../lib/uiHelpers.js';

const PLAN_OPTIONS = ['trial', 'starter', 'pro', 'enterprise'];

// Slug regex sincronizado con backend (schemas/superAdmin.js). Cliente-side
// damos feedback inmediato; el server valida igual con la misma regla.
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

// Form state inicial derivado del tenant. Lo extraemos a una función
// para resetear el form cuando se reabre el modal (efecto en open).
function initialState(tenant) {
  return {
    nombre: tenant?.nombre || '',
    slug: tenant?.slug || '',
    plan: tenant?.plan || 'trial',
    customMrr: tenant?.custom_mrr_usd != null ? String(tenant.custom_mrr_usd) : '',
    notes: tenant?.notes || '',
    reason: '',
  };
}

export default function EditTenantModal({ tenant, open, onClose, onSaved }) {
  const [form, setForm] = useState(() => initialState(tenant));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // IDs estables para asociar label↔input (a11y básico).
  const nombreId = useId();
  const slugId = useId();
  const planId = useId();
  const mrrId = useId();
  const notesId = useId();
  const reasonId = useId();

  // Reset form cada vez que se abre el modal (o cambia el tenant target).
  // Sin esto, si el user cierra sin guardar y reabre, ve los cambios viejos
  // colgados — UX confusa porque parecen "guardados" pero no lo están.
  useEffect(() => {
    if (open) {
      setForm(initialState(tenant));
      setError('');
      setSubmitting(false);
    }
  }, [open, tenant]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Validación del slug: vacío NO está permitido (lo seedea el server al
  // signup, siempre hay uno). Si el operador limpia el input, mostramos
  // error en vez de mandar al server.
  const trimmedNombre = (form.nombre || '').trim();
  const trimmedSlug = (form.slug || '').trim();
  const slugIsValid = trimmedSlug === '' || SLUG_REGEX.test(trimmedSlug);
  const nombreIsValid = trimmedNombre.length >= 1;
  const slugChanged = tenant && trimmedSlug !== (tenant.slug || '');
  const nombreChanged = tenant && trimmedNombre !== (tenant.nombre || '');

  // Diff vs tenant original. Solo enviamos lo que cambió → backend audit
  // queda limpio (no "plan_change" cuando solo se editaron notas).
  const buildBody = () => {
    if (!tenant) return null;
    const body = {};
    if (nombreChanged && nombreIsValid) body.nombre = trimmedNombre;
    if (slugChanged && slugIsValid && trimmedSlug !== '') body.slug = trimmedSlug;
    if (form.plan !== tenant.plan) body.plan = form.plan;
    if ((form.notes || '') !== (tenant.notes || '')) body.notes = form.notes;

    // custom_mrr_usd: comparamos como numérico (con null/empty equivalentes).
    // Solo aplica si plan resultante es enterprise — sino lo dejamos
    // que el backend lo limpie según la regla de auto-coherencia.
    if (form.plan === 'enterprise') {
      const next = form.customMrr === '' ? null : Number(form.customMrr);
      const prev = tenant.custom_mrr_usd ?? null;
      // Comparación tolerante a null vs 0 vs string
      const changed = (next == null && prev != null) ||
                      (next != null && prev == null) ||
                      (next != null && Number(next) !== Number(prev));
      if (changed) body.custom_mrr_usd = next;
    }

    if (form.reason.trim()) body.reason = form.reason.trim();
    return body;
  };

  const handleSubmit = async () => {
    if (!tenant) return;
    // Guard de validación cliente-side. El server enforcea igual, pero
    // queremos feedback inmediato sin round-trip.
    if (!nombreIsValid) {
      setError('Nombre no puede estar vacío.');
      return;
    }
    if (!slugIsValid) {
      setError('Slug inválido: lowercase, números y hyphens; sin hyphens al inicio/fin; 2-100 chars.');
      return;
    }
    const body = buildBody();
    // Si solo viene `reason` pero ningún campo material cambió, no
    // tiene sentido pegarle al backend — un audit entry "edit con reason"
    // sin cambios reales es ruido. Cerramos y listo.
    const materialKeys = Object.keys(body).filter((k) => k !== 'reason');
    if (materialKeys.length === 0) {
      onClose?.();
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const updated = await adminApi.patchTenant(tenant.id, body);
      onSaved?.(updated);
    } catch (err) {
      setError(err?.message || 'No pudimos guardar los cambios.');
    } finally {
      // Hygiene 2026-06-22 follow-up del bug Planes.jsx: setSubmitting(false)
      // en finally — no solo en catch. Hoy el bug no se manifiesta acá porque
      // el useEffect [open] resetea al re-abrir Y el parent (Ficha) cierra el
      // modal en onSaved. Pero el pattern correcto es try/finally para no
      // depender de esas dos invariantes externas (si alguien quita el
      // useEffect en un refactor, el bug aparece).
      setSubmitting(false);
    }
  };

  const planChanged = tenant && form.plan !== tenant.plan;

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Editar tenant"
      size="md"
      // SEC-2 fix (audit 2026-06-22): mutations (plan/MRR/notes) son
      // acciones con impacto operativo. Click accidental en backdrop no
      // debe cerrar y perder los cambios + reason. Suspend ya lo tenía.
      closeOnBackdrop={false}
      actions={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Btn>
          <Btn kind="primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Guardando…' : 'Guardar cambios'}
          </Btn>
        </>
      }
    >
      <p className="muted tiny u-mt-0-mb-14">
        Cambios se aplican atómicamente con audit trail.
      </p>

      {planChanged && (
        <div className="banner banner-warn u-mb-12">
          <Badge tone="warn">Plan</Badge>
          <span>
            Cambiar plan limpia automáticamente trial_until / custom_mrr_usd
            según corresponda.
          </span>
        </div>
      )}

      <div className="stack u-gap-14">
        {/* Nombre — display, sin restricciones más allá de no-vacío. */}
        <div>
          <label className="form-label" htmlFor={nombreId}>Nombre de la empresa</label>
          <input
            id={nombreId}
            className="input"
            type="text"
            value={form.nombre}
            onChange={(e) => update('nombre', e.target.value)}
            placeholder="Ej: iPro / Celnyx"
            maxLength={255}
            disabled={submitting}
          />
          {!nombreIsValid && (
            <div className="tiny u-color-neg-mt-4">
              Nombre no puede estar vacío.
            </div>
          )}
        </div>

        {/* Slug — URL-safe identifier. Warning fuerte si se cambia porque
            es referenciado en audit trail histórico y posibles links externos. */}
        <div>
          <label className="form-label" htmlFor={slugId}>
            Slug (URL identifier)
          </label>
          <input
            id={slugId}
            className="input mono"
            type="text"
            value={form.slug}
            onChange={(e) => update('slug', e.target.value)}
            placeholder="ej: ipro-celnyx"
            maxLength={100}
            spellCheck={false}
            autoComplete="off"
            disabled={submitting}
          />
          {!slugIsValid && (
            <div className="tiny u-color-neg-mt-4">
              Inválido: lowercase, números y hyphens; sin hyphens al inicio/fin.
            </div>
          )}
          {slugChanged && slugIsValid && (
            <div className="banner banner-warn" style={{ marginTop: 6, padding: 8 }}>
              <span className="tiny">
                <strong>Cambiar slug es delicado.</strong> El slug actual queda
                guardado en el audit trail histórico, pero links externos o
                bookmarks que lo referencien dejarán de funcionar.
              </span>
            </div>
          )}
        </div>

        <div>
          <label className="form-label" htmlFor={planId}>Plan</label>
          <select
            id={planId}
            className="input"
            value={form.plan}
            onChange={(e) => update('plan', e.target.value)}
            disabled={submitting}
          >
            {PLAN_OPTIONS.map((p) => (
              <option key={p} value={p}>{planLabel(p)}</option>
            ))}
          </select>
        </div>

        {form.plan === 'enterprise' && (
          <div>
            <label className="form-label" htmlFor={mrrId}>MRR custom (USD/mes)</label>
            <input
              id={mrrId}
              className="input"
              type="number"
              min="0"
              step="1"
              value={form.customMrr}
              onChange={(e) => update('customMrr', e.target.value)}
              placeholder="ej: 250"
              disabled={submitting}
            />
            <div className="muted tiny u-mt-4">
              Vacío = sin override; se calcula desde precio del plan.
            </div>
          </div>
        )}

        <div>
          <label className="form-label" htmlFor={notesId}>Notas internas</label>
          <textarea
            id={notesId}
            className="input"
            rows={4}
            value={form.notes}
            onChange={(e) => update('notes', e.target.value)}
            placeholder="Contexto del cliente, deals, etc."
            disabled={submitting}
            className="u-resize-v-mh-84"
          />
        </div>

        <div>
          <label className="form-label" htmlFor={reasonId}>Motivo del cambio</label>
          <input
            id={reasonId}
            className="input"
            type="text"
            value={form.reason}
            onChange={(e) => update('reason', e.target.value)}
            placeholder="Ej: upgrade pactado por mail"
            disabled={submitting}
          />
          <div className="muted tiny u-mt-4">
            Para el audit trail (opcional pero útil).
          </div>
        </div>

        {error && (
          <div className="banner banner-neg" role="alert">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
