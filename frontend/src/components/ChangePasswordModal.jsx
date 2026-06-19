/**
 * ChangePasswordModal — UI para cambiar la propia contraseña.
 *
 * Cierra el gap detectado en staging 2026-06-17 (task #306): el endpoint
 * POST /api/auth/change-password existía pero NO había forma de invocarlo
 * desde el portal. Admins tenían que recurrir a fetch desde DevTools console
 * (workaround inestable + filtra passwords en console history).
 *
 * Flujo:
 *   1. User abre modal desde UserPill (sidebar).
 *   2. Form pide: password actual + nueva + confirmar nueva.
 *   3. Submit → POST /api/auth/change-password (sin twofa_code).
 *   4. Backend responde:
 *      - 200 { ok: true }                                → éxito → toast +
 *                                                          auto-logout (JWT
 *                                                          quedó inválido).
 *      - 401 { twofa_required: true, error: '...' }      → mostrar input 2FA →
 *                                                          re-submit con code.
 *      - 401 { error: 'Código 2FA incorrecto.' }         → inline error en input 2FA.
 *      - 400 { error: 'Datos inválidos' }                → password policy
 *                                                          (min 8, letra,
 *                                                          número) — mostrar
 *                                                          el mensaje del
 *                                                          backend si lo da.
 *      - 401 { error: 'Contraseña actual incorrecta.' }  → inline.
 *
 * Decisiones durables:
 *   - Validación cliente DUPLICA la del backend (defense-in-depth UX):
 *     min 8 chars + letra + número + confirm match. El backend igual valida
 *     (canónico), pero ahorramos round-trip cuando es trivial.
 *   - Tras éxito, hacemos `logout()` automático del AuthContext porque el
 *     backend bumpea `password_changed_at` → middleware `requireAuth` rechaza
 *     el JWT del cliente al próximo request. Sin auto-logout, el user vería
 *     401 fantasmas al navegar.
 *   - Modal usa `useModal` hook (Esc, scroll-lock, focus-trap, restore-focus —
 *     auditoría 2026-06-10 U-08).
 *   - Los inputs son `type="password"` con toggle visible vía botón. NO
 *     autocompletamos `current-password` para `newPassword` (autocomplete
 *     correcto = "new-password") — evita que el password manager autocomplete
 *     la actual en el campo nueva.
 */

import { useEffect, useRef, useState } from 'react';
import { auth as authApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useModal } from '../lib/useModal';
import { friendlyError } from '../lib/friendlyError';
// 2026-06-18 #322: política centralizada en lib/passwordPolicy. Antes vivía
// duplicada inline acá (con la misma lógica).
import { validatePasswordPolicy, MIN_PASSWORD_LENGTH } from '../lib/passwordPolicy';

export default function ChangePasswordModal({ open, onClose }) {
  const { logout } = useAuth();
  const { toast } = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [twofaRequired, setTwofaRequired]     = useState(false);
  const [twofaCode, setTwofaCode]             = useState('');
  const [showCurrent, setShowCurrent]         = useState(false);
  const [showNew, setShowNew]                 = useState(false);
  const [loading, setLoading]                 = useState(false);
  const [error, setError]                     = useState('');
  const [fieldErrors, setFieldErrors]         = useState({});

  const overlayRef = useRef(null);
  useModal({ open, onClose: handleCancel, overlayRef });

  // Reset state al abrir/cerrar. Sin esto, los inputs quedan con valores
  // viejos si el user reabre el modal (security: passwords no deben persistir).
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
      setFieldErrors({});
    }
  }, [open]);

  function handleCancel() {
    if (loading) return; // no permitir cerrar a la mitad del request
    onClose();
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
    e?.preventDefault();
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
      // Éxito: el JWT del cliente quedó inválido (backend bumpeó
      // password_changed_at). Toast + logout automático.
      toast.success('Contraseña actualizada. Iniciá sesión con la nueva.');
      onClose();
      // Pequeño delay para que el toast se vea antes del redirect a login.
      setTimeout(() => logout(), 800);
    } catch (err) {
      // El wrapper api() (lib/api.js) lanza Error con `.status` y
      // `.responseBody` (no `.body` — naming intencional para no chocar con
      // Response.body nativo). Distinguimos casos.
      //
      // 2026-06-18 #318: branching por `code` (enum stable), no por regex
      // sobre `error` string. Ver backend/src/lib/authErrorCodes.js para la
      // lista de codes. Mantenemos fallback a regex/twofa_required por si
      // llega un response viejo (deploy lag entre backend y frontend).
      // Eliminar fallback después de un release stable con codes en backend.
      const status = err?.status;
      const body   = err?.responseBody || {};
      const code   = body.code;

      // 2FA required (legítimo, primera vez que el modal ve que el user tiene
      // 2FA activo). NO mostramos error rojo — mostramos el input de 2FA.
      const isTwofaRequired = code === 'TWOFA_REQUIRED' || body.twofa_required === true;
      // 2FA code inválido (re-submit con código mal copiado / vencido).
      const isInvalidTwofa  = code === 'INVALID_TWOFA_CODE' || /2FA/i.test(body.error || '');

      if (status === 401 && isTwofaRequired) {
        setTwofaRequired(true);
        setError(''); // limpiar cualquier error previo
        // Mover focus al input de 2FA tras render
        setTimeout(() => {
          document.getElementById('change-pw-2fa')?.focus();
        }, 50);
      } else if (status === 401 && isInvalidTwofa) {
        setFieldErrors(f => ({ ...f, twofaCode: 'Código incorrecto' }));
      } else if (status === 401) {
        // Default: contraseña actual incorrecta (code === 'INVALID_CURRENT_PASSWORD').
        setFieldErrors(f => ({ ...f, currentPassword: 'Contraseña incorrecta' }));
      } else if (status === 400) {
        // Validación del backend rechazó algo. Si trae mensaje específico,
        // mostrarlo; sino genérico.
        setError(body.error || 'Datos inválidos');
      } else {
        // Red, 500, etc.
        setError(friendlyError(err) || 'No se pudo cambiar la contraseña. Intentá de nuevo.');
      }
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      onClick={handleCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-pw-modal-title"
      style={{ zIndex: 500 }}
    >
      <form
        className="modal"
        style={{ maxWidth: 440 }}
        onClick={e => e.stopPropagation()}
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="modal-hd">
          <h3 id="change-pw-modal-title">Cambiar contraseña</h3>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && (
            <div
              role="alert"
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: 'var(--neg)',
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}

          {/* Contraseña actual */}
          <div>
            <label htmlFor="change-pw-current" style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              Contraseña actual
            </label>
            <div style={{ position: 'relative' }}>
              <input
                id="change-pw-current"
                type={showCurrent ? 'text' : 'password'}
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                disabled={loading || twofaRequired}
                aria-invalid={!!fieldErrors.currentPassword}
                style={{ width: '100%', paddingRight: 38 }}
                data-autofocus
              />
              <button
                type="button"
                onClick={() => setShowCurrent(v => !v)}
                aria-label={showCurrent ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                style={{
                  position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', fontSize: 12, padding: 4,
                }}
                tabIndex={-1}
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

          {/* Contraseña nueva */}
          <div>
            <label htmlFor="change-pw-new" style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              Contraseña nueva
            </label>
            <div style={{ position: 'relative' }}>
              <input
                id="change-pw-new"
                type={showNew ? 'text' : 'password'}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                autoComplete="new-password"
                disabled={loading || twofaRequired}
                aria-invalid={!!fieldErrors.newPassword}
                style={{ width: '100%', paddingRight: 38 }}
              />
              <button
                type="button"
                onClick={() => setShowNew(v => !v)}
                aria-label={showNew ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                style={{
                  position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', fontSize: 12, padding: 4,
                }}
                tabIndex={-1}
              >
                {showNew ? '🙈' : '👁'}
              </button>
            </div>
            {fieldErrors.newPassword ? (
              <div style={{ fontSize: 12, color: 'var(--neg)', marginTop: 4 }}>
                {fieldErrors.newPassword}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                Mínimo {MIN_PASSWORD_LENGTH} caracteres, con letra y número.
              </div>
            )}
          </div>

          {/* Confirmar contraseña nueva */}
          <div>
            <label htmlFor="change-pw-confirm" style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              Confirmar contraseña nueva
            </label>
            <input
              id="change-pw-confirm"
              type={showNew ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              disabled={loading || twofaRequired}
              aria-invalid={!!fieldErrors.confirmPassword}
              style={{ width: '100%' }}
            />
            {fieldErrors.confirmPassword && (
              <div style={{ fontSize: 12, color: 'var(--neg)', marginTop: 4 }}>
                {fieldErrors.confirmPassword}
              </div>
            )}
          </div>

          {/* Input 2FA — solo si el backend lo pidió */}
          {twofaRequired && (
            <div>
              <label htmlFor="change-pw-2fa" style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                Código 2FA
              </label>
              <input
                id="change-pw-2fa"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={20}
                value={twofaCode}
                onChange={e => setTwofaCode(e.target.value)}
                autoComplete="one-time-code"
                disabled={loading}
                placeholder="6 dígitos o recovery code"
                aria-invalid={!!fieldErrors.twofaCode}
                style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', letterSpacing: '0.1em' }}
              />
              {fieldErrors.twofaCode ? (
                <div style={{ fontSize: 12, color: 'var(--neg)', marginTop: 4 }}>
                  {fieldErrors.twofaCode}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Abrí tu app de 2FA (Google Authenticator, Authy, etc.) y pegá el código actual.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-ft">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleCancel}
            disabled={loading}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
          >
            {loading
              ? (twofaRequired ? 'Verificando…' : 'Cambiando…')
              : (twofaRequired ? 'Confirmar →' : 'Cambiar contraseña')}
          </button>
        </div>
      </form>
    </div>
  );
}
