import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { auth as authApi } from '../lib/api';
// 2026-06-18 #322: política centralizada en lib/passwordPolicy. Antes vivía
// duplicada inline acá (con la misma lógica).
import { validatePasswordPolicy, MIN_PASSWORD_LENGTH } from '../lib/passwordPolicy';

// ResetPassword — TANDA 0 #321 (BLOCKER B1 audit 2026-06-18).
//
// Flow:
//   1. User clickea link del email → /reset-password?token=<hex>.
//   2. Form pide nueva contraseña + confirmación.
//   3. Submit → POST /api/auth/reset-password.
//   4. Response:
//      - 200 { ok: true } → success screen + redirect a login (2.5s).
//      - 401 { code: 'INVALID_RESET_TOKEN' } → "Link inválido. Pedí uno nuevo."
//      - 401 { code: 'EXPIRED_RESET_TOKEN' } → "Link vencido. Pedí uno nuevo."
//      - 401 { code: 'USED_RESET_TOKEN' } → "Link ya usado. Iniciá sesión."
//      - 400 { fields: [...] } → password policy fail, mostrar inline.
//
// Diseño: card centrada (.auth-screen--center) — diferente del split-screen
// de Login/Signup/ForgotPassword. Es transient (5-10s en pantalla).

const IconLock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 1 1 8 0v3" />
  </svg>
);
const IconEye = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const IconEyeOff = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 4.2A9.5 9.5 0 0 1 12 4c6.5 0 10 7 10 7a16 16 0 0 1-3 3.8M6.6 6.6A16 16 0 0 0 2 11s3.5 7 10 7a9.3 9.3 0 0 0 3.6-.7" />
  </svg>
);
const IconCheckCircle = () => (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M8 12.5l3 3 5.5-6.5" />
  </svg>
);
const IconXCircle = () => (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </svg>
);

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  // Status post-submit:
  //   'form'    — pantalla inicial.
  //   'success' — reset OK, redirect a login (2.5s).
  //   'token-error' — token inválido/expirado/usado, mostrar card de error.
  const [status, setStatus] = useState('form');

  // Si no hay token en URL, mostramos error directo (no tiene sentido renderear el form).
  useEffect(() => {
    if (!token) {
      setStatus('token-error');
      setError('El link no incluye token. Revisá el email que te mandamos.');
    }
  }, [token]);

  function validateClient() {
    const errs = {};
    const pwErr = validatePasswordPolicy(newPassword);
    if (pwErr) errs.newPassword = pwErr;
    if (newPassword && confirmPassword !== newPassword) {
      errs.confirmPassword = 'Las contraseñas no coinciden';
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
      await authApi.resetPassword(token, newPassword);
      setStatus('success');
      setTimeout(() => navigate('/', { replace: true }), 2500);
    } catch (err) {
      const status = err?.status;
      const body = err?.responseBody || {};
      const code = body.code;

      if (status === 401) {
        // Token errors — pantalla dedicada de error (el form ya no sirve, el
        // user debe pedir un link nuevo).
        setStatus('token-error');
        if (code === 'EXPIRED_RESET_TOKEN') {
          setError('Este link de reset venció. Pedí uno nuevo desde "¿Olvidaste tu contraseña?".');
        } else if (code === 'USED_RESET_TOKEN') {
          setError('Este link ya fue usado. Si ya cambiaste la contraseña, iniciá sesión. Si no, pedí un link nuevo.');
        } else {
          setError('El link de reset es inválido. Verificá que lo copiaste completo o pedí uno nuevo.');
        }
      } else if (status === 400) {
        // Password policy fail desde el backend (defensa por si el client-side
        // se evita). Surface fields[].error.
        const fields = body.fields || [];
        const pwField = fields.find(f => f.field === 'newPassword');
        if (pwField) {
          setFieldErrors({ newPassword: pwField.error });
        } else {
          setError(body.error || 'Datos inválidos.');
        }
      } else {
        setError(err.message || 'No pudimos resetear. Reintentá.');
      }
    } finally {
      setLoading(false);
    }
  }

  if (status === 'success') {
    return (
      <div className="auth-screen auth-screen--center">
        <div className="auth-card" role="status" aria-live="polite">
          <div className="auth-card-icon auth-card-icon--ok">
            <IconCheckCircle />
          </div>
          <h1>¡Contraseña actualizada!</h1>
          <p>Listo. Iniciá sesión con tu nueva contraseña. Te llevamos al login…</p>
        </div>
      </div>
    );
  }

  if (status === 'token-error') {
    return (
      <div className="auth-screen auth-screen--center">
        <div className="auth-card" role="alert" aria-live="assertive">
          <div className="auth-card-icon auth-card-icon--err">
            <IconXCircle />
          </div>
          <h1>No se pudo resetear</h1>
          <p>{error}</p>
          <p className="auth-card-cta">
            <Link to="/forgot-password">Pedir un link nuevo</Link>
            {' · '}
            <Link to="/">Volver al login</Link>
          </p>
        </div>
      </div>
    );
  }

  // status === 'form'
  return (
    <div className="auth-screen auth-screen--center">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <h1 style={{ margin: '0 0 8px' }}>Elegí tu nueva contraseña</h1>
        <p style={{ margin: '0 0 20px', color: 'var(--text-muted)', fontSize: 14 }}>
          Una vez confirmada, vas a poder iniciar sesión con la nueva.
        </p>

        <form onSubmit={handleSubmit} style={{ textAlign: 'left' }}>
          <div className="field">
            <label htmlFor="reset-new">Contraseña nueva</label>
            <div className="iw">
              <span className="lead"><IconLock /></span>
              <input
                id="reset-new"
                type={showPw ? 'text' : 'password'}
                placeholder="Mínimo 8 caracteres, con letra y número"
                autoComplete="new-password"
                autoFocus
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                required
                minLength={MIN_PASSWORD_LENGTH}
                aria-invalid={!!fieldErrors.newPassword}
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowPw(s => !s)}
                aria-label={showPw ? 'Ocultar contraseña' : 'Mostrar contraseña'}
              >
                {showPw ? <IconEyeOff /> : <IconEye />}
              </button>
            </div>
            {fieldErrors.newPassword ? (
              <div className="field-note" style={{ color: 'var(--neg)' }}>
                {fieldErrors.newPassword}
              </div>
            ) : (
              <div className="field-note">
                Mínimo {MIN_PASSWORD_LENGTH} caracteres, con letra y número.
              </div>
            )}
          </div>

          <div className="field">
            <label htmlFor="reset-confirm">Confirmar contraseña</label>
            <div className="iw">
              <span className="lead"><IconLock /></span>
              <input
                id="reset-confirm"
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
                aria-invalid={!!fieldErrors.confirmPassword}
              />
            </div>
            {fieldErrors.confirmPassword && (
              <div className="field-note" style={{ color: 'var(--neg)' }}>
                {fieldErrors.confirmPassword}
              </div>
            )}
          </div>

          <button className="login-btn" type="submit" disabled={loading} style={{ marginTop: 8 }}>
            {loading ? 'Guardando…' : 'Cambiar contraseña →'}
          </button>

          {error && (
            <div className="login-err" role="alert" aria-live="assertive" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
        </form>

        <p className="auth-card-cta" style={{ marginTop: 20 }}>
          <Link to="/">Volver al login</Link>
        </p>
      </div>
    </div>
  );
}
