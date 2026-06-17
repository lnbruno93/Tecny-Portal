import { useState } from 'react';
import { Link } from 'react-router-dom';
import { auth as authApi } from '../lib/api';

// Signup público (TANDA 2.2 Fase B — visual polish).
//
// Mirror del split-screen de Login.jsx — reusa todas las clases .lg-* y
// .auth-screen (CSS compartido scopeado bajo .auth-screen). Cambios respecto
// del Login:
//   - 4 inputs en vez de 2: nombre, email, password (con ojito), empresa.
//   - No hay flow de 2FA (signup nuevo, no hay user todavía).
//   - Footer: link a / (login) en vez del "Conexión segura".
//   - Heading: "Crear cuenta" en vez de "Ingresá a tu portal".
//   - Eyebrow brand panel: "Cuenta nueva" en vez de "Portal operativo".
//
// TANDA 2.7 anti-enum: la response del backend es **idéntica** para emails
// nuevos vs. duplicados (200 + `{ verification_required: true }`, sin
// token/user/tenant). El frontend NO auto-loguea — muestra una pantalla de
// "revisá tu email" después del submit. El usuario debe clickear el link de
// verificación para luego poder hacer login normalmente. Patrón estándar de
// SaaS (verify-before-use) y único forma de evitar enumeración.

// Iconos inline — duplico los mismos que usa Login.jsx para no acoplar
// los componentes a un Icons.jsx compartido por solo 2 pantallas.
const IconUser = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20a8 8 0 0 1 16 0" />
  </svg>
);
const IconMail = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 7 9-7" />
  </svg>
);
const IconLock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 1 1 8 0v3" />
  </svg>
);
const IconBuilding = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="3" width="16" height="18" rx="1.5" />
    <path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" />
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

export default function Signup() {
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantNombre, setTenantNombre] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // TANDA 2.7 anti-enum: en lugar de navegar a /inicio post-success (lo que
  // requería auto-login), mostramos pantalla "revisá tu email". El email
  // sometido se guarda en `submittedEmail` para personalizar el mensaje.
  const [submittedEmail, setSubmittedEmail] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const normalizedEmail = email.trim().toLowerCase();
    try {
      await authApi.signup({
        nombre: nombre.trim(),
        email: normalizedEmail,
        password,
        tenant_nombre: tenantNombre.trim(),
      });
      // TANDA 2.7: backend response idéntica para email nuevo vs. duplicado
      // (anti-enum). El user no se auto-loguea — debe verificar email primero.
      // Mostramos pantalla "revisá tu email" sin distinguir los dos casos.
      setSubmittedEmail(normalizedEmail);
    } catch (err) {
      setError(err.message || 'No se pudo crear la cuenta.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div id="signup-screen" className="auth-screen">
      {/* Panel marca (izquierda) — mismo que Login pero eyebrow distinto */}
      <aside className="lg-brand">
        <div className="lg-top">
          <div className="lg-mark">iP</div>
          <div>
            <div className="lg-name">iPro</div>
            <div className="lg-sub">Tech Reseller · Celnyx</div>
          </div>
        </div>
        <div className="lg-mid">
          <div className="lg-eyebrow"><span className="d" /> Cuenta nueva</div>
          <h2 className="lg-headline">
            Todo tu negocio,<br />
            <span className="hl">en una sola pantalla.</span>
          </h2>
          <p className="lg-tagline">
            Cotizaciones, comprobantes, cuentas corrientes, envíos y caja — para
            el equipo que mueve el negocio todos los días.
          </p>
        </div>
        <div className="lg-chips">
          <span className="lg-chip"><IconShield /> Datos cifrados</span>
          <span className="lg-chip"><IconKey /> Acceso por permisos</span>
          <span className="lg-chip"><IconRefresh /> Backups diarios</span>
        </div>
      </aside>

      {/* Form (derecha) */}
      <main className="lg-form">
        <div className="login-box">
          <div className="lg-mobile">
            <div className="lg-mark">iP</div>
            <div>
              <div className="lg-name">iPro</div>
              <div className="lg-sub">Tech Reseller · Celnyx</div>
            </div>
          </div>

          {submittedEmail ? (
            // TANDA 2.7: pantalla "revisá tu email". Mensaje idéntico
            // independientemente de si el email era nuevo o ya estaba registrado
            // (anti-enum). No revelamos el resultado del lookup en backend.
            <>
              <div className="lg-h">
                <h1>Revisá tu email</h1>
                <p>
                  Si <strong>{submittedEmail}</strong> es válido, te enviamos un link
                  de verificación. Hacé click en el link para activar tu cuenta y poder
                  iniciar sesión.
                </p>
              </div>
              <div className="field-note" style={{ marginTop: 16 }}>
                ¿No lo ves? Revisá la carpeta de spam. El link expira en 24 horas.
              </div>
              {/* TANDA 1 fix U2 auditoría 2026-06-17: CTA para retipear el
                  email. Trade-off del anti-enum: el user que escribió mal su
                  email NO recibe error explícito — la app dice "Revisá tu
                  email" pero el link nunca llega. Sin este botón el user
                  queda atrapado (no puede loguear porque la cuenta no existe
                  / no está verificada). El click resetea submittedEmail a
                  null y vuelve al form con los datos en blanco. No rompe
                  anti-enum: el user solo se rehace a sí mismo. */}
              <div className="field-note" style={{ marginTop: 12 }}>
                ¿Te equivocaste de email?{' '}
                <button
                  type="button"
                  className="lg-link"
                  onClick={() => {
                    setSubmittedEmail(null);
                    setEmail('');
                    setError('');
                  }}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  Volver y crear cuenta de nuevo
                </button>
              </div>
              <div className="lg-foot" style={{ marginTop: 20 }}>
                <Link to="/" className="lg-link" style={{ textDecoration: 'none' }}>
                  Ir a iniciar sesión →
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="lg-h">
                <h1>Crear tu cuenta</h1>
                <p>Empezá a usar iPro en menos de un minuto.</p>
              </div>

              <form onSubmit={handleSubmit}>
                <div className="field">
                  <label htmlFor="signup-nombre">Tu nombre</label>
                  <div className="iw">
                    <span className="lead"><IconUser /></span>
                    <input
                      id="signup-nombre"
                      type="text"
                      placeholder="Lucas Bruno"
                      autoComplete="name"
                      autoFocus
                      value={nombre}
                      onChange={e => setNombre(e.target.value)}
                      required
                      minLength={1}
                      maxLength={120}
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="signup-email">Email</label>
                  <div className="iw">
                    <span className="lead"><IconMail /></span>
                    <input
                      id="signup-email"
                      type="email"
                      placeholder="tu@empresa.com"
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="signup-password">Contraseña</label>
                  <div className="iw">
                    <span className="lead"><IconLock /></span>
                    <input
                      id="signup-password"
                      type={showPw ? 'text' : 'password'}
                      placeholder="Mínimo 8 caracteres"
                      autoComplete="new-password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      required
                      minLength={8}
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
                  <div className="field-note">
                    Mínimo 8 caracteres. Usá una contraseña que no uses en otros sitios.
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="signup-empresa">Nombre de tu empresa</label>
                  <div className="iw">
                    <span className="lead"><IconBuilding /></span>
                    <input
                      id="signup-empresa"
                      type="text"
                      placeholder="Mi empresa SA"
                      value={tenantNombre}
                      onChange={e => setTenantNombre(e.target.value)}
                      required
                      minLength={2}
                      maxLength={120}
                    />
                  </div>
                </div>

                <button className="login-btn" type="submit" disabled={loading}>
                  {loading ? 'Creando cuenta…' : 'Crear cuenta →'}
                </button>

                {error && (
                  <div className="login-err" role="alert" aria-live="assertive">
                    {error}
                  </div>
                )}
              </form>

              <div className="lg-foot">
                <span>¿Ya tenés cuenta?</span>
                <Link to="/" className="lg-link" style={{ textDecoration: 'none' }}>
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
