// SetPaidUntilModal — POST /api/super-admin/tenants/:id/set-paid-until.
//
// TANDA 4.B billing pre-live 2026-06-25.
//
// UX: Lucas recibió una transferencia y quiere extender el período pagado.
// Inputs:
//   · paid_until: date picker (YYYY-MM-DD). Default = hoy + 30 días.
//   · reason: texto libre (obligatorio cuando paid_until es una fecha).
//   · Botón secundario "Grandfather (sin enforcement)" → manda paid_until=null
//     (útil para el tenant interno o enterprise con contrato papel).
//
// El backend valida formato + tx atómica + audit + invalidate cache.

import { useEffect, useId, useMemo, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn, Badge } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';
import { fmtDate } from '../../lib/format.js';

// Default: +30 días. El operador puede editarlo a +60/+90 según el monto.
function defaultPaidUntil() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

// "Vencido hace X días" — solo si paid_until existe y ya pasó.
function paidUntilExpiredInfo(currentIso) {
  if (!currentIso) return null;
  const d = new Date(currentIso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const dayOnly = new Date(d);
  dayOnly.setHours(0, 0, 0, 0);
  if (dayOnly >= now) return null;
  return Math.floor((now - dayOnly) / 86400000);
}

export default function SetPaidUntilModal({ tenant, open, onClose, onSaved }) {
  const [paidUntil, setPaidUntil] = useState(defaultPaidUntil());
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const paidId = useId();
  const reasonId = useId();

  useEffect(() => {
    if (open) {
      setPaidUntil(defaultPaidUntil());
      setReason('');
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  const validDate = useMemo(() => {
    if (!paidUntil) return false;
    return /^\d{4}-\d{2}-\d{2}$/.test(paidUntil) && !isNaN(new Date(paidUntil).getTime());
  }, [paidUntil]);

  const reasonValid = useMemo(() => reason.trim().length > 0, [reason]);

  const expiredDays = paidUntilExpiredInfo(tenant?.paid_until);

  const handleSubmit = async () => {
    if (!tenant || !validDate || !reasonValid) return;
    setSubmitting(true);
    setError('');
    try {
      await adminApi.setPaidUntil(tenant.id, {
        paid_until: paidUntil,
        reason: reason.trim(),
      });
      onSaved?.();
    } catch (err) {
      setError(err?.message || 'No pudimos actualizar paid_until.');
    } finally {
      setSubmitting(false);
    }
  };

  // Grandfather: paid_until=null. Sin reason required (semánticamente es
  // "saco el enforcement", no "cobré N"). Confirm para no clickear sin querer.
  const handleGrandfather = async () => {
    if (!tenant) return;
    if (!window.confirm('¿Marcar como grandfathered (sin enforcement de paid_until)?')) return;
    setSubmitting(true);
    setError('');
    try {
      await adminApi.setPaidUntil(tenant.id, { paid_until: null });
      onSaved?.();
    } catch (err) {
      setError(err?.message || 'No pudimos actualizar paid_until.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Marcar pago recibido"
      size="md"
      closeOnBackdrop={false}
      actions={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Btn>
          <Btn
            kind="primary"
            onClick={handleSubmit}
            disabled={!validDate || !reasonValid || submitting}
          >
            {submitting ? 'Guardando…' : 'Marcar pago'}
          </Btn>
        </>
      }
    >
      <div className="flex-row u-gap-10-mb-14-wrap">
        <span>
          Pagado hasta actual{' '}
          <strong>{tenant?.paid_until ? fmtDate(tenant.paid_until) : 'sin fecha (grandfathered)'}</strong>
        </span>
        {expiredDays != null && (
          <Badge tone="neg">
            Vencido hace {expiredDays} {expiredDays === 1 ? 'día' : 'días'}
          </Badge>
        )}
      </div>

      <div className="stack u-gap-14">
        <div>
          <label className="form-label" htmlFor={paidId}>Nueva fecha de vencimiento</label>
          <input
            id={paidId}
            className="input"
            type="date"
            value={paidUntil}
            onChange={(e) => setPaidUntil(e.target.value)}
            disabled={submitting}
          />
          <div className="muted tiny u-mt-4">
            El tenant podrá operar normalmente hasta esta fecha. Default +30 días.
          </div>
        </div>

        <div>
          <label className="form-label" htmlFor={reasonId}>Motivo / referencia *</label>
          <input
            id={reasonId}
            className="input"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej: transferencia $189 USD recibida 2026-06-25"
            disabled={submitting}
          />
          <div className="muted tiny u-mt-4">
            Obligatorio. Va al audit trail (futuras consultas: "¿cuándo cobramos a este tenant?").
          </div>
        </div>

        <div className="u-grandfather-section">
          <Btn kind="ghost" onClick={handleGrandfather} disabled={submitting} size="sm">
            Grandfather (sin enforcement)
          </Btn>
          <div className="muted tiny u-mt-4">
            Setea paid_until=NULL. El tenant pasa a "activo indefinido". Útil para
            cuentas internas o enterprise con contrato anual papel.
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
