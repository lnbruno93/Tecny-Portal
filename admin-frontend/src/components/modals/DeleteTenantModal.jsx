// DeleteTenantModal — DELETE /api/super-admin/tenants/:id?confirm=<slug> (feature #438).
//
// Acción destructiva más severa que suspend: setea deleted_at=NOW. El portal
// trata al tenant como inexistente (tenantStatus.is_active=false → login
// rebota). Recuperable mientras no haya hard-delete cron (>30d, futuro).
//
// UX anti-clicaccidental estilo GitHub repo delete:
//   1. Modal bloqueante (closeOnBackdrop=false).
//   2. Banner rojo con la lista de consecuencias.
//   3. Input "tipear el slug del tenant" para habilitar el botón.
//   4. Botón confirm en variant 'danger', deshabilitado hasta match exacto.
//   5. Reason opcional pero recomendado (va al audit trail).
//
// El backend valida slug match server-side igual — esto es defensa UX, no
// security. Pero la combinación (cliente bloqueante + server validation)
// es el patrón estándar para acciones que cuestan caro deshacer.

import { useEffect, useId, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';

export default function DeleteTenantModal({ tenant, open, onClose, onDeleted }) {
  const [typedSlug, setTypedSlug] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const slugId = useId();
  const reasonId = useId();

  useEffect(() => {
    if (open) {
      setTypedSlug('');
      setReason('');
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  const expectedSlug = tenant?.slug || '';
  // Match exacto (case-sensitive, igual que GitHub). El slug es lowercase
  // por convención (validado en signup) — esto evita ambigüedad.
  const slugMatches = expectedSlug.length > 0 && typedSlug === expectedSlug;

  const handleSubmit = async () => {
    if (!tenant || !slugMatches) return;
    setSubmitting(true);
    setError('');
    try {
      const body = reason.trim() ? { reason: reason.trim() } : {};
      const res = await adminApi.deleteTenant(tenant.id, tenant.slug, body);
      // Si ya estaba borrado, igual cerramos como éxito (idempotente).
      onDeleted?.({ alreadyDeleted: !!res?.alreadyDeleted });
    } catch (err) {
      setError(err?.message || 'No pudimos eliminar el tenant.');
    } finally {
      // Try/finally — mismo patrón que los otros modales destructivos para
      // que el botón quede liberado aún si hay throw inesperado.
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Eliminar cuenta"
      size="md"
      // Click en backdrop no cierra — esta acción es la más destructiva del
      // panel, queremos confirmación explícita (X o Cancelar).
      closeOnBackdrop={false}
      actions={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Btn>
          <Btn
            kind="danger"
            onClick={handleSubmit}
            disabled={!slugMatches || submitting}
          >
            {submitting ? 'Eliminando…' : 'Eliminar cuenta definitivamente'}
          </Btn>
        </>
      }
    >
      <div className="banner banner-neg u-mb-14">
        <div>
          <strong>Vas a eliminar a {tenant?.nombre || 'este tenant'}.</strong>
          <ul className="u-m-8-0-0-18-p-0">
            <li>Los usuarios no van a poder loguearse al portal.</li>
            <li>Los datos quedan en la base — recuperables manualmente por ahora.</li>
            <li>La acción queda registrada en el audit trail con tu user_id.</li>
          </ul>
        </div>
      </div>

      <div className="u-mb-14">
        <label className="form-label" htmlFor={slugId}>
          Para confirmar, escribí el slug del tenant: <code>{expectedSlug}</code>
        </label>
        <input
          id={slugId}
          className="input"
          type="text"
          value={typedSlug}
          onChange={(e) => setTypedSlug(e.target.value)}
          placeholder={expectedSlug}
          autoComplete="off"
          spellCheck={false}
          disabled={submitting}
          // Foco automático en el input crítico al abrir.
          autoFocus
        />
        <div className="muted tiny u-mt-4">
          Match exacto (case-sensitive). El botón rojo se habilita cuando
          coincide con el slug del tenant.
        </div>
      </div>

      <div>
        <label className="form-label" htmlFor={reasonId}>
          Motivo (opcional, recomendado)
        </label>
        <textarea
          id={reasonId}
          className="input"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ej: cuenta de prueba creada durante onboarding, sin actividad real"
          disabled={submitting}
          className="u-textarea-resize-v-64"
          maxLength={500}
        />
      </div>

      {error && (
        <div className="banner banner-neg u-mt-12" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
