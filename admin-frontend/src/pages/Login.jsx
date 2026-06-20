import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { adminApi } from '../lib/api.js';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const from = location.state?.from?.pathname || '/tenants';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await adminApi.login(username.trim(), password);
      // El backend devuelve { token, user }. Si el user NO es super-admin,
      // NO guardamos sesión y mostramos un error claro. La validación dura
      // está server-side (todos los endpoints /api/super-admin/* requieren
      // el flag), pero atajamos acá para no engañar al user con un "login OK"
      // que después rebota en cada request.
      if (!data?.user?.is_super_admin) {
        setError(
          'Esta app es solo para super-admins. ' +
          'Los usuarios normales acceden por tecnyapp.com.'
        );
        setLoading(false);
        return;
      }
      login(data.token, data.user);
      navigate(from, { replace: true });
    } catch (err) {
      // Mensajes amigables para los códigos más comunes. Cualquier otra cosa
      // muestra el mensaje del backend o un genérico.
      if (err.status === 423) {
        setError('Cuenta bloqueada temporalmente por intentos fallidos. Esperá unos minutos.');
      } else if (err.status === 429) {
        setError('Demasiados intentos. Esperá unos minutos antes de reintentar.');
      } else if (err.status === 401) {
        setError('Usuario o contraseña incorrectos.');
      } else {
        setError(err.message || 'No se pudo iniciar sesión.');
      }
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-mark" aria-hidden="true">T</div>
          <div>
            <div className="brand-name">Tecny</div>
            <div className="brand-sub">Admin Console</div>
          </div>
        </div>

        <h1 className="login-title">Acceso super-admin</h1>
        <p className="login-sub">
          Esta consola es solo para administradores del SaaS. Los usuarios de tenants
          ingresan por <span className="mono">tecnyapp.com</span>.
        </p>

        <form onSubmit={handleSubmit} className="login-form" noValidate>
          <label className="field">
            <span className="field-label">Usuario o email</span>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              disabled={loading}
            />
          </label>

          <label className="field">
            <span className="field-label">Contraseña</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
            />
          </label>

          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-block"
            disabled={loading || !username.trim() || !password}
          >
            {loading ? 'Ingresando…' : 'Ingresar'}
          </button>
        </form>
      </div>
    </div>
  );
}
