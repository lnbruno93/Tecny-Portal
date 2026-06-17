// UnverifiedBanner — TANDA 2.2 scaffold (UI a completar fresco).
//
// Banner persistente que se muestra dentro del Shell cuando el user logueado
// tiene email_verified=false. CTA: "Reenviar email de verificación".
//
// Cuándo aparece:
//   - user existe (logueado).
//   - user.email_verified === false.
//   - NO se muestra en /verify-email (el user ya está procesando).
//   - NO se muestra en /signup ni /login (rutas públicas, sin shell).
//
// Cuándo desaparece:
//   - User clickea el link del email → /verify-email lo marca verified +
//     refreshUser() → email_verified pasa a true → banner se oculta.
//   - Logout.
//
// Comportamiento del CTA "Reenviar":
//   - POST /api/auth/resend-verification (auth-required).
//   - Backend devuelve { ok: true } y manda el email nuevo.
//   - Mostrar toast "Email reenviado, revisá tu inbox".
//   - Rate limit 3/hora — si el user spammea, backend devuelve 429.
//
// TODO TANDA 2.2:
//   - [ ] Visual: banner amarillo/naranja con icono ⚠, texto + 2 botones
//         (Reenviar email | Cerrar [solo oculta esta sesión, vuelve next page]).
//   - [ ] Loading + disabled durante request de resend.
//   - [ ] Toast de "Reenviado" / "Demasiados intentos" (429).
//   - [ ] Mostrar el email al que se envía: "Te enviamos un email a <user.email>".
//   - [ ] Posicionamiento: top del layout, full-width, sticky (debajo del header).

import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function UnverifiedBanner() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  // Sólo mostrar si user existe y no verificó.
  if (!user || user.email_verified) return null;

  async function resend() {
    setLoading(true);
    setMessage('');
    try {
      const res = await fetch('/api/auth/resend-verification', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          // TODO: AuthContext debería injectar Authorization header automático
          // en su `api.fetch()` wrapper. Si no existe, usar `localStorage.getItem('token')`.
        },
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || 'No se pudo reenviar el email.');
        return;
      }
      setMessage('Email reenviado. Revisá tu bandeja de entrada.');
    } catch (e) {
      setMessage('Error de conexión.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="unverified-banner" role="alert">
      {/* TODO: visual completo. Color amarillo/warning, icono ⚠, layout horizontal. */}
      <span>
        Verificá tu email <strong>{user.email}</strong> para poder crear o modificar datos.
      </span>
      <button onClick={resend} disabled={loading}>
        {loading ? 'Enviando...' : 'Reenviar email'}
      </button>
      {message && <span className="banner-msg">{message}</span>}
    </div>
  );
}
