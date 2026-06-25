import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// Login screen — rediseño split-screen (2026-06-06).
//
// Estructura visual:
//   · Panel marca a la izquierda: logo + headline + chips de seguridad.
//   · Form a la derecha: input usuario + input password (con ojito) + botón.
//
// El panel marca se oculta en viewports < 900px (CSS, ver styles.css), y en
// mobile el form muestra arriba un mini logo (.lg-mobile).
//
// Flow de 2FA opcional preservado del Login viejo:
//   - Step 1: username + password.
//   - Si el backend responde { twofa_required: true }, escondemos los inputs
//     iniciales y mostramos un input de código (6 dígitos o recovery code).
//   - Step 2: re-submit con el código. Si OK, el AuthContext setea el user
//     y el shell redirige al home automáticamente.
//
// Importante: el código se envía al MISMO endpoint /api/auth/login junto con
// password — no separamos en 2 requests porque eso requeriría mantener el
// password en algún lado (state, cookie temporal). Pasarlo dos veces es lo
// más simple y seguro.
//
// Todas las clases visuales nuevas (.lg-*) están scopeadas bajo .auth-screen
// vía CSS para NO afectar al resto de la app. La clase es compartida con
// Signup.jsx y VerifyEmail.jsx (TANDA 2.2 Fase B). .login-box / .login-btn /
// .login-err son exclusivas de auth screens (verificado: no se usan en ningún
// otro archivo del repo).

// Iconos inline (16-17px, currentColor) — se mantienen acá para no inflar
// el componente Icons.jsx con uso de un solo lugar. svg paths del handoff.
const IconUser = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20a8 8 0 0 1 16 0" />
  </svg>
);
const IconLock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 1 1 8 0v3" />
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
const IconCheck = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5 10 17.5 20 7" />
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

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [code, setCode] = useState('');
  const [twofaRequired, setTwofaRequired] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // "Recordarme" — UI por ahora. El token vive en localStorage siempre.
  // Cuando agreguemos sesión efímera (sessionStorage si !remember), wireamos.
  const [remember, setRemember] = useState(true);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // TANDA 2.5 fix HIGH auditoría 2026-06-17 (Solidez H1): solo lowercaseamos
      // si el input parece email (contiene '@'). Emails son case-insensitive y
      // el backend los normaliza con LOWER(email) en login. Para usernames, el
      // lowercase rompe users pre-existentes con mixed-case (ej. "Lucas",
      // "Admin") porque la columna users.username es case-sensitive.
      const id = username.trim();
      const identifier = id.includes('@') ? id.toLowerCase() : id;
      const result = await login(
        identifier,
        password,
        twofaRequired ? code.trim() : undefined,
      );
      if (result.twofa_required) {
        setTwofaRequired(true);
      }
      // Si vino { user }, el AuthContext ya seteó user y el shell redirige.
    } catch (err) {
      if (twofaRequired) {
        // Error en step 2: probable código incorrecto. Limpiamos el input pero
        // mantenemos username/password (no obligamos al user a re-tipearlos).
        setError(err.message || 'Código incorrecto.');
        setCode('');
      } else {
        setError(err.message || 'Usuario o contraseña incorrectos');
      }
    } finally {
      setLoading(false);
    }
  };

  // Si el user quiere volver al form de password (ej. tipeó mal el username
  // y se dio cuenta en el step 2). U5 auditoría 2026-06: también reseteamos
  // password — si volvió porque la password tenía algo mal, dejar el campo
  // prellenado lo lleva a reintentar el mismo password mal sin darse cuenta.
  // Vaciar es más explícito + reduce el tiempo que la password está en memoria.
  const handleVolver = () => {
    setTwofaRequired(false);
    setCode('');
    setPassword('');
    setError('');
  };

  return (
    <div id="login-screen" className="auth-screen">
      {/* Panel marca (izquierda) — oculto en mobile < 900px */}
      <aside className="lg-brand">
        <div className="lg-top">
          <div className="lg-mark">T</div>
          <div>
            <div className="lg-name">Tecny</div>
          </div>
        </div>
        <div className="lg-mid">
          <div className="lg-eyebrow"><span className="d" /> Portal operativo</div>
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
          {/* Logo mobile (visible solo < 900px) */}
          <div className="lg-mobile">
            <div className="lg-mark">T</div>
            <div>
              <div className="lg-name">Tecny</div>
            </div>
          </div>

          <div className="lg-h">
            <h1>{twofaRequired ? 'Verificación en 2 pasos' : 'Ingresá a tu portal'}</h1>
            <p>
              {twofaRequired
                ? 'Ingresá el código de tu app autenticadora para continuar.'
                : 'Bienvenido de nuevo. Usá tus credenciales para continuar.'}
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            {!twofaRequired && (
              <>
                <div className="field">
                  <label htmlFor="login-username">Usuario o email</label>
                  <div className="iw">
                    <span className="lead"><IconUser /></span>
                    <input
                      id="login-username"
                      type="text"
                      // TANDA 2.3: aceptamos username o email. autoComplete='username'
                      // sigue siendo correcto — los password managers entienden el
                      // término genéricamente (usan el field para autofill tanto
                      // de username como de email).
                      placeholder="usuario o tu@email.com"
                      autoComplete="username"
                      autoFocus
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                      value={username}
                      onChange={e => setUsername(e.target.value)}
                    />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="login-password">Contraseña</label>
                  <div className="iw">
                    <span className="lead"><IconLock /></span>
                    <input
                      id="login-password"
                      type={showPw ? 'text' : 'password'}
                      placeholder="••••••••"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={e => setPassword(e.target.value)}
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
                </div>

                {/* Recordarme + forgot password — del handoff 2026-06-17.
                    Recordarme: visual por ahora (token siempre persiste en localStorage).
                    Forgot password: TANDA 0 #321 (2026-06-18) ya tiene flow
                    auto-servicio — link a /forgot-password en lugar del hint
                    legacy. */}
                <div className="lg-row">
                  <label className="lg-remember">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={e => setRemember(e.target.checked)}
                    />
                    <span>Recordarme</span>
                  </label>
                  <Link to="/forgot-password" className="lg-link">
                    ¿Olvidaste tu contraseña?
                  </Link>
                </div>
              </>
            )}

            {twofaRequired && (
              <div className="field">
                <label htmlFor="login-2fa-code">Código de verificación</label>
                <div className="iw">
                  <span className="lead"><IconKey /></span>
                  <input
                    id="login-2fa-code"
                    type="text"
                    inputMode="numeric"
                    placeholder="6 dígitos o recovery code"
                    autoComplete="one-time-code"
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={code}
                    onChange={e => setCode(e.target.value)}
                  />
                </div>
                <div className="field-note">
                  Ingresá el código de 6 dígitos de tu app autenticadora (Google
                  Authenticator, Authy, etc.) o uno de tus recovery codes.
                </div>
              </div>
            )}

            <button className="login-btn" type="submit" disabled={loading}>
              {loading
                ? (twofaRequired ? 'Verificando…' : 'Ingresando…')
                : (twofaRequired ? 'Verificar →' : 'Ingresar →')}
            </button>

            {twofaRequired && !loading && (
              <button type="button" className="lg-link-btn" onClick={handleVolver}>
                ← Volver al login
              </button>
            )}

            {/* role="alert" + aria-live="assertive" para que lectores anuncien
                el error inmediatamente al aparecer (a11y) */}
            {error && (
              <div className="login-err" role="alert" aria-live="assertive">
                {error}
              </div>
            )}
          </form>

          {/* 2026-06-25 ONB-4 (audit pre-live): link "Crear cuenta" para users
              que llegan a /login directo (ej. link de invitación) y no tienen
              cuenta todavía. Antes solo se llegaba a /signup vía Landing — si
              alguien compartía /login al invitar, el invitado quedaba atrapado. */}
          {!twofaRequired && (
            <div className="lg-signup-row" style={{ marginTop: 18, textAlign: 'center', fontSize: 13 }}>
              <span className="muted">¿No tenés cuenta? </span>
              <Link to="/signup" className="lg-link">Crear cuenta nueva</Link>
            </div>
          )}

          <div className="lg-foot">
            <IconCheck />
            Conexión segura · tu sesión queda protegida
          </div>
        </div>
      </main>
    </div>
  );
}
