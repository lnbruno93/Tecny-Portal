// UnverifiedBanner — TANDA 2.2 Fase B.
//
// Banner sticky en el top del Shell para users con email_verified=false.
// CTA: "Reenviar email de verificación" (rate-limited 3/hora server-side).
//
// Cuándo aparece:
//   - user existe (logueado).
//   - user.email_verified === false.
//
// Cuándo desaparece:
//   - User clickea el link del email → /verify-email lo marca verified +
//     refreshUser() → email_verified pasa a true → banner se oculta.
//   - User clickea "Cerrar" → se oculta esta sesión (vuelve al refresh
//     del browser).
//   - Logout.
//
// Comportamiento del CTA "Reenviar":
//   - POST /api/auth/resend-verification (auth-required).
//   - Backend devuelve { ok: true } y manda el email nuevo.
//   - Rate limit 3/hora — si el user spammea, backend devuelve 429 y
//     mostramos el mensaje del backend.

import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { auth as authApi } from '../lib/api';

const IconWarn = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

export default function UnverifiedBanner() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [dismissed, setDismissed] = useState(false);

  // Sólo mostrar si user existe, no está verificado, y no fue dismisseado.
  if (!user || user.email_verified || dismissed) return null;

  async function resend() {
    setLoading(true);
    setMessage('');
    try {
      await authApi.resendVerification();
      setMessage('Email reenviado. Revisá tu bandeja de entrada.');
    } catch (err) {
      // Backend devuelve 429 con mensaje específico si hay rate limit;
      // el wrapper api() ya lo propaga.
      setMessage(err.message || 'No se pudo reenviar. Intentá en unos minutos.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="unverified-banner" role="alert">
      <span className="unverified-banner-icon"><IconWarn /></span>
      <span className="unverified-banner-text">
        Verificá tu email <strong>{user.email}</strong> para poder crear o
        modificar datos.
      </span>
      <span className="unverified-banner-actions">
        <button
          className="unverified-banner-btn"
          onClick={resend}
          disabled={loading}
        >
          {loading ? 'Enviando…' : 'Reenviar email'}
        </button>
        <button
          className="unverified-banner-btn u-unverified-close"
          onClick={() => setDismissed(true)}
          aria-label="Ocultar banner (vuelve a aparecer al refrescar la página)"
        >
          Cerrar
        </button>
        {message && <span className="unverified-banner-msg">{message}</span>}
      </span>
    </div>
  );
}
