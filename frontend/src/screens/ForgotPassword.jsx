import { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import { auth as authApi } from '../lib/api';

// ForgotPassword — TANDA 0 #321 (BLOCKER B1 audit 2026-06-18).
//
// Flow:
//   1. User clickea "¿Olvidaste tu contraseña?" en Login → llega acá.
//   2. Ingresa email + (eventualmente) hCaptcha → submit.
//   3. Backend responde 200 idéntica para email existente vs no-existente
//      (anti-enum) → mostramos pantalla "revisá tu email" SIN distinguir.
//   4. User va al email → clickea link → llega a /reset-password?token=...
//      (manejado por ResetPassword.jsx).
//
// Diseño: split-screen mirror de Login/Signup. Reusa clases .auth-screen y
// .lg-* del CSS compartido. Eyebrow del panel marca dice "Recuperar acceso".

const HCAPTCHA_SITE_KEY = import.meta.env.VITE_HCAPTCHA_SITE_KEY
  || '10000000-ffff-ffff-ffff-000000000001';

// Iconos inline — mirror de los que usan Login.jsx + Signup.jsx.
const IconMail = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 7 9-7" />
  </svg>
);
const IconShield = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z" />
  </svg>
);
const IconKey = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 1 1 8 0v3" />
  </svg>
);
const IconRefresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [ttlHours, setTtlHours] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [captchaToken, setCaptchaToken] = useState(null);
  const captchaRef = useRef(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const data = await authApi.forgotPassword(
        normalizedEmail,
        captchaToken || undefined,
      );
      // Backend responde idéntico para existing/non-existing (anti-enum).
      // Mostramos siempre la pantalla "revisá tu email".
      setSubmittedEmail(normalizedEmail);
      if (data && data.reset_token_ttl_hours) {
        setTtlHours(data.reset_token_ttl_hours);
      }
      setSubmitted(true);
    } catch (err) {
      setError(err.message || 'No pudimos procesar el pedido. Reintentá.');
      // Reset captcha (token es single-use).
      setCaptchaToken(null);
      if (captchaRef.current) captchaRef.current.resetCaptcha();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div id="forgot-pw-screen" className="auth-screen">
      <aside className="lg-brand">
        <div className="lg-top">
          <div className="lg-mark">T</div>
          <div>
            <div className="lg-name">Tecny</div>
          </div>
        </div>
        <div className="lg-mid">
          <div className="lg-eyebrow"><span className="d" /> Recuperar acceso</div>
          <h2 className="lg-headline">
            Tu cuenta está<br />
            <span className="hl">a un email de distancia.</span>
          </h2>
          <p className="lg-tagline">
            Te mandamos un link para elegir una contraseña nueva. Sin llamadas,
            sin esperar — recuperás el acceso en menos de un minuto.
          </p>
        </div>
        <div className="lg-chips">
          <span className="lg-chip"><IconShield /> Datos cifrados</span>
          <span className="lg-chip"><IconKey /> Link de un solo uso</span>
          <span className="lg-chip"><IconRefresh /> Vence en 1h</span>
        </div>
      </aside>

      <main className="lg-form">
        <div className="login-box">
          <div className="lg-mobile">
            <div className="lg-mark">T</div>
            <div>
              <div className="lg-name">Tecny</div>
            </div>
          </div>

          {submitted ? (
            <>
              <div className="lg-h">
                <h1>Revisá tu email</h1>
                <p>
                  Si{' '}
                  <strong style={{ wordBreak: 'break-all' }}>{submittedEmail}</strong>{' '}
                  está registrado, te mandamos un link para resetear la
                  contraseña. Abrilo desde el email para elegir una nueva.
                </p>
              </div>
              <div className="field-note" style={{ marginTop: 16 }}>
                ¿No lo ves? Revisá la carpeta de spam. El link expira en{' '}
                {ttlHours} {ttlHours === 1 ? 'hora' : 'horas'}.
              </div>
              <div className="field-note u-mt-12">
                ¿Te equivocaste de email?{' '}
                <button
                  type="button"
                  className="lg-link"
                  onClick={() => {
                    setSubmitted(false);
                    setEmail('');
                    setError('');
                  }}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  Volver y reintentar
                </button>
              </div>
              <div className="lg-foot" style={{ marginTop: 20 }}>
                <Link to="/" className="lg-link u-text-none">
                  Volver a iniciar sesión →
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="lg-h">
                <h1>¿Olvidaste tu contraseña?</h1>
                <p>Pasanos tu email y te mandamos un link para elegir una nueva.</p>
              </div>

              <form onSubmit={handleSubmit}>
                <div className="field">
                  <label htmlFor="forgot-email">Email</label>
                  <div className="iw">
                    <span className="lead"><IconMail /></span>
                    <input
                      id="forgot-email"
                      type="email"
                      placeholder="tu@empresa.com"
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      autoFocus
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>

                {/* hCaptcha: misma config que Signup (invisible / passive) */}
                <div style={{ margin: '12px 0', display: 'flex', justifyContent: 'center' }}>
                  <HCaptcha
                    ref={captchaRef}
                    sitekey={HCAPTCHA_SITE_KEY}
                    onVerify={(token) => setCaptchaToken(token)}
                    onExpire={() => setCaptchaToken(null)}
                    onError={() => setCaptchaToken(null)}
                    theme="light"
                  />
                </div>

                <button className="login-btn" type="submit" disabled={loading}>
                  {loading ? 'Mandando link…' : 'Mandar link de reset →'}
                </button>

                {error && (
                  <div className="login-err" role="alert" aria-live="assertive">
                    {error}
                  </div>
                )}
              </form>

              <div className="lg-foot">
                <span>¿Ya te acordaste?</span>
                <Link to="/" className="lg-link u-text-none">
                  Iniciar sesión
                </Link>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
