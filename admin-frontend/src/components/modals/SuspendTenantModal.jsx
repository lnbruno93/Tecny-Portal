// SuspendTenantModal — POST /api/super-admin/tenants/:id/suspend.
//
// Acción destructiva crítica: setea suspended_at=NOW. Los usuarios del
// tenant pierden acceso operativo (lo aplica el middleware del portal).
// El backend exige `reason` no vacío (required) y nosotros además exigimos
// >= 5 chars para que el audit tenga contenido útil (no "x", "test").
//
// Variant del botón confirm: `danger` (rojo). Es el patrón que más
// fuerza al super-admin a leer antes de clickear.

import { useEffect, useId, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';

const MIN_REASON_CHARS = 5;

export default function SuspendTenantModal({ tenant, open, onClose, onSaved }) {
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

  const trimmed = reason.trim();
  const validReason = trimmed.length >= MIN_REASON_CHARS;

  const handleSubmit = async () => {
    if (!tenant || !validReason) return;
    setSubmitting(true);
    setError('');
    try {
      await adminApi.suspendTenant(tenant.id, { reason: trimmed });
      onSaved?.();
    } catch (err) {
      setError(err?.message || 'No pudimos suspender el tenant.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Suspender cuenta"
      size="md"
      // closeOnBackdrop=false: la acción es destructiva, queremos confirmación
      // explícita (X o Cancel). Click accidental en el overlay no debería
      // cerrar el modal y perder el reason que el user ya tipeó.
      closeOnBackdrop={false}
      actions={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Btn>
          <Btn
            kind="danger"
            onClick={handleSubmit}
            disabled={!validReason || submitting}
          >
            {submitting ? 'Suspendiendo…' : 'Suspender cuenta'}
          </Btn>
        </>
      }
    >
      <div className="banner banner-neg" style={{ marginBottom: 14 }}>
        <span>
          Esta acción suspende a <strong>{tenant?.nombre || 'este tenant'}</strong>.
          Los usuarios del tenant no podrán operar la plataforma hasta que
          reactives la cuenta. La operación queda registrada en el audit trail.
        </span>
      </div>

      <div>
        <label className="form-label" htmlFor={reasonId}>Motivo de la suspensión</label>
        <textarea
          id={reasonId}
          className="input"
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ej: pago vencido, comportamiento abusivo, pedido del cliente"
          disabled={submitting}
          style={{ resize: 'vertical', minHeight: 84 }}
        />
        <div className="muted tiny" style={{ marginTop: 4 }}>
          Mínimo {MIN_REASON_CHARS} caracteres. Queda en el audit trail
          forense — sé específico.
        </div>
      </div>

      {error && (
        <div className="banner banner-neg" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </Modal>
  );
}
