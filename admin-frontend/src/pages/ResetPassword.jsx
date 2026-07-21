// ResetPassword — pantalla pública del admin console (2026-07-04).
//
// Port del flow de frontend/src/screens/ResetPassword.jsx (TANDA 0 #321).
// Diferencias vs. el portal:
//
//   · Diseño: card centrada consistente con Login/ForgotPassword del admin.
//   · Post-success redirige a /login (no a /) — el admin siempre pasa por
//     login (no hay landing pública "root"). Portal redirige a / porque su
//     raíz es la landing comercial, acá no aplica.
//   · No hay hint sobre 2FA — el user va a caer en /login, que ya maneja
//     el prompt 2FA solo (#510).
//
// Flow:
//   1. User clickea link del email → /reset-password?token=<hex>.
//   2. Estado inicial: 'form'. Si NO hay token en URL, cae directo a
//      'token-error' con mensaje "link sin token".
//   3. Submit → valida policy cliente → POST /api/auth/reset-password.
//   4. Response:
//      - 200 { ok: true } → estado 'success' → redirect a /login (2.5s).
//      - 401 { code: 'INVALID_RESET_TOKEN' | 'EXPIRED_RESET_TOKEN' | 'USED_RESET_TOKEN' }
//        → estado 'token-error' con mensaje específico.
//      - 400 { fields: [{field:'newPassword',error}] } → inline field error.
//      - otros → banner de error genérico.

import { useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { auth as authApi } from '../lib/api.js';
import { Btn } from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_HINT,
  validatePasswordPolicy,
} from '../lib/passwordPolicy.js';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  // Estado inicial derivado del token: si falta, arrancamos en 'token-error'
  // directamente (no tiene sentido renderear el form y después cortarlo).
  // Antes esto vivía en useEffect + setState, pero el linter (react-hooks/
  // set-state-in-effect) marca ese pattern — y con razón: causa un render extra
  // y no hace nada distinto a un initializer function del useState.
  // 'form'         → pantalla inicial (input password + confirm).
  // 'success'      → reset OK, redirect a /login (2.5s).
  // 'token-error'  → token inválido/expirado/usado o no vino en la URL.
  const [status, setStatus] = useState(token ? 'form' : 'token-error');
  const [error, setError] = useState(
    token ? '' : 'El link no incluye token. Revisá el email que te mandamos.'
  );

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
    if (busy) return;
    setError('');
    const errs = validateClient();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setBusy(true);
    try {
      await authApi.resetPassword(token, newPassword);
      setStatus('success');
      // 2.5s de delay para que el user lea "actualizada" antes del redirect.
      // El admin siempre pasa por login post-reset (no hay landing pública).
      // replace:true → si dan atrás, no vuelven al form con token consumido.
      setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (err) {
      const httpStatus = err?.status;
      const body = err?.responseBody || {};
      const code = body.code;

      if (httpStatus === 401) {
        // Token errors — pantalla terminal, el form ya no sirve. El user
        // debe pedir un link nuevo o loguearse si ya lo cambió.
        setStatus('token-error');
        if (code === 'EXPIRED_RESET_TOKEN') {
          setError('Este link de reset venció. Pedí uno nuevo desde "Recuperar contraseña".');
        } else if (code === 'USED_RESET_TOKEN') {
          setError('Este link ya fue usado. Si ya cambiaste la contraseña, iniciá sesión. Si no, pedí un link nuevo.');
        } else {
          // INVALID_RESET_TOKEN o code faltante — mensaje default.
          setError('El link de reset es inválido. Verificá que lo copiaste completo o pedí uno nuevo.');
        }
      } else if (httpStatus === 400) {
        // Backend rechazó la policy (defense in depth por si el chequeo cliente
        // se salta). Surface el fields[].error del backend en el field concreto.
        const fields = body.fields || [];
        const pwField = fields.find((f) => f.field === 'newPassword');
        if (pwField) {
          setFieldErrors({ newPassword: pwField.error });
        } else {
          setError(body.error || 'Datos inválidos.');
        }
      } else {
        setError(err?.message || 'No pudimos resetear. Reintentá.');
      }
    } finally {
      setBusy(false);
    }
  }

  // ─── Success screen ───────────────────────────────────────────────────
  if (status === 'success') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--bg)',
          padding: 24,
        }}
      >
        <div
          className="card"
          style={{
            width: '100%',
            maxWidth: 400,
            padding: 32,
            boxShadow: 'var(--shadow-md)',
            textAlign: 'center',
          }}
          role="status"
          aria-live="polite"
        >
          <div
            className="brand-mark"
            aria-hidden="true"
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              fontSize: 18,
              margin: '0 auto 16px',
              background: 'var(--pos-soft, #e6f8ee)',
              color: 'var(--pos, #1a7f4c)',
            }}
          >
            ✓
          </div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              margin: '0 0 4px',
              color: 'var(--text)',
            }}
          >
            ¡Contraseña actualizada!
          </h1>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Te llevamos al login para que inicies sesión con la nueva.
          </p>
        </div>
      </div>
    );
  }

  // ─── Token-error screen ────────────────────────────────────────────────
  if (status === 'token-error') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--bg)',
          padding: 24,
        }}
      >
        <div
          className="card"
          style={{
            width: '100%',
            maxWidth: 400,
            padding: 32,
            boxShadow: 'var(--shadow-md)',
            textAlign: 'center',
          }}
          role="alert"
          aria-live="assertive"
        >
          <div
            className="brand-mark"
            aria-hidden="true"
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              fontSize: 18,
              margin: '0 auto 16px',
              background: 'var(--neg-soft)',
              color: 'var(--neg)',
            }}
          >
            !
          </div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              margin: '0 0 8px',
              color: 'var(--text)',
            }}
          >
            No se pudo resetear
          </h1>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 20px' }}>
            {error}
          </p>
          <div className="stack u-gap-8">
            <Btn
              type="button"
              kind="primary"
              onClick={() => navigate('/forgot-password')}
              className="u-w-100"
            >
              Pedir un link nuevo
            </Btn>
            <Link
              to="/login"
              className="muted tiny"
              style={{
                textAlign: 'center',
                textDecoration: 'underline',
                color: 'var(--muted)',
              }}
            >
              Volver al login
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ─── Form (default) ────────────────────────────────────────────────────
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
        padding: 24,
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 440,
          padding: 32,
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <div
          className="brand-mark"
          aria-hidden="true"
          style={{
            width: 48,
            height: 48,
            borderRadius: 12,
            fontSize: 18,
            margin: '0 auto 16px',
          }}
        >
          T
        </div>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            textAlign: 'center',
            margin: '0 0 4px',
            color: 'var(--text)',
          }}
        >
          Elegí tu nueva contraseña
        </h1>
        <p
          className="muted"
          style={{ fontSize: 13, textAlign: 'center', margin: '0 0 20px' }}
        >
          Una vez confirmada, vas a poder iniciar sesión con la nueva.
        </p>

        {error && (
          <div
            role="alert"
            style={{
              background: 'var(--neg-soft)',
              color: 'var(--neg)',
              padding: '10px 12px',
              borderRadius: 8,
              fontSize: 13,
              marginBottom: 14,
              border: '1px solid transparent',
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className="stack u-gap-12">
            <div>
              <label className="form-label" htmlFor="reset-new">
                Contraseña nueva
              </label>
              <div className="input-group">
                <span className="addon addon-l">
                  <Icons.Lock size={14} />
                </span>
                <input
                  id="reset-new"
                  className="input with-addon-l"
                  type="password"
                  placeholder={PASSWORD_POLICY_HINT}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  aria-invalid={!!fieldErrors.newPassword}
                  aria-describedby="reset-new-hint"
                />
              </div>
              <div
                id="reset-new-hint"
                className={fieldErrors.newPassword ? 'tiny' : 'muted tiny'}
                style={{
                  marginTop: 4,
                  color: fieldErrors.newPassword ? 'var(--neg)' : undefined,
                }}
              >
                {fieldErrors.newPassword || PASSWORD_POLICY_HINT}
              </div>
            </div>

            <div>
              <label className="form-label" htmlFor="reset-confirm">
                Confirmar contraseña
              </label>
              <div className="input-group">
                <span className="addon addon-l">
                  <Icons.Lock size={14} />
                </span>
                <input
                  id="reset-confirm"
                  className="input with-addon-l"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  aria-invalid={!!fieldErrors.confirmPassword}
                />
              </div>
              {fieldErrors.confirmPassword && (
                <div className="tiny u-color-neg-mt-4">
                  {fieldErrors.confirmPassword}
                </div>
              )}
            </div>

            <Btn
              type="submit"
              kind="primary"
              disabled={busy || !newPassword || !confirmPassword}
              className="btn-block"
              style={{ width: '100%', marginTop: 4 }}
            >
              {busy ? 'Guardando…' : 'Cambiar contraseña'}
            </Btn>
          </div>
        </form>

        <p
          className="muted tiny"
          style={{ textAlign: 'center', margin: '20px 0 0' }}
        >
          <Link
            to="/login"
            style={{ color: 'var(--muted)', textDecoration: 'underline' }}
          >
            Volver al login
          </Link>
        </p>
      </div>
    </div>
  );
}
