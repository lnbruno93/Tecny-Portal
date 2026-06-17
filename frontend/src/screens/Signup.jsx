// Signup público — TANDA 2.2 scaffold (UI a completar fresco).
//
// Flow:
//   1. User llega a /signup (ruta pública, fuera de RequireAuth).
//   2. Completa: nombre, email, password, tenant_nombre (4 campos).
//   3. POST /api/auth/signup → backend devuelve { token, user, tenant,
//      verification_required: true, _verification_token (dev/test only) }.
//   4. AuthContext setea el user con email_verified:false.
//   5. Redirect a /inicio. El Shell muestra banner persistente "Verificá tu
//      email" (componente UnverifiedBanner) hasta que el user clickee el link.
//
// Diseño: mirror del split-screen de Login.jsx — panel marca a la izquierda,
// form a la derecha. Reusar las clases `.lg-*` que ya existen en styles.css
// (todas scopeadas bajo #login-screen, así que renombrar el id container a
// #signup-screen y agregar selectores duplicados para el nuevo id, O
// scopear ambos con una clase común tipo .auth-screen).
//
// TODO TANDA 2.2:
//   - [ ] Visual completo (mirror de Login.jsx con 4 inputs).
//   - [ ] Validación cliente (email format, password strength, tenant nombre min 2 chars).
//   - [ ] Manejo de errores del backend (409 email duplicado → mensaje claro).
//   - [ ] Link "¿Ya tenés cuenta? Logueate" → /login.
//   - [ ] Loading state + disable submit durante request.
//   - [ ] Post-success → useNavigate a /inicio (AuthContext ya maneja el token).

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Signup() {
  const { setAuthFromSignup } = useAuth(); // TODO: agregar este método al context — recibe { token, user } y los setea sin re-fetch
  const navigate = useNavigate();

  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantNombre, setTenantNombre] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          nombre,
          email:         email.trim().toLowerCase(),
          password,
          tenant_nombre: tenantNombre.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'No se pudo crear la cuenta');
        return;
      }
      // Backend devolvió { token, user, tenant, verification_required }.
      // Persistir token + user en AuthContext y redirigir a /inicio.
      // El Shell detecta user.email_verified=false y muestra banner.
      setAuthFromSignup({ token: data.token, user: data.user });
      navigate('/inicio', { replace: true });
    } catch (err) {
      setError('Error de conexión');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div id="signup-screen" className="auth-screen">
      {/* TODO: visual completo. Mirror del split-screen de Login.jsx. */}
      <h1>Crear cuenta</h1>
      <form onSubmit={onSubmit}>
        <label>
          Nombre
          <input value={nombre} onChange={e => setNombre(e.target.value)} required minLength={1} />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
        </label>
        <label>
          Contraseña
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} />
        </label>
        <label>
          Nombre de la empresa
          <input value={tenantNombre} onChange={e => setTenantNombre(e.target.value)} required minLength={2} />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={loading}>
          {loading ? 'Creando...' : 'Crear cuenta'}
        </button>
      </form>
      <p>
        ¿Ya tenés cuenta? <Link to="/login">Iniciar sesión</Link>
      </p>
    </div>
  );
}
