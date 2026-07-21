// Pantalla de Login del admin console. Doble gate cliente+servidor —
// si el server devuelve un user sin flag is_super_admin, NO guardamos
// el token. Eso es lo que evita que un user normal del portal acceda
// al back-office aún teniendo creds válidas.

import { useState, useRef } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import { adminApi } from '../lib/api.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { Btn } from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';

// 2026-07-13 hotfix: hCaptcha invisible en el admin login. Mismo pattern
// que frontend/src/screens/Login.jsx del portal. Sin esto, con
// HCAPTCHA_ENABLED=true en el backend, TODOS los logins de super-admin
// rebotan con "Verificación inválida" (bug reportado por Lucas 2026-07-13).
// Default: test sitekey oficial de hCaptcha (siempre pasa, dev/local).
// En prod la env VITE_HCAPTCHA_SITE_KEY ya está seteada en Netlify con la
// sitekey real de Tecny (misma que el portal).
const HCAPTCHA_SITE_KEY = import.meta.env.VITE_HCAPTCHA_SITE_KEY
  || '10000000-ffff-ffff-ffff-000000000001';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 2026-07-04 #510: los super-admins tienen 2FA obligatorio (TOTP). Flujo:
  //   1. Envía email+password → backend responde 401 { twofa_required: true }
  //      si el user tiene 2FA activo y la password fue correcta.
  //   2. Frontend detecta el flag y muestra el input de 6 dígitos.
  //   3. Re-envía email+password+code → backend valida el TOTP y devuelve token.
  //
  // El anti-enumeration del backend hace que password inválida devuelva
  // TAMBIÉN 401 pero SIN twofa_required, así que el discriminador es el flag,
  // no el status code.
  const [twofaRequired, setTwofaRequired] = useState(false);
  const [code, setCode] = useState('');
  // 2026-07-13 hotfix hCaptcha invisible. Token del widget — se pasa al
  // backend en step 1 del login. En step 2 (2FA) NO se re-envía (token
  // single-use).
  const [captchaToken, setCaptchaToken] = useState(null);
  const captchaRef = useRef(null);

  // Para volver a la URL que el user intentó visitar antes del redirect
  // a /login (ProtectedRoute setea location.state.from).
  const from = location.state?.from?.pathname || '/';

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      // Si el user ya pasó la 1ra pasada (twofaRequired=true), mandamos code.
      // Si no, `code` viene vacío y el backend valida solo password.
      const data = await adminApi.login(
        username.trim(),
        password,
        twofaRequired ? code.trim() : undefined,
        // hCaptcha token — solo en step 1. En step 2 (2FA) el backend skippea
        // el gate captcha, y además el token es single-use (re-enviarlo tira
        // "duplicate" en hCaptcha).
        twofaRequired ? undefined : (captchaToken || undefined),
      );
      // Gate cliente: el endpoint /api/auth/login es público (portal), y
      // devuelve token+user para CUALQUIER user válido. Acá filtramos por
      // el flag de super-admin ANTES de guardar nada. Si lo dejamos pasar,
      // el revalidate en AuthContext lo desloguea — pero hay una ventana
      // de UX rara, mejor cortar acá.
      //
      // S-7 fix (audit 2026-06-22): distinguir tres casos:
      //   1. Respuesta inválida (no hay data.user) → bug del backend o proxy raro.
      //      Mostrar "Respuesta inválida del servidor" en vez del genérico
      //      "no sos super-admin" — el operador legítimo no se asusta pensando
      //      que perdió permisos.
      //   2. data.user OK pero sin is_super_admin → no es super-admin (legit).
      //   3. is_super_admin=true → seguir.
      if (!data?.token || !data?.user) {
        setError('Respuesta inválida del servidor. Probá de nuevo o avisá al admin.');
        return;
      }
      if (!data.user.is_super_admin) {
        setError('Esta consola es solo para super-admins. Pedile acceso al owner si lo necesitás.');
        return;
      }
      // Gate servidor también validado por adminApi.me() en cada navegación
      // (via AuthContext.useEffect). El token solo persiste si pasa ambos.
      login(data.token, data.user);
      navigate(from, { replace: true });
    } catch (err) {
      // 401 con twofa_required=true → password OK, pero el user tiene 2FA activo.
      // No es "credenciales incorrectas": mostramos el input de código.
      // (En 2da pasada, si el código es inválido el backend responde
      // 401 { code: 'INVALID_2FA_CODE' } SIN twofa_required, así que no
      // entramos acá y caemos al else de abajo con mensaje específico.)
      if (
        err.status === 401 &&
        err.responseBody?.twofa_required &&
        !twofaRequired
      ) {
        setTwofaRequired(true);
        setError('');
        return;
      }
      // 401 → creds invalidas o código 2FA inválido. Mensaje genérico
      // para no filtrar cuál de las dos cosas falló (defense in depth).
      if (err.status === 401) {
        if (twofaRequired) {
          setError('Código de verificación inválido o vencido. Probá el actual.');
        } else {
          setError('Usuario o contraseña incorrectos.');
        }
      } else if (err.message) {
        setError(err.message);
      } else {
        setError('No pudimos iniciar sesión. Intentá de nuevo.');
      }
      // 2026-07-13: token hCaptcha es single-use. Reset después de cualquier
      // error para que el próximo submit intente uno nuevo. El widget en modo
      // passive re-emite automáticamente.
      setCaptchaToken(null);
      if (captchaRef.current) {
        try { captchaRef.current.resetCaptcha(); } catch (_) { /* no-op */ }
      }
    } finally {
      setBusy(false);
    }
  };

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
          Tecny Admin
        </h1>
        <p
          className="muted"
          style={{ fontSize: 13, textAlign: 'center', margin: '0 0 24px' }}
        >
          {twofaRequired ? 'Verificación en dos pasos' : 'Back-office del SaaS'}
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

        <form onSubmit={onSubmit} noValidate>
          <div className="stack u-gap-12">
            {!twofaRequired && (
              <>
                <div className="input-group">
                  <span className="addon addon-l">
                    <Icons.Users size={14} />
                  </span>
                  <input
                    className="input with-addon-l"
                    type="text"
                    placeholder="Usuario o email"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    autoFocus
                    required
                    aria-label="Usuario o email"
                  />
                </div>
                <div className="input-group">
                  <span className="addon addon-l">
                    <Icons.Lock size={14} />
                  </span>
                  <input
                    className="input with-addon-l"
                    type="password"
                    placeholder="Contraseña"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    aria-label="Contraseña"
                  />
                </div>
              </>
            )}

            {twofaRequired && (
              <>
                <p
                  className="muted"
                  style={{ fontSize: 13, textAlign: 'center', margin: '0 0 4px' }}
                >
                  Ingresá el código de 6 dígitos de tu app de autenticación
                  (Google Authenticator, Authy, etc).
                </p>
                <div className="input-group">
                  <span className="addon addon-l">
                    <Icons.Lock size={14} />
                  </span>
                  <input
                    className="input with-addon-l"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    placeholder="000000"
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    aria-label="Código de 6 dígitos"
                    style={{
                      letterSpacing: '0.4em',
                      textAlign: 'center',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  />
                </div>
              </>
            )}

            {/* 2026-07-13 hotfix hCaptcha invisible. Solo en step 1 (antes de
                pedir 2FA) — en step 2 el token ya fue usado y el backend
                skippea el gate captcha si viene `code`. Widget "invisible":
                rara vez muestra desafío para humanos legítimos, pero bloquea
                bots automatizados. */}
            {!twofaRequired && (
              <div style={{ margin: '4px 0', display: 'flex', justifyContent: 'center' }}>
                <HCaptcha
                  ref={captchaRef}
                  sitekey={HCAPTCHA_SITE_KEY}
                  onVerify={(token) => setCaptchaToken(token)}
                  onExpire={() => setCaptchaToken(null)}
                  onError={() => setCaptchaToken(null)}
                  theme="dark"
                />
              </div>
            )}

            <Btn
              type="submit"
              kind="primary"
              disabled={
                busy ||
                (twofaRequired
                  ? code.length !== 6
                  : !username || !password)
              }
              className="btn-block u-w-100-mt-4"
            >
              {busy
                ? 'Ingresando…'
                : twofaRequired
                ? 'Verificar código'
                : 'Ingresar'}
            </Btn>

            {twofaRequired && (
              <button
                type="button"
                onClick={() => {
                  setTwofaRequired(false);
                  setCode('');
                  setError('');
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--muted)',
                  fontSize: 12,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 4,
                }}
              >
                Usar otra cuenta
              </button>
            )}
          </div>
        </form>

        {/* 2026-07-04: link a "Olvidé mi contraseña". Solo aparece en el
            paso de creds — durante el prompt 2FA (twofaRequired=true) no tiene
            sentido, el user ya autenticó su password y necesita el TOTP, no
            resetear. Si perdió acceso al 2FA hay que ir por otro flow (soporte). */}
        {!twofaRequired && (
          <p
            className="muted tiny"
            style={{ textAlign: 'center', margin: '16px 0 0' }}
          >
            <Link
              to="/forgot-password"
              style={{ color: 'var(--muted)', textDecoration: 'underline' }}
            >
              ¿Olvidaste tu contraseña?
            </Link>
          </p>
        )}

        <p
          className="muted tiny u-text-center-m-20-0-0"
        >
          Solo super-admins · accesos auditados
        </p>
      </div>
    </div>
  );
}
