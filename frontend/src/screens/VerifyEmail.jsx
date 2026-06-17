// VerifyEmail — TANDA 2.2 scaffold (UI a completar fresco).
//
// Flow:
//   1. User clickea el link del email → llega a /verify-email?token=<hex>.
//   2. Esta pantalla extrae `token` del query string al montar.
//   3. POST /api/auth/verify-email { token } automáticamente (no requiere
//      acción del user — solo abrir el link).
//   4. Muestra estado:
//        - loading: "Verificando..."
//        - success: "✓ Email verificado. Ya podés crear ventas, etc."
//        - error 400 (token inválido / expirado): mensaje claro + CTA
//          "Pedir un link nuevo" → si está logueado, llama
//          /api/auth/resend-verification. Si no, → /login.
//
// Diseño: pantalla simple, centered card. NO replica el split-screen de
// Login/Signup — es transient (~5 segundos en pantalla).
//
// TODO TANDA 2.2:
//   - [ ] Visual completo (card centrada con icono ✓/✗).
//   - [ ] Si user está logueado (AuthContext), refresh del user para que
//         email_verified pase a true en memoria (UnverifiedBanner desaparece).
//   - [ ] Manejo de "token ya usado" vs "token expirado" — backend devuelve
//         400 sin distinguir; tratamos ambos como "expirado" con CTA resend.

import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth(); // TODO: agregar este método al context — re-fetch GET /api/auth/me y actualiza email_verified
  const token = params.get('token');

  const [status, setStatus] = useState('loading'); // 'loading' | 'success' | 'error'
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setErrorMsg('Link inválido (falta token).');
      return;
    }
    async function verify() {
      try {
        const res = await fetch('/api/auth/verify-email', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token }),
        });
        const data = await res.json();
        if (!res.ok) {
          setStatus('error');
          setErrorMsg(data.error || 'Token inválido o expirado.');
          return;
        }
        setStatus('success');
        // Si el user está logueado, refresh para que email_verified pase a true.
        if (refreshUser) await refreshUser();
        // Redirect a /inicio después de 2s.
        setTimeout(() => navigate('/inicio', { replace: true }), 2000);
      } catch (e) {
        setStatus('error');
        setErrorMsg('Error de conexión.');
      }
    }
    verify();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div id="verify-email-screen" className="auth-screen">
      {/* TODO: visual completo (card centrada). */}
      {status === 'loading' && <p>Verificando tu email...</p>}
      {status === 'success' && (
        <div>
          <h2>✓ Email verificado</h2>
          <p>Ya podés usar tu cuenta sin restricciones. Redirigiendo...</p>
        </div>
      )}
      {status === 'error' && (
        <div>
          <h2>✗ No se pudo verificar</h2>
          <p>{errorMsg}</p>
          <p>
            <Link to="/login">Iniciá sesión</Link> y pedí un nuevo email de verificación desde el banner del dashboard.
          </p>
        </div>
      )}
    </div>
  );
}
