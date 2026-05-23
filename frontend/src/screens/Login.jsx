import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username.trim().toLowerCase(), password);
    } catch (err) {
      setError(err.message || 'Usuario o contraseña incorrectos');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div id="login-screen" style={{ display: 'flex' }}>
      <div className="login-box">
        <div className="brand">iPro</div>
        <div className="brand-sub">Tech Reseller &amp; Celnyx</div>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>Usuario</label>
            <input
              type="text"
              placeholder="usuario"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Contraseña</label>
            <input
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? 'Ingresando...' : 'Ingresar →'}
          </button>
          {error && <div className="login-err" style={{ display: 'block' }}>{error}</div>}
        </form>
      </div>
    </div>
  );
}
