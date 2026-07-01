// InviteAdminModal — POST /api/super-admin/team/invite (#499).
//
// Form para que el super-admin invite a otro admin al back office. Vive
// dentro de la pantalla Equipo. Muestra preview del email antes de enviar.
//
// Validación cliente-side (defensivo — el server valida igual):
//   · email formato básico + no vacío
//   · nombre no vacío + max 100 chars
//
// Después del 201, el parent (Equipo) llama onCreated(res) — refresca la
// lista y muestra toast.

import { useEffect, useId, useState } from 'react';
import Modal from '../primitives/Modal.jsx';
import { Btn, Badge } from '../primitives/index.jsx';
import { adminApi } from '../../lib/api.js';

// Regex "razonable" idéntica al pattern usado en CreateTenantModal.
// El server valida con zod.email() — este check corta typos obvios.
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INITIAL = {
  email: '',
  nombre: '',
};

export default function InviteAdminModal({ open, onClose, onCreated }) {
  const [form, setForm] = useState(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const emailId = useId();
  const nombreId = useId();

  // Reset al abrir — sin esto un cierre accidental + reapertura muestra
  // los datos del intento anterior.
  useEffect(() => {
    if (open) {
      setForm(INITIAL);
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const email = form.email.trim();
  const nombre = form.nombre.trim();
  const emailOK = EMAIL_RX.test(email);
  const nombreOK = nombre.length >= 1 && nombre.length <= 100;
  const formValid = emailOK && nombreOK;

  const handleSubmit = async () => {
    if (!formValid) {
      if (!nombreOK) return setError('El nombre es requerido.');
      if (!emailOK) return setError('Email inválido.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await adminApi.team.invite({ email, nombre });
      onCreated?.(res);
    } catch (err) {
      // El backend devuelve `error` field en español user-friendly.
      // 409 con code=already_super_admin o pending_invite_exists son los
      // mensajes más comunes — el text ya alcanza. err.status queda
      // disponible para branching futuro si lo necesitamos.
      setError(err?.message || 'No pudimos enviar la invitación.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Invitar admin"
      size="md"
      // Mutación con email-send. Click accidental en backdrop NO debe
      // descartar el form — mismo pattern que CreateTenantModal.
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
            {submitting ? 'Enviando…' : 'Enviar invitación'}
          </Btn>
        </>
      }
    >
      <p className="muted tiny" style={{ marginTop: 0, marginBottom: 14 }}>
        Le mandamos un email con un link para que elija su password. El link
        vence en 48 horas.
      </p>

      <div className="stack" style={{ gap: 14 }}>
        <div>
          <label className="form-label" htmlFor={emailId}>
            Email <span style={{ color: 'var(--neg)' }}>*</span>
          </label>
          <input
            id={emailId}
            className="input"
            type="email"
            value={form.email}
            onChange={(e) => update('email', e.target.value)}
            placeholder="socio@ejemplo.com"
            maxLength={255}
            spellCheck={false}
            autoComplete="off"
            disabled={submitting}
            autoFocus
          />
          {form.email && !emailOK && (
            <div className="tiny" style={{ color: 'var(--neg)', marginTop: 4 }}>
              Email inválido.
            </div>
          )}
        </div>

        <div>
          <label className="form-label" htmlFor={nombreId}>
            Nombre <span style={{ color: 'var(--neg)' }}>*</span>
          </label>
          <input
            id={nombreId}
            className="input"
            type="text"
            value={form.nombre}
            onChange={(e) => update('nombre', e.target.value)}
            placeholder="Ej: María García"
            maxLength={100}
            disabled={submitting}
          />
          <div className="muted tiny" style={{ marginTop: 4 }}>
            Aparece en el saludo del email.
          </div>
        </div>

        {/* Preview del email — muestra a quién le vamos a mandar. */}
        <div className="banner banner-info" role="note" style={{ padding: 10 }}>
          <Badge tone="info">Preview</Badge>
          <span className="tiny" style={{ marginLeft: 6 }}>
            Vamos a mandarle un email a <strong>{email || 'este@ejemplo.com'}</strong>{' '}
            desde Tecny con un link que expira en 48 hs.
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
