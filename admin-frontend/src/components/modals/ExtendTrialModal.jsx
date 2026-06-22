// ExtendTrialModal — POST /api/super-admin/tenants/:id/extend-trial.
//
// Solo se abre cuando tenant.plan === 'trial' (el botón "Extender trial"
// solo aparece en ese caso, pero defensivo: el backend devuelve 400 si
// se llama con plan !== 'trial').
//
// El backend suma `days` sobre trial_until actual O sobre hoy si el
// trial_until era NULL/pasado. Replicamos esa lógica acá para mostrar
// preview en tiempo real ("Nuevo trial hasta: ...").

import { useEffect, useId, useMemo, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn, Badge } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';
import { fmtDate } from '../../lib/format.js';

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 365;

// Misma lógica que el backend para el cálculo del nuevo trial:
// base = max(trial_until, hoy), nuevo = base + days.
function computeNewTrial(currentIso, days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let base = today;
  if (currentIso) {
    const parsed = new Date(currentIso);
    if (!isNaN(parsed.getTime()) && parsed > today) base = parsed;
  }
  const result = new Date(base);
  result.setDate(result.getDate() + Number(days || 0));
  return result;
}

// "Vencido hace X días" — solo si trial_until existe y ya pasó.
function trialExpiredInfo(currentIso) {
  if (!currentIso) return null;
  const d = new Date(currentIso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const dayOnly = new Date(d);
  dayOnly.setHours(0, 0, 0, 0);
  if (dayOnly >= now) return null;
  const diffDays = Math.floor((now - dayOnly) / 86400000);
  return diffDays;
}

export default function ExtendTrialModal({ tenant, open, onClose, onSaved }) {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const daysId = useId();
  const reasonId = useId();

  useEffect(() => {
    if (open) {
      setDays(DEFAULT_DAYS);
      setReason('');
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  const validDays = useMemo(() => {
    const n = Number(days);
    return Number.isFinite(n) && n >= MIN_DAYS && n <= MAX_DAYS;
  }, [days]);

  const previewDate = useMemo(
    () => (validDays ? computeNewTrial(tenant?.trial_until, days) : null),
    [tenant?.trial_until, days, validDays]
  );

  const expiredDays = trialExpiredInfo(tenant?.trial_until);

  const handleSubmit = async () => {
    if (!tenant || !validDays) return;
    setSubmitting(true);
    setError('');
    try {
      const trimmed = reason.trim();
      await adminApi.extendTrial(tenant.id, {
        days: Number(days),
        reason: trimmed || undefined,
      });
      onSaved?.();
    } catch (err) {
      setError(err?.message || 'No pudimos extender el trial.');
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
      title="Extender trial"
      size="md"
      actions={
        <>
          <Btn kind="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Btn>
          <Btn
            kind="primary"
            onClick={handleSubmit}
            disabled={!validDays || submitting}
          >
            {submitting
              ? 'Extendiendo…'
              : `Extender ${validDays ? days : '—'} días`}
          </Btn>
        </>
      }
    >
      <div className="flex-row" style={{ gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <span>
          Trial actual hasta{' '}
          <strong>{fmtDate(tenant?.trial_until) || 'sin fecha'}</strong>
        </span>
        {expiredDays != null && (
          <Badge tone="neg">
            Vencido hace {expiredDays} {expiredDays === 1 ? 'día' : 'días'}
          </Badge>
        )}
      </div>

      <div className="stack" style={{ gap: 14 }}>
        <div>
          <label className="form-label" htmlFor={daysId}>Días a extender</label>
          <input
            id={daysId}
            className="input"
            type="number"
            min={MIN_DAYS}
            max={MAX_DAYS}
            step="1"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            disabled={submitting}
          />
          <div className="muted tiny" style={{ marginTop: 4 }}>
            Cuántos días extender el trial actual ({MIN_DAYS}–{MAX_DAYS}).
          </div>
          {previewDate && (
            <div style={{ marginTop: 6, fontWeight: 600 }}>
              Nuevo trial hasta: {fmtDate(previewDate.toISOString())}
            </div>
          )}
        </div>

        <div>
          <label className="form-label" htmlFor={reasonId}>Motivo (opcional)</label>
          <input
            id={reasonId}
            className="input"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ej: cliente pidió más tiempo de evaluación"
            disabled={submitting}
          />
          <div className="muted tiny" style={{ marginTop: 4 }}>
            Para el audit (opcional).
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
