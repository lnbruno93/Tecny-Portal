import { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import { auth as authApi } from '../lib/api';
import {
  validatePasswordPolicy,
  MIN_PASSWORD_LENGTH,
  PASSWORD_POLICY_HINT,
} from '../lib/passwordPolicy';

// CAPTCHA: site key del widget. Lee de Netlify env var VITE_HCAPTCHA_SITE_KEY
// (build-time inline). Default: la test sitekey oficial de hCaptcha (siempre
// passes) para dev local + tests. Si la real falta en prod (misconfig), el
// widget aún renderiza pero los tokens del test sitekey son rechazados por
// el backend con la secret real → user ve "verificación inválida".
const HCAPTCHA_SITE_KEY = import.meta.env.VITE_HCAPTCHA_SITE_KEY
  || '10000000-ffff-ffff-ffff-000000000001';

// Signup público (TANDA 2.2 Fase B — visual polish).
//
// Mirror del split-screen de Login.jsx — reusa todas las clases .lg-* y
// .auth-screen (CSS compartido scopeado bajo .auth-screen). Cambios respecto
// del Login:
//   - 4 inputs en vez de 2: nombre, email, password (con ojito), empresa.
//   - No hay flow de 2FA (signup nuevo, no hay user todavía).
//   - Footer: link a / (login) en vez del "Conexión segura".
//   - Heading: "Crear cuenta" en vez de "Ingresá a tu portal".
//   - Eyebrow brand panel: "Cuenta nueva" en vez de "Portal operativo".
//
// TANDA 2.7 anti-enum: la response del backend es **idéntica** para emails
// nuevos vs. duplicados (200 + `{ verification_required: true }`, sin
// token/user/tenant). El frontend NO auto-loguea — muestra una pantalla de
// "revisá tu email" después del submit. El usuario debe clickear el link de
// verificación para luego poder hacer login normalmente. Patrón estándar de
// SaaS (verify-before-use) y único forma de evitar enumeración.

// Iconos inline — duplico los mismos que usa Login.jsx para no acoplar
// los componentes a un Icons.jsx compartido por solo 2 pantallas.
const IconUser = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20a8 8 0 0 1 16 0" />
  </svg>
);
const IconMail = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 7 9-7" />
  </svg>
);
const IconLock = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 1 1 8 0v3" />
  </svg>
);
const IconBuilding = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="3" width="16" height="18" rx="1.5" />
    <path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" />
  </svg>
);
const IconShield = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z" />
  </svg>
);
const IconKey = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 1 1 8 0v3" />
  </svg>
);
const IconRefresh = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);
const IconEye = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const IconEyeOff = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 4.2A9.5 9.5 0 0 1 12 4c6.5 0 10 7 10 7a16 16 0 0 1-3 3.8M6.6 6.6A16 16 0 0 0 2 11s3.5 7 10 7a9.3 9.3 0 0 0 3.6-.7" />
  </svg>
);

export default function Signup() {
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantNombre, setTenantNombre] = useState('');
  // 2026-06-29 Multi-país F4 (#470): selector país AR/UY. Default 'AR' por ser
  // el mercado mayoritario hoy. Determina la moneda local (ARS o UYU) que se
  // siembra en cajas + alertas TC default + matriz de monedas habilitadas para
  // el tenant nuevo. Decisión inmutable post-signup desde la UI (ver design
  // doc sección 6.4) — si Lucas necesita cambiarlo es script manual.
  const [pais, setPais] = useState('AR');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // TANDA 2.7 anti-enum: en lugar de navegar a /inicio post-success (lo que
  // requería auto-login), mostramos pantalla "revisá tu email". El email
  // sometido se guarda en `submittedEmail` para personalizar el mensaje.
  const [submittedEmail, setSubmittedEmail] = useState(null);
  // TANDA 5 fix U3 auditoría 2026-06-17: el backend devuelve
  // `verification_token_ttl_hours` en la response — antes era hardcoded
  // "24 horas" en el copy, lo que mentía si el backend ajustaba TTL.
  // Default 24 por si el backend (legacy) no manda el field.
  const [tokenTtlHours, setTokenTtlHours] = useState(24);
  // 2026-06-18 #322 TANDA 1 H2: error inline del field password (policy
  // backend: min 8 + letra + número). Sin esto, user que escribe "12345678"
  // ve genérico "No se pudo crear la cuenta" sin saber qué corregir.
  const [pwError, setPwError] = useState('');

  // CAPTCHA: el widget hCaptcha en modo "99.9% passive" resuelve invisible
  // para users legítimos — el token llega via onVerify sin friction. Solo
  // sospechosos ven challenge visual. Si el user es flaggeado y NO completa
  // el challenge, captchaToken queda null y el submit se bloquea client-side.
  const [captchaToken, setCaptchaToken] = useState(null);
  const captchaRef = useRef(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setPwError('');

    // Client-side password policy — espejo del backend (lib/passwordPolicy.js).
    // Sin esto, el user que escribe "12345678" o "abcdefgh" ve genérico "No se
    // pudo crear la cuenta" porque el backend lo rechaza con error de Zod —
    // mala UX. Ahora le decimos qué corregir antes del round-trip.
    const pwIssue = validatePasswordPolicy(password);
    if (pwIssue) {
      setPwError(pwIssue);
      return;
    }

    setLoading(true);
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const data = await authApi.signup({
        nombre: nombre.trim(),
        email: normalizedEmail,
        password,
        tenant_nombre: tenantNombre.trim(),
        // Multi-país F4 (#470): el backend persiste tenant.pais con este
        // valor y seedea cajas + alertas TC según corresponda (AR=ARS+1400,
        // UY=UYU+40). Si lo omitiéramos Zod aplicaría default 'AR'.
        pais,
        hcaptcha_response: captchaToken || undefined,
      });
      // TANDA 2.7: backend response idéntica para email nuevo vs. duplicado
      // (anti-enum). El user no se auto-loguea — debe verificar email primero.
      // Mostramos pantalla "revisá tu email" sin distinguir los dos casos.
      setSubmittedEmail(normalizedEmail);
      if (data && data.verification_token_ttl_hours) {
        setTokenTtlHours(data.verification_token_ttl_hours);
      }
    } catch (err) {
      setError(err.message || 'No se pudo crear la cuenta.');
      // El token hCaptcha es single-use. Si el submit falla por cualquier
      // motivo, reseteamos para que el siguiente intento genere uno nuevo.
      setCaptchaToken(null);
      if (captchaRef.current) captchaRef.current.resetCaptcha();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div id="signup-screen" className="auth-screen">
      {/* Panel marca (izquierda) — mismo que Login pero eyebrow distinto */}
      <aside className="lg-brand">
        <div className="lg-top">
          <div className="lg-mark">T</div>
          <div>
            <div className="lg-name">Tecny</div>
          </div>
        </div>
        <div className="lg-mid">
          <div className="lg-eyebrow"><span className="d" /> Cuenta nueva</div>
          <h2 className="lg-headline">
            Todo tu negocio,<br />
            <span className="hl">en una sola pantalla.</span>
          </h2>
          <p className="lg-tagline">
            Cotizaciones, comprobantes, cuentas corrientes, envíos y caja — para
            el equipo que mueve el negocio todos los días.
          </p>
        </div>
        <div className="lg-chips">
          <span className="lg-chip"><IconShield /> Datos cifrados</span>
          <span className="lg-chip"><IconKey /> Acceso por permisos</span>
          <span className="lg-chip"><IconRefresh /> Backups diarios</span>
        </div>
      </aside>

      {/* Form (derecha) */}
      <main className="lg-form">
        <div className="login-box">
          <div className="lg-mobile">
            <div className="lg-mark">T</div>
            <div>
              <div className="lg-name">Tecny</div>
            </div>
          </div>

          {submittedEmail ? (
            // TANDA 2.7: pantalla "revisá tu email". Mensaje idéntico
            // independientemente de si el email era nuevo o ya estaba registrado
            // (anti-enum). No revelamos el resultado del lookup en backend.
            <>
              <div className="lg-h">
                <h1>Revisá tu email</h1>
                <p>
                  Si{' '}
                  {/* TANDA 2 fix U4 auditoría 2026-06-17: word-break para
                      emails largos en mobile (≤375px). Sin esto el card
                      desborda el viewport. */}
                  <strong style={{ wordBreak: 'break-all' }}>{submittedEmail}</strong>{' '}
                  es válido, te enviamos un link de verificación. Hacé click en el
                  link para activar tu cuenta y poder iniciar sesión.
                </p>
              </div>
              <div className="field-note u-mt-16">
                ¿No lo ves? Revisá la carpeta de spam. El link expira en{' '}
                {tokenTtlHours} {tokenTtlHours === 1 ? 'hora' : 'horas'}.
              </div>
              {/* TANDA 1 fix U2 auditoría 2026-06-17: CTA para retipear el
                  email. Trade-off del anti-enum: el user que escribió mal su
                  email NO recibe error explícito — la app dice "Revisá tu
                  email" pero el link nunca llega. Sin este botón el user
                  queda atrapado (no puede loguear porque la cuenta no existe
                  / no está verificada). El click resetea submittedEmail a
                  null y vuelve al form con los datos en blanco. No rompe
                  anti-enum: el user solo se rehace a sí mismo. */}
              <div className="field-note u-mt-12">
                ¿Te equivocaste de email?{' '}
                <button
                  type="button"
                  className="lg-link"
                  onClick={() => {
                    setSubmittedEmail(null);
                    setEmail('');
                    setError('');
                  }}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  Volver y crear cuenta de nuevo
                </button>
              </div>
              <div className="lg-foot" style={{ marginTop: 20 }}>
                <Link to="/" className="lg-link u-text-none">
                  Ir a iniciar sesión →
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="lg-h">
                <h1>Crear tu cuenta</h1>
                <p>Empezá a usar Tecny en menos de un minuto.</p>
              </div>

              <form onSubmit={handleSubmit}>
                <div className="field">
                  <label htmlFor="signup-nombre">Tu nombre <span className="u-color-neg">*</span></label>
                  <div className="iw">
                    <span className="lead"><IconUser /></span>
                    <input
                      id="signup-nombre"
                      type="text"
                      placeholder="Nombre y apellido"
                      autoComplete="name"
                      autoFocus
                      value={nombre}
                      onChange={e => setNombre(e.target.value)}
                      required
                      minLength={1}
                      maxLength={120}
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="signup-email">Email <span className="u-color-neg">*</span></label>
                  <div className="iw">
                    <span className="lead"><IconMail /></span>
                    <input
                      id="signup-email"
                      type="email"
                      placeholder="tu@empresa.com"
                      autoComplete="email"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="signup-password">Contraseña <span className="u-color-neg">*</span></label>
                  <div className="iw">
                    <span className="lead"><IconLock /></span>
                    <input
                      id="signup-password"
                      type={showPw ? 'text' : 'password'}
                      placeholder={PASSWORD_POLICY_HINT}
                      autoComplete="new-password"
                      value={password}
                      onChange={e => {
                        setPassword(e.target.value);
                        // Limpiar error inline cuando el user empieza a corregir,
                        // así no queda rojo mientras escribe.
                        if (pwError) setPwError('');
                      }}
                      required
                      minLength={MIN_PASSWORD_LENGTH}
                      aria-invalid={!!pwError}
                    />
                    <button
                      type="button"
                      className="pw-toggle"
                      onClick={() => setShowPw(s => !s)}
                      aria-label={showPw ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    >
                      {showPw ? <IconEyeOff /> : <IconEye />}
                    </button>
                  </div>
                  {pwError ? (
                    <div className="field-note u-color-neg" role="alert">
                      {pwError}
                    </div>
                  ) : (
                    <div className="field-note">
                      {PASSWORD_POLICY_HINT} Usá una contraseña que no uses en otros sitios.
                    </div>
                  )}
                </div>

                {/* Multi-país F4 (#470): selector AR/UY antes del campo
                    "Nombre de empresa" — el orden mental es "qué país operás
                    + cómo se llama tu empresa". Segmented control con dos
                    botones grandes (ARIA radiogroup) para que sea claro que
                    es una elección excluyente y no se confunda con un
                    checkbox de "agregar país adicional". El default visual
                    es AR (mayoría de tenants). El copy debajo explica las
                    monedas operativas resultantes — info que el user no tiene
                    por qué saber, así no se siente atrapado en una decisión
                    abstracta. */}
                <div className="field">
                  <label className="field-label" id="pais-label">País</label>
                  {/* Usa el patrón `.seg` + `button.on` del design system
                      (styles.css L740) — antes había inline styles que pisaban
                      las clases y rompían el contraste en dark theme (bg blanco
                      sobre fondo oscuro). Ahora deja al CSS hacer su trabajo:
                      surface contenedor + surface-3 + shadow-sm para el activo,
                      text-muted → text para inactive→active. Solo overrides:
                      `flex:1` para repartir el ancho 50/50 (signup tiene 2
                      opciones full-width, no es un filtro compacto). */}
                  <div
                    className="seg"
                    role="radiogroup"
                    aria-labelledby="pais-label"
                    style={{ display: 'flex', width: '100%' }}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={pais === 'AR'}
                      className={pais === 'AR' ? 'on' : ''}
                      onClick={() => setPais('AR')}
                      disabled={loading}
                      style={{ flex: 1, height: 36, fontSize: 14 }}
                    >
                      🇦🇷 Argentina
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={pais === 'UY'}
                      className={pais === 'UY' ? 'on' : ''}
                      onClick={() => setPais('UY')}
                      disabled={loading}
                      style={{ flex: 1, height: 36, fontSize: 14 }}
                    >
                      🇺🇾 Uruguay
                    </button>
                  </div>
                  <div className="field-note">
                    {pais === 'UY'
                      ? 'Vas a operar en UYU. También podés vender/comprar en USD y USDT.'
                      : 'Vas a operar en ARS. También podés vender/comprar en USD y USDT.'}
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="signup-empresa">Nombre de tu empresa <span className="u-color-neg">*</span></label>
                  <div className="iw">
                    <span className="lead"><IconBuilding /></span>
                    <input
                      id="signup-empresa"
                      type="text"
                      placeholder="Mi empresa SA"
                      value={tenantNombre}
                      onChange={e => setTenantNombre(e.target.value)}
                      required
                      minLength={2}
                      maxLength={120}
                    />
                  </div>
                </div>

                {/* hCaptcha widget. En modo "99.9% passive" (config en
                    hCaptcha dashboard) es invisible para users legítimos —
                    onVerify dispara con el token sin friction. Solo
                    sospechosos ven challenge. theme="light" coincide con
                    el split-screen. size="invisible" significa que el badge
                    es discreto (no hay checkbox visible). */}
                <div style={{ margin: '12px 0', display: 'flex', justifyContent: 'center' }}>
                  <HCaptcha
                    ref={captchaRef}
                    sitekey={HCAPTCHA_SITE_KEY}
                    onVerify={(token) => setCaptchaToken(token)}
                    onExpire={() => setCaptchaToken(null)}
                    onError={() => setCaptchaToken(null)}
                    theme="light"
                  />
                </div>

                <button className="login-btn" type="submit" disabled={loading}>
                  {loading ? 'Creando cuenta…' : 'Crear cuenta →'}
                </button>

                {error && (
                  <div className="login-err" role="alert" aria-live="assertive">
                    {error}
                  </div>
                )}
              </form>

              <div className="lg-foot">
                <span>¿Ya tenés cuenta?</span>
                <Link to="/" className="lg-link u-text-none">
                  Iniciar sesión
                </Link>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
