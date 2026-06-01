import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

// Login screen con flow de 2FA opcional:
//   - Step 1: username + password.
//   - Si el backend responde { twofa_required: true }, escondemos el form
//     inicial y mostramos un input de código (6 dígitos o recovery code).
//   - Step 2: re-submit con el código. Si OK, el AuthContext setea el user
//     y el shell redirige al home automáticamente.
//
// Importante: el código se envía al MISMO endpoint /api/auth/login junto con
// password — no separamos en 2 requests porque eso requeriría mantener el
// password en algún lado (state, cookie temporal). Pasarlo dos veces es lo
// más simple y seguro (el password sigue siendo el mismo, no hay re-prompt).
export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [twofaRequired, setTwofaRequired] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(
        username.trim().toLowerCase(),
        password,
        twofaRequired ? code.trim() : undefined,
      );
      if (result.twofa_required) {
        // Primer intento, el user tiene 2FA — pasamos a step 2.
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
  // y se dio cuenta en el step 2), permitirle resetear.
  const handleVolver = () => {
    setTwofaRequired(false);
    setCode('');
    setError('');
  };

  return (
    <div id="login-screen" style={{ display: 'flex' }}>
      <div className="login-box">
        <div className="brand">iPro</div>
        <div className="brand-sub">Tech Reseller &amp; Celnyx</div>
        <form onSubmit={handleSubmit}>
          {!twofaRequired && (
            <>
              <div className="field">
                <label htmlFor="login-username">Usuario</label>
                <input
                  id="login-username"
                  type="text"
                  placeholder="usuario"
                  autoComplete="username"
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="login-password">Contraseña</label>
                <input
                  id="login-password"
                  type="password"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                />
              </div>
            </>
          )}

          {twofaRequired && (
            <>
              <div className="field">
                <label htmlFor="login-2fa-code">Código de verificación</label>
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
                <div className="muted tiny" style={{ marginTop: 6, lineHeight: 1.4 }}>
                  Ingresá el código de 6 dígitos de tu app autenticadora (Google
                  Authenticator, Authy, etc.) o uno de tus recovery codes.
                </div>
              </div>
            </>
          )}

          <button className="login-btn" type="submit" disabled={loading}>
            {loading
              ? (twofaRequired ? 'Verificando…' : 'Ingresando...')
              : (twofaRequired ? 'Verificar →' : 'Ingresar →')}
          </button>

          {twofaRequired && !loading && (
            <button
              type="button"
              onClick={handleVolver}
              style={{
                background: 'none', border: 'none', color: 'var(--text-muted)',
                cursor: 'pointer', marginTop: 12, padding: 4, width: '100%',
                textAlign: 'center', fontSize: 13,
              }}
            >
              ← Volver al login
            </button>
          )}

          {/* role="alert" + aria-live="assertive" para que lectores de pantalla anuncien
              el error inmediatamente al aparecer (a11y) */}
          {error && (
            <div className="login-err" role="alert" aria-live="assertive" style={{ display: 'block' }}>
              {error}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
