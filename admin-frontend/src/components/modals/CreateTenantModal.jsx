// CreateTenantModal — POST /api/super-admin/tenants (#452).
//
// Form para que el super-admin cree un tenant nuevo desde el back office.
// Caso de uso: onboarding manual post-demo cerrada.
//
// Flow del owner del tenant nuevo:
//   1. Admin completa este form → POST → tenant + owner user creados.
//   2. Backend envía email al owner con link "elegí tu password" (TTL 24h).
//   3. Owner clickea el link → /reset-password en el portal principal →
//      setea su password → puede loguearse normalmente.
//
// Validaciones cliente-side (defensivo — el server enforcea igual):
//   · tenant_nombre + nombre + email obligatorios
//   · email formato básico (regex simple, el server hace check riguroso)
//   · plan default 'trial'
//   · si plan='enterprise', custom_mrr_usd es obligatorio
//
// Después del 201: el parent (Resumen/Clientes/Layout) llama onCreated(res)
// con la response — el caller decide qué hacer (redirigir a Ficha, refrescar
// listado, mostrar toast, etc.).

import { useEffect, useId, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn, Badge } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';
import { planLabel } from '../../lib/uiHelpers.js';

const PLAN_OPTIONS = ['trial', 'starter', 'pro', 'enterprise'];
// Regex de email "razonable" — el server valida con zod.email() que es más
// estricto. Acá solo queremos cortar typos obvios antes del round-trip.
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INITIAL = {
  tenant_nombre: '',
  nombre: '',
  email: '',
  plan: 'trial',
  customMrr: '',
  reason: '',
};

export default function CreateTenantModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const tenantNombreId = useId();
  const nombreId = useId();
  const emailId = useId();
  const planId = useId();
  const mrrId = useId();
  const reasonId = useId();

  // Reset cada vez que se abre el modal — sin esto, si el admin cierra
  // accidentalmente y reabre, ve los datos del intento anterior colgados.
  useEffect(() => {
    if (open) {
      setForm(INITIAL);
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const tenantNombre = form.tenant_nombre.trim();
  const nombre = form.nombre.trim();
  const email = form.email.trim();

  // Reglas mostradas al user (también enforced server-side).
  const tenantNombreOK = tenantNombre.length >= 1 && tenantNombre.length <= 255;
  const nombreOK = nombre.length >= 1 && nombre.length <= 255;
  const emailOK = EMAIL_RX.test(email);
  const isEnterprise = form.plan === 'enterprise';
  const customMrrNum = form.customMrr === '' ? null : Number(form.customMrr);
  const enterpriseMrrOK = !isEnterprise || (
    customMrrNum != null && Number.isFinite(customMrrNum) && customMrrNum >= 0
  );

  const formValid = tenantNombreOK && nombreOK && emailOK && enterpriseMrrOK;

  const handleSubmit = async () => {
    if (!formValid) {
      // Fail-fast con mensaje específico (mejor que "datos inválidos" genérico).
      if (!tenantNombreOK) return setError('El nombre de la empresa es requerido (1-255 chars).');
      if (!nombreOK) return setError('El nombre del owner es requerido.');
      if (!emailOK) return setError('Email inválido.');
      if (!enterpriseMrrOK) return setError('Plan enterprise requiere MRR custom (USD/mes >= 0).');
      return;
    }

    const body = {
      tenant_nombre: tenantNombre,
      nombre,
      email,
      plan: form.plan,
    };
    if (isEnterprise) body.custom_mrr_usd = customMrrNum;
    if (form.reason.trim()) body.reason = form.reason.trim();

    setSubmitting(true);
    setError('');
    try {
      const res = await adminApi.createTenant(body);
      // El parent decide qué hacer (navegar a Ficha, refrescar listado, etc.).
      onCreated?.(res);
    } catch (err) {
      // El api.js setea err.message con el `error` field del backend (ya en
      // español, ya user-friendly). Tomamos eso directamente. err.status hace
      // disambiguación 409/400/500 si en el futuro queremos branching más fino.
      setError(err?.message || 'No pudimos crear el tenant. Intentá de nuevo.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Crear tenant manual"
      size="md"
      // Mutación con email-send + audit. Click accidental en backdrop no
      // debe descartar el form (mismo pattern que EditTenantModal y Suspend).
      closeOnBackdrop={false}
      actions={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Btn>
          <Btn
            kind="primary"
            onClick={handleSubmit}
            disabled={submitting || !formValid}
          >
            {submitting ? 'Creando…' : 'Crear tenant'}
          </Btn>
        </>
      }
    >
      <p className="muted tiny" style={{ marginTop: 0, marginBottom: 14 }}>
        Crea el tenant + owner. Le mandamos un email al owner con un link
        para que elija su password (vence en 24 hs).
      </p>

      <div className="stack u-gap-14">
        {/* Empresa */}
        <div>
          <label className="form-label" htmlFor={tenantNombreId}>
            Nombre de la empresa <span className="u-color-neg">*</span>
          </label>
          <input
            id={tenantNombreId}
            className="input"
            type="text"
            value={form.tenant_nombre}
            onChange={(e) => update('tenant_nombre', e.target.value)}
            placeholder="Ej: Aurora Mobile SRL"
            maxLength={255}
            disabled={submitting}
            autoFocus
          />
          <div className="muted tiny u-mt-4">
            El slug se genera automáticamente desde el nombre.
          </div>
        </div>

        {/* Owner — nombre */}
        <div>
          <label className="form-label" htmlFor={nombreId}>
            Nombre del owner <span className="u-color-neg">*</span>
          </label>
          <input
            id={nombreId}
            className="input"
            type="text"
            value={form.nombre}
            onChange={(e) => update('nombre', e.target.value)}
            placeholder="Ej: María García"
            maxLength={255}
            disabled={submitting}
          />
        </div>

        {/* Owner — email */}
        <div>
          <label className="form-label" htmlFor={emailId}>
            Email del owner <span className="u-color-neg">*</span>
          </label>
          <input
            id={emailId}
            className="input"
            type="email"
            value={form.email}
            onChange={(e) => update('email', e.target.value)}
            placeholder="maria@auroramobile.com.ar"
            maxLength={255}
            spellCheck={false}
            autoComplete="off"
            disabled={submitting}
          />
          {form.email && !emailOK && (
            <div className="tiny" style={{ color: 'var(--neg)', marginTop: 4 }}>
              Email inválido.
            </div>
          )}
          <div className="muted tiny u-mt-4">
            Le mandamos el link para elegir password a este email.
          </div>
        </div>

        {/* Plan */}
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

        {/* MRR custom — solo si enterprise */}
        {isEnterprise && (
          <div>
            <label className="form-label" htmlFor={mrrId}>
              MRR custom (USD/mes) <span className="u-color-neg">*</span>
            </label>
            <input
              id={mrrId}
              className="input"
              type="number"
              min="0"
              step="1"
              value={form.customMrr}
              onChange={(e) => update('customMrr', e.target.value)}
              placeholder="Ej: 250"
              disabled={submitting}
            />
            <div className="muted tiny u-mt-4">
              Enterprise no tiene precio fijo — definí el negociado.
            </div>
          </div>
        )}

        {/* Reason (opcional) */}
        <div>
          <label className="form-label" htmlFor={reasonId}>Motivo (opcional)</label>
          <input
            id={reasonId}
            className="input"
            type="text"
            value={form.reason}
            onChange={(e) => update('reason', e.target.value)}
            placeholder="Ej: cerrado en demo del 26/jun"
            maxLength={500}
            disabled={submitting}
          />
          <div className="muted tiny u-mt-4">
            Va al audit trail. Útil para forensics futuras.
          </div>
        </div>

        <div className="banner banner-info" role="note" style={{ padding: 10 }}>
          <Badge tone="info">Info</Badge>
          <span className="tiny" style={{ marginLeft: 6 }}>
            El tenant nace con email verificado y cajas/categorías default
            sembradas. El owner solo necesita elegir su password.
          </span>
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
