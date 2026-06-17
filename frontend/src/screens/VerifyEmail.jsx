import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { auth as authApi } from '../lib/api';

// VerifyEmail — TANDA 2.2 Fase B (visual polish).
//
// Diseño: card centrada (NO split-screen — es transient, ~5 segundos en
// pantalla normalmente). Comparte la clase .auth-screen para heredar
// background y tipografía consistentes con Login/Signup, pero usa
// .auth-card específico para el layout centrado.
//
// Flow:
//   1. User clickea link del email → /verify-email?token=<hex>
//   2. useEffect extrae token, POST /api/auth/verify-email automático.
//   3. Estados visuales:
//        - loading: spinner + "Verificando tu email…"
//        - success: ícono ✓ verde + "Listo, ya estás verificado" + redirect 2s
//        - error: ícono ✗ rojo + mensaje + CTA "Volver al login"
//   4. Si user está logueado, refreshUser() para que email_verified pase a
//      true en memoria (UnverifiedBanner del Shell desaparece).

// Iconos — locales, no inflar Icons.jsx por uso de 1 pantalla.
const IconCheckCircle = () => (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M8 12.5l3 3 5.5-6.5" />
  </svg>
);
const IconXCircle = () => (
  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </svg>
);
const IconSpinner = () => (
  // SVG spinner — animado vía CSS @keyframes auth-spin (ver styles.css).
  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" className="auth-spinner">
    <path d="M12 3a9 9 0 1 1-6.36 2.64" />
  </svg>
);

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const token = params.get('token');

  // Status posibles:
  //   'loading'      → verificando el token contra el backend.
  //   'success'      → token válido + consumido, email recién verificado.
  //   'already'      → token ya consumido (segundo click del mismo link); el
  //                    email YA está verificado — tratamos como éxito amistoso.
  //   'error'        → token inválido o expirado.
  const [status, setStatus] = useState('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setErrorMsg('El link no incluye token. Revisá el email que te enviamos.');
      return;
    }
    async function verify() {
      try {
        await authApi.verifyEmail(token);
        setStatus('success');
        // Refresh /me si hay sesión activa (no-op silencioso si no).
        await refreshUser();
        // Redirect a / después de 2.5s — AuthGuard decide si va a Shell o Login.
        setTimeout(() => navigate('/', { replace: true }), 2500);
      } catch (err) {
        // El api wrapper adjunta el body parseado en err.responseBody (ver api.js).
        // Backend devuelve reason ∈ {'invalid','already_used','expired'} para
        // que el frontend personalice la UX. UX TANDA 2.2 Fase B.
        const reason = err.responseBody?.reason;
        if (reason === 'already_used') {
          // Caso típico: el user clickea 2 veces el mismo link. El email YA
          // está verificado, no hay error real — solo redirigimos.
          setStatus('already');
          setTimeout(() => navigate('/', { replace: true }), 2500);
          return;
        }
        setStatus('error');
        setErrorMsg(err.message || 'Token inválido o expirado.');
      }
    }
    verify();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div id="verify-email-screen" className="auth-screen auth-screen--center">
      <div className="auth-card" role="status" aria-live="polite">
        {status === 'loading' && (
          <>
            <div className="auth-card-icon auth-card-icon--neutral">
              <IconSpinner />
            </div>
            <h1>Verificando tu email…</h1>
            <p>Un segundo. Estamos confirmando que sos vos.</p>
          </>
        )}
        {status === 'success' && (
          <>
            <div className="auth-card-icon auth-card-icon--ok">
              <IconCheckCircle />
            </div>
            <h1>¡Listo! Email verificado.</h1>
            <p>
              Ya podés crear ventas, comprobantes y todo lo demás.
              Te llevamos al portal…
            </p>
          </>
        )}
        {status === 'already' && (
          <>
            <div className="auth-card-icon auth-card-icon--ok">
              <IconCheckCircle />
            </div>
            <h1>Este email ya estaba verificado</h1>
            <p>
              No hace falta hacer nada más. Iniciá sesión y entrá al portal.
              Te llevamos…
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="auth-card-icon auth-card-icon--err">
              <IconXCircle />
            </div>
            <h1>No se pudo verificar</h1>
            <p>{errorMsg}</p>
            <p className="auth-card-cta">
              <Link to="/">Iniciá sesión</Link> y pedí un email nuevo desde el
              banner del dashboard.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
