// ReactivateTenantModal — POST /api/super-admin/tenants/:id/reactivate.
//
// Acción no destructiva (el opuesto de Suspender), pero igual queremos
// un confirm explícito porque resetea el flag operativo. El `reason` es
// opcional acá (el backend no lo exige) — si está vacío lo enviamos
// como undefined, no como string vacío (el backend trata "" igual que
// presente y mete '' al audit, lo cual queda raro en el log).
//
// Size 'sm' porque tiene poco contenido — confirm + nota opcional.

import { useEffect, useId, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';
import { fmtDate } from '../../lib/format.js';

export default function ReactivateTenantModal({ tenant, open, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const reasonId = useId();

  useEffect(() => {
    if (open) {
      setReason('');
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  const handleSubmit = async () => {
    if (!tenant) return;
    setSubmitting(true);
    setError('');
    try {
      const trimmed = reason.trim();
      await adminApi.reactivateTenant(tenant.id, {
        reason: trimmed || undefined,
      });
      onSaved?.();
    } catch (err) {
      setError(err?.message || 'No pudimos reactivar el tenant.');
    } finally {
      // Hygiene 2026-06-22 follow-up del bug Planes.jsx: ver comment en
      // EditTenantModal — try/finally evita depender del useEffect [open]
      // + cierre desde el parent. Defensa en profundidad.
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Reactivar cuenta"
      size="sm"
      // SEC-2 fix (audit 2026-06-22): mutation con audit trail — click
      // accidental en backdrop no debe perder el motivo tipeado.
      closeOnBackdrop={false}
      actions={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Btn>
          <Btn kind="primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Reactivando…' : 'Reactivar cuenta'}
          </Btn>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Vas a reactivar a <strong>{tenant?.nombre || 'este tenant'}</strong>.
        Los usuarios podrán volver a operar la plataforma de inmediato.
      </p>

      <div className="muted tiny u-mb-14">
        Razón actual de suspensión: &quot;{tenant?.suspended_reason || '—'}&quot;,
        desde {fmtDate(tenant?.suspended_at)}
      </div>

      <div>
        <label className="form-label" htmlFor={reasonId}>Nota para el audit (opcional)</label>
        <input
          id={reasonId}
          className="input"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ej: cliente regularizó el pago"
          disabled={submitting}
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
