// ForgotPassword — pantalla pública del admin console (2026-07-04).
//
// Port del flow que ya existe en frontend/src/screens/ForgotPassword.jsx
// (TANDA 0 #321, BLOCKER B1 audit 2026-06-18). Diferencias vs. el portal:
//
//   · Diseño: card centrada (mismo look que Login.jsx del admin) en lugar
//     del split-screen del portal. El admin es una app "utilitaria", no un
//     landing comercial — no tiene sentido el brand-panel gigante.
//   · Sin hCaptcha: el pool de super-admins es <10 personas, el volumen de
//     requests a este endpoint es prácticamente cero. Ver comentario en
//     lib/api.js → auth.forgotPassword para el trade-off completo.
//   · Mensaje genérico anti-enum específico para super-admin: si el email
//     NO corresponde a un super-admin (o no existe), backend responde 200
//     igual, y nosotros mostramos el mismo texto "si tiene cuenta de
//     super-admin, te mandamos link". Un usuario común del portal que
//     accidentalmente llega acá no ve nada distinto que un email random.
//
// Flow:
//   1. User clickea "¿Olvidaste tu contraseña?" en /login → llega acá.
//   2. Ingresa email → submit → POST /api/auth/forgot-password.
//   3. Backend responde 200 (idempotente, anti-enum). Mostramos card
//      genérica "revisá tu email".
//   4. User va al email → click link → llega a /reset-password?token=...
//      (manejado por ResetPassword.jsx, próximo archivo en este PR).

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { auth as authApi } from '../lib/api.js';
import { Btn } from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    // Normalizamos a lowercase + trim antes de mandar (mismo pattern que
    // el portal). El backend también lo normaliza pero doble check no molesta,
    // y así la card "te mandamos a X" muestra el email limpio.
    const normalized = email.trim().toLowerCase();
    try {
      await authApi.forgotPassword(normalized);
      setSubmittedEmail(normalized);
      setSubmitted(true);
    } catch (err) {
      // Backend responde 200 aún cuando el email no existe (anti-enum). Un
      // error real acá es red/servidor caído o rate-limit (429). Mostramos
      // el mensaje genérico para no dar señal sobre el estado del email.
      // Excepción: si es un 5xx obvio, mostramos "problema del servidor" —
      // así el operador legítimo entiende que debe reintentar.
      if (err?.status >= 500) {
        setError('Problema del servidor. Reintentá en unos segundos.');
      } else if (err?.status === 429) {
        setError('Demasiados intentos. Esperá unos minutos y reintentá.');
      } else {
        setError(err?.message || 'No pudimos procesar el pedido. Reintentá.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="u-invite-page-wrap">
      <div className="card u-login-card">
        <div className="brand-mark u-invite-brand-mark" aria-hidden="true">
          T
        </div>

        {submitted ? (
          <>
            <h1 className="u-invite-title">
              Revisá tu email
            </h1>
            <p
              className="muted u-fs-13-text-center-m"
              role="status"
              aria-live="polite"
            >
              Si <strong className="u-strong-email">{submittedEmail}</strong>{' '}
              tiene una cuenta de super-admin, te mandamos un link para resetear
              la contraseña. Revisá tu bandeja (y la carpeta de spam).
            </p>

            <Btn
              type="button"
              kind="primary"
              onClick={() => navigate('/login')}
              className="u-w-100-mt-4"
            >
              Volver al login
            </Btn>

            <p className="muted tiny u-text-center-m-16-0-0">
              ¿Te equivocaste de email?{' '}
              <button
                type="button"
                onClick={() => {
                  setSubmitted(false);
                  setSubmittedEmail('');
                  setEmail('');
                  setError('');
                }}
                className="u-retry-link"
              >
                Reintentar
              </button>
            </p>
          </>
        ) : (
          <>
            <h1 className="u-invite-title">
              Recuperar contraseña
            </h1>
            <p className="muted u-fs-13-text-center-24">
              Pasanos tu email y te mandamos un link para elegir una nueva.
            </p>

            {error && (
              <div role="alert" className="u-invite-alert-error">
                {error}
              </div>
            )}

            <form onSubmit={onSubmit} noValidate>
              <div className="stack u-gap-12">
                <div className="input-group">
                  <span className="addon addon-l">
                    <Icons.Users size={14} />
                  </span>
                  <input
                    className="input with-addon-l"
                    type="email"
                    placeholder="tu@empresa.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus
                    required
                    aria-label="Email"
                  />
                </div>

                <Btn
                  type="submit"
                  kind="primary"
                  disabled={busy || !email}
                  className="btn-block u-w-100-mt-4"
                >
                  {busy ? 'Enviando…' : 'Mandar link de reset'}
                </Btn>
              </div>
            </form>

            <p
              className="muted tiny u-text-center-m-20-0-0"
            >
              <Link
                to="/login"
                className="u-color-muted-underline"
              >
                Volver al login
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
