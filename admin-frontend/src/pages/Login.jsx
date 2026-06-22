// Pantalla de Login del admin console. Doble gate cliente+servidor —
// si el server devuelve un user sin flag is_super_admin, NO guardamos
// el token. Eso es lo que evita que un user normal del portal acceda
// al back-office aún teniendo creds válidas.

import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { adminApi } from '../lib/api.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { Btn } from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Para volver a la URL que el user intentó visitar antes del redirect
  // a /login (ProtectedRoute setea location.state.from).
  const from = location.state?.from?.pathname || '/';

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const data = await adminApi.login(username.trim(), password);
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
      // 401 → creds invalidas (mensaje genérico, no enum-leak)
      if (err.status === 401) {
        setError('Usuario o contraseña incorrectos.');
      } else if (err.message) {
        setError(err.message);
      } else {
        setError('No pudimos iniciar sesión. Intentá de nuevo.');
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
          Back-office del SaaS
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
          <div className="stack" style={{ gap: 12 }}>
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

            <Btn
              type="submit"
              kind="primary"
              disabled={busy || !username || !password}
              className="btn-block"
              style={{ width: '100%', marginTop: 4 }}
            >
              {busy ? 'Ingresando…' : 'Ingresar'}
            </Btn>
          </div>
        </form>

        <p
          className="muted tiny"
          style={{ textAlign: 'center', margin: '20px 0 0' }}
        >
          Solo super-admins · accesos auditados
        </p>
      </div>
    </div>
  );
}
