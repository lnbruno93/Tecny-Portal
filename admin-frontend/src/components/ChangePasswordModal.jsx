// ChangePasswordModal — modal de cambio de contraseña del super-admin,
// wrapper sobre POST /api/auth/change-password (task #498).
//
// Portado de frontend/src/components/ChangePasswordModal.jsx con estas
// simplificaciones específicas del back office:
//   · Usa el Modal primitive de ./primitives/Modal.jsx como wrapper
//     (title + actions + Esc + overlay + focus trap). NO uso useModal
//     porque el admin-frontend no lo tiene y el primitive ya cubre lo
//     esencial.
//   · SIN useToast — mostramos el mensaje de éxito como state local
//     (`success`) dentro del modal para que el user lo vea antes del
//     auto-logout (delay de 800ms).
//   · SIN friendlyError shared — mapeo simple de códigos/status en línea,
//     misma UX que el portal.
//
// Flujo:
//   1. User abre modal desde MiCuenta (tab Seguridad).
//   2. Form pide: password actual + nueva + confirmar nueva.
//   3. Submit → POST /api/auth/change-password (sin twofa_code).
//   4. Backend responde:
//      - 200 { ok: true }                                → éxito → banner verde +
//                                                          auto-logout tras 800ms
//                                                          (JWT quedó inválido).
//      - 401 { code: 'TWOFA_REQUIRED' } (o twofa_required:true)
//                                                        → mostrar input 2FA →
//                                                          re-submit con code.
//      - 401 { code: 'INVALID_TWOFA_CODE' }              → error inline en 2FA.
//      - 401 { code: 'INVALID_CURRENT_PASSWORD' } (o 401 sin code)
//                                                        → error inline en actual.
//      - 400 { error: '...' }                            → error del backend
//                                                          (password policy).
//
// Efecto side críticos:
//   · Post-éxito hacemos logout() del AuthContext porque el backend bumpea
//     `password_changed_at` → todos los JWTs viejos del user quedan invalidos
//     → sin auto-logout, el user vería 401 fantasmas al navegar. El delay
//     de 800ms es para que vea el mensaje de éxito antes del redirect.
//
// Toggle mostrar/ocultar password: emojis 👁 / 🙈 — matcheamos exactamente
// lo que hace el portal por consistencia visual para Lucas (mismo user).

import { useEffect, useState } from 'react';
import { auth as authApi } from '../lib/api.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { Btn } from './primitives/index.jsx';
import Modal from './primitives/Modal.jsx';
import { validatePasswordPolicy, MIN_PASSWORD_LENGTH } from '../lib/passwordPolicy.js';

export default function ChangePasswordModal({ open, onClose, onSuccess }) {
  const { logout } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [twofaRequired, setTwofaRequired]     = useState(false);
  const [twofaCode, setTwofaCode]             = useState('');
  const [showCurrent, setShowCurrent]         = useState(false);
  const [showNew, setShowNew]                 = useState(false);
  const [loading, setLoading]                 = useState(false);
  const [error, setError]                     = useState('');
  const [success, setSuccess]                 = useState('');
  const [fieldErrors, setFieldErrors]         = useState({});

  // Reset state al abrir/cerrar. Security: passwords NO deben persistir en
  // memoria si el user cierra y reabre el modal — un shoulder-surfer con
  // React DevTools abierto podría leerlos.
  useEffect(() => {
    if (!open) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTwofaRequired(false);
      setTwofaCode('');
      setShowCurrent(false);
      setShowNew(false);
      setLoading(false);
      setError('');
      setSuccess('');
      setFieldErrors({});
    }
  }, [open]);

  function handleClose() {
    if (loading) return; // no permitir cerrar a la mitad del request
    onClose?.();
  }

  function validateClient() {
    const errs = {};
    if (!currentPassword) errs.currentPassword = 'Requerida';
    const pwErr = validatePasswordPolicy(newPassword);
    if (pwErr) errs.newPassword = pwErr;
    if (newPassword && confirmPassword !== newPassword) {
      errs.confirmPassword = 'Las contraseñas no coinciden';
    }
    if (newPassword && newPassword === currentPassword) {
      errs.newPassword = 'La nueva debe ser distinta a la actual';
    }
    if (twofaRequired && !twofaCode) {
      errs.twofaCode = 'Requerido';
    }
    return errs;
  }

  async function handleSubmit(e) {
    e?.preventDefault?.();
    setError('');
    const errs = validateClient();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setLoading(true);
    try {
      await authApi.changePassword(
        currentPassword,
        newPassword,
        twofaRequired ? twofaCode.trim() : undefined,
      );
      // Éxito: mostrar banner verde adentro del modal y disparar auto-logout
      // con delay para que el user alcance a leer el mensaje antes del redirect.
      setSuccess('Contraseña actualizada. Vamos a cerrar tu sesión para que ingreses con la nueva.');
      onSuccess?.();
      setTimeout(() => {
        logout();
      }, 800);
    } catch (err) {
      // Mismo branching que el portal — priorizamos `code` (enum stable en
      // el backend) sobre el string `error` (formato humano, variable).
      const status = err?.status;
      const body   = err?.responseBody || {};
      const code   = body.code;

      const isTwofaRequired = code === 'TWOFA_REQUIRED' || body.twofa_required === true;
      const isInvalidTwofa  = code === 'INVALID_TWOFA_CODE' || /2FA/i.test(body.error || '');

      if (status === 401 && isTwofaRequired) {
        setTwofaRequired(true);
        setError('');
        // Focus el input de 2FA una vez montado.
        setTimeout(() => {
          document.getElementById('admin-change-pw-2fa')?.focus();
        }, 50);
      } else if (status === 401 && isInvalidTwofa) {
        setFieldErrors((f) => ({ ...f, twofaCode: 'Código incorrecto' }));
      } else if (status === 401) {
        setFieldErrors((f) => ({ ...f, currentPassword: 'Contraseña incorrecta' }));
      } else if (status === 400) {
        setError(body.error || err.message || 'Datos inválidos');
      } else {
        setError(err.message || 'No se pudo cambiar la contraseña. Intentá de nuevo.');
      }
    } finally {
      setLoading(false);
    }
  }

  // Modal cerrado → no renderizar nada. El Modal primitive también lo
  // maneja pero preferimos short-circuit acá para no ejecutar la lógica
  // interna del componente cuando está cerrado.
  if (!open) return null;

  const submitLabel = loading
    ? (twofaRequired ? 'Verificando…' : 'Cambiando…')
    : (twofaRequired ? 'Confirmar' : 'Cambiar contraseña');

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Cambiar contraseña"
      size="md"
      actions={
        <>
          <Btn kind="ghost" onClick={handleClose} disabled={loading}>
            Cancelar
          </Btn>
          <Btn kind="primary" onClick={handleSubmit} disabled={loading || !!success}>
            {submitLabel}
          </Btn>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {success && (
          <div
            role="status"
            aria-live="polite"
            style={{
              padding: '10px 12px', borderRadius: 8,
              background: 'rgba(34, 197, 94, 0.1)',
              border: '1px solid rgba(34, 197, 94, 0.3)',
              color: 'var(--pos)', fontSize: 13,
            }}
          >
            {success}
          </div>
        )}

        {error && !success && (
          <div
            role="alert"
            style={{
              padding: '10px 12px', borderRadius: 8,
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: 'var(--neg)', fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        {/* ── Contraseña actual ── */}
        <div>
          <label
            htmlFor="admin-change-pw-current"
            style={{ display: 'block', fontSize: 12, marginBottom: 6 }}
          >
            Contraseña actual
          </label>
          <div style={{ position: 'relative' }}>
            <input
              id="admin-change-pw-current"
              type={showCurrent ? 'text' : 'password'}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              disabled={loading || twofaRequired || !!success}
              aria-invalid={!!fieldErrors.currentPassword}
              style={{ width: '100%', paddingRight: 38 }}
            />
            <button
              type="button"
              onClick={() => setShowCurrent((v) => !v)}
              aria-label={showCurrent ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              tabIndex={-1}
              style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontSize: 12, padding: 4,
              }}
            >
              {showCurrent ? '🙈' : '👁'}
            </button>
          </div>
          {fieldErrors.currentPassword && (
            <div style={{ fontSize: 12, color: 'var(--neg)', marginTop: 4 }}>
              {fieldErrors.currentPassword}
            </div>
          )}
        </div>

        {/* ── Contraseña nueva ── */}
        <div>
          <label
            htmlFor="admin-change-pw-new"
            style={{ display: 'block', fontSize: 12, marginBottom: 6 }}
          >
            Contraseña nueva
          </label>
          <div style={{ position: 'relative' }}>
            <input
              id="admin-change-pw-new"
              type={showNew ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              disabled={loading || twofaRequired || !!success}
              aria-invalid={!!fieldErrors.newPassword}
              style={{ width: '100%', paddingRight: 38 }}
            />
            <button
              type="button"
              onClick={() => setShowNew((v) => !v)}
              aria-label={showNew ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              tabIndex={-1}
              style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontSize: 12, padding: 4,
              }}
            >
              {showNew ? '🙈' : '👁'}
            </button>
          </div>
          {fieldErrors.newPassword ? (
            <div style={{ fontSize: 12, color: 'var(--neg)', marginTop: 4 }}>
              {fieldErrors.newPassword}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Mínimo {MIN_PASSWORD_LENGTH} caracteres, con letra y número.
            </div>
          )}
        </div>

        {/* ── Confirmar contraseña nueva ── */}
        <div>
          <label
            htmlFor="admin-change-pw-confirm"
            style={{ display: 'block', fontSize: 12, marginBottom: 6 }}
          >
            Confirmar contraseña nueva
          </label>
          <input
            id="admin-change-pw-confirm"
            type={showNew ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            disabled={loading || twofaRequired || !!success}
            aria-invalid={!!fieldErrors.confirmPassword}
            style={{ width: '100%' }}
          />
          {fieldErrors.confirmPassword && (
            <div style={{ fontSize: 12, color: 'var(--neg)', marginTop: 4 }}>
              {fieldErrors.confirmPassword}
            </div>
          )}
        </div>

        {/* ── Input 2FA — solo si el backend lo pidió ── */}
        {twofaRequired && (
          <div>
            <label
              htmlFor="admin-change-pw-2fa"
              style={{ display: 'block', fontSize: 12, marginBottom: 6 }}
            >
              Código 2FA
            </label>
            <input
              id="admin-change-pw-2fa"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={20}
              value={twofaCode}
              onChange={(e) => setTwofaCode(e.target.value)}
              autoComplete="one-time-code"
              disabled={loading || !!success}
              placeholder="6 dígitos o recovery code"
              aria-invalid={!!fieldErrors.twofaCode}
              style={{
                width: '100%',
                fontFamily: 'monospace', letterSpacing: '0.1em',
              }}
            />
            {fieldErrors.twofaCode ? (
              <div style={{ fontSize: 12, color: 'var(--neg)', marginTop: 4 }}>
                {fieldErrors.twofaCode}
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Abrí tu app de 2FA y pegá el código actual.
              </div>
            )}
          </div>
        )}

        {/* Submit hidden — el botón real vive en modal actions. Este
            input hidden permite que Enter dentro de cualquier campo dispare
            el submit del form. */}
        <button type="submit" style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
