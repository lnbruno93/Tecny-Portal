// AcceptSuperAdminInvite — landing pública del invitado (#499).
//
// El invitado llega desde el email a /aceptar-invitacion?token=X.
// Flow:
//   1. Al mount: publicInvite.verify(token). Si OK, muestra form password.
//      Si falla (404 ambiguo), muestra error friendly + CTA "pedir de nuevo".
//   2. User completa password + confirm. Validamos policy cliente + match.
//   3. Submit → publicInvite.accept(token, password). Devuelve JWT + user.
//   4. saveToken(res.token) + navigate a /mi-cuenta?tab=seguridad. El guard
//      S-25 va a bloquear el back office hasta que active 2FA — Mi cuenta
//      es donde puede hacerlo.
//
// Design: reusa el look del Login (card centrado sobre bg neutro).

import { useEffect, useId, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { publicInvite, saveToken } from '../lib/api.js';
import { Btn } from '../components/primitives/index.jsx';
import { Icons } from '../components/Icons.jsx';
import {
  PASSWORD_POLICY_HINT,
  validatePasswordPolicy,
} from '../lib/passwordPolicy.js';

// Estados internos del flow. Explícitos porque UI cambia bastante:
//   'verifying' → skeleton mientras chequeamos el token
//   'invalid'   → token no válido/expirado/revocado/aceptado → mensaje amigable
//   'ready'     → token OK → form de password
//   'accepting' → submit en curso
//   'done'      → post-accept, redirigiendo
const STEPS = {
  VERIFYING: 'verifying',
  INVALID:   'invalid',
  READY:     'ready',
  ACCEPTING: 'accepting',
  DONE:      'done',
};

export default function AcceptSuperAdminInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const token = searchParams.get('token') || '';

  const [step, setStep] = useState(STEPS.VERIFYING);
  const [info, setInfo] = useState(null); // { email, nombre, invited_by_username }
  const [pw, setPw] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [error, setError] = useState('');

  const pwId = useId();
  const pwConfirmId = useId();

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setStep(STEPS.INVALID);
      return;
    }
    publicInvite.verify(token)
      .then((res) => {
        if (cancelled) return;
        setInfo(res);
        setStep(STEPS.READY);
      })
      .catch(() => {
        if (cancelled) return;
        setStep(STEPS.INVALID);
      });
    return () => { cancelled = true; };
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (step === STEPS.ACCEPTING) return;

    // Validaciones cliente. La policy la reusamos del helper compartido
    // — mismo mensaje user-friendly que el signup del portal.
    const policyErr = validatePasswordPolicy(pw);
    if (policyErr) {
      setError(policyErr);
      return;
    }
    if (pw !== pwConfirm) {
      setError('Las contraseñas no coinciden.');
      return;
    }

    setStep(STEPS.ACCEPTING);
    setError('');
    try {
      const res = await publicInvite.accept(token, pw);
      if (!res?.token) {
        setError('Respuesta inválida del servidor. Intentá de nuevo.');
        setStep(STEPS.READY);
        return;
      }
      saveToken(res.token);
      setStep(STEPS.DONE);
      // Redirect a Mi cuenta → tab Seguridad para que active 2FA. El guard
      // S-25 va a bloquear /api/super-admin/* hasta que 2FA esté activa,
      // así que empujarlo directo a la pantalla donde puede activarla.
      // replace:true evita que "atrás" vuelva a este URL con token consumido.
      navigate('/mi-cuenta?tab=seguridad', { replace: true });
    } catch (err) {
      setError(err?.message || 'No pudimos aceptar la invitación.');
      setStep(STEPS.READY);
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
          maxWidth: 440,
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

        {step === STEPS.VERIFYING && (
          <>
            <h1 style={{ textAlign: 'center', fontSize: 20, margin: '0 0 8px' }}>
              Verificando invitación…
            </h1>
            <p className="muted" style={{ textAlign: 'center', fontSize: 13, margin: 0 }}>
              Un momento.
            </p>
          </>
        )}

        {step === STEPS.INVALID && (
          <>
            <h1 style={{ textAlign: 'center', fontSize: 22, margin: '0 0 8px' }}>
              Invitación no válida
            </h1>
            <p className="muted" style={{ textAlign: 'center', fontSize: 14, margin: '0 0 20px' }}>
              El link expiró, fue revocado o ya fue usado.
            </p>
            <p className="muted tiny" style={{ textAlign: 'center', margin: 0 }}>
              Pedile a la persona que te invitó una invitación nueva.
            </p>
          </>
        )}

        {step === STEPS.DONE && (
          <>
            <h1 style={{ textAlign: 'center', fontSize: 20, margin: '0 0 8px' }}>
              Redirigiendo…
            </h1>
          </>
        )}

        {(step === STEPS.READY || step === STEPS.ACCEPTING) && info && (
          <>
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
              Aceptá tu invitación
            </h1>
            <p
              className="muted"
              style={{ fontSize: 13, textAlign: 'center', margin: '0 0 20px' }}
            >
              {info.invited_by_username
                ? <>@{info.invited_by_username} te invitó a ser admin de Tecny.</>
                : <>Te invitaron a ser admin de Tecny.</>
              }
            </p>

            <p className="muted tiny" style={{ marginBottom: 16 }}>
              Como admin vas a poder ver el estado de los clientes, gestionar
              planes y ayudar en soporte. Elegí una contraseña para activar tu
              cuenta como <strong>{info.email}</strong>.
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
                }}
              >
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate>
              <div className="stack" style={{ gap: 12 }}>
                <div>
                  <label className="form-label" htmlFor={pwId}>Contraseña</label>
                  <div className="input-group">
                    <span className="addon addon-l">
                      <Icons.Lock size={14} />
                    </span>
                    <input
                      id={pwId}
                      className="input with-addon-l"
                      type="password"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      autoComplete="new-password"
                      required
                      disabled={step === STEPS.ACCEPTING}
                      aria-label="Contraseña"
                    />
                  </div>
                  <div className="muted tiny" style={{ marginTop: 4 }}>
                    {PASSWORD_POLICY_HINT}
                  </div>
                </div>

                <div>
                  <label className="form-label" htmlFor={pwConfirmId}>Confirmar contraseña</label>
                  <div className="input-group">
                    <span className="addon addon-l">
                      <Icons.Lock size={14} />
                    </span>
                    <input
                      id={pwConfirmId}
                      className="input with-addon-l"
                      type="password"
                      value={pwConfirm}
                      onChange={(e) => setPwConfirm(e.target.value)}
                      autoComplete="new-password"
                      required
                      disabled={step === STEPS.ACCEPTING}
                      aria-label="Confirmar contraseña"
                    />
                  </div>
                </div>

                <Btn
                  type="submit"
                  kind="primary"
                  disabled={step === STEPS.ACCEPTING || !pw || !pwConfirm}
                  style={{ width: '100%', marginTop: 4 }}
                >
                  {step === STEPS.ACCEPTING ? 'Creando cuenta…' : 'Crear cuenta y entrar'}
                </Btn>

                <p className="muted tiny" style={{ textAlign: 'center', margin: '8px 0 0' }}>
                  Al crear tu cuenta te vamos a pedir que actives 2FA — es
                  obligatorio para el back office.
                </p>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
