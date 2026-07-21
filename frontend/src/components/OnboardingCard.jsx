import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { onboarding as onboardingApi, auth as authApi } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

/**
 * OnboardingCard — TANDA 1 H3 #323 (audit E2E 2026-06-18).
 *
 * Card sticky en el top de Inicio.jsx que guía al user nuevo (post-signup)
 * por sus primeros 3 pasos: agregar producto, crear contacto, registrar
 * venta. Cada item se tacha automáticamente cuando el user lo completa
 * en el módulo correspondiente.
 *
 * Cuándo se muestra:
 *   - User logueado, GET /api/onboarding/status responde con al menos un
 *     `has_*` en false.
 *   - User NO clickeó "Saltar" (localStorage flag NO seteado).
 *
 * Cuándo desaparece:
 *   - User completa los 3 pasos → status responde todo true → card oculta
 *     automáticamente (sin perdurar — si el user borra todo después, la
 *     card vuelve a aparecer, que es deseable: indica al user que está
 *     en un estado "como nuevo").
 *   - User clickea "Saltar tour" → localStorage `onboarding_dismissed = true`
 *     → no vuelve a aparecer hasta que el user limpie localStorage.
 *
 * Diseño:
 *   - Card padding 20px, fondo accent-soft, border accent, radius 12.
 *   - Header: título + close button (saltar).
 *   - 3 items: check icon + título + breve descripción + ChevronRight.
 *   - Cada item es <Link> al módulo correspondiente.
 *   - Item completado: opacity 0.6 + line-through + check ✓ verde.
 */

// localStorage key — único para no chocar con otros flags del portal.
const DISMISS_KEY = 'onboarding_dismissed_v1';

// Items del checklist. Si cambian, mantener el orden por dificultad
// ascendente (lo más fácil primero, anima al user a continuar).
const ITEMS = [
  {
    key:   'has_productos',
    label: 'Agregá tu primer producto',
    desc:  'Empezá a armar tu inventario',
    href:  '/inventario',
  },
  {
    key:   'has_contactos',
    label: 'Creá tu primer contacto',
    desc:  'Clientes y proveedores con los que operás',
    href:  '/contactos',
  },
  {
    key:   'has_ventas',
    label: 'Registrá tu primera venta',
    desc:  'Con el producto y el cliente listos, vendé',
    href:  '/ventas',
  },
];

const IconCheckCircle = ({ done }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={done ? '#10b981' : 'var(--text-muted)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    {done && <path d="M8 12.5l3 3 5.5-6.5" />}
  </svg>
);

const IconChevronRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 18l6-6-6-6" />
  </svg>
);

const IconX = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

export default function OnboardingCard() {
  // 2026-06-25 ONB-7 (audit pre-live): incluimos el step "Verificá tu email"
  // como step 0 (visible solo si el user todavía no verificó). Antes el
  // OnboardingCard listaba 3 pasos pero ninguno era email — y el bloqueo
  // blando del backend impedía completarlos: el user clickeaba "Agregá tu
  // primer producto" → submit → 403 "Verificá tu email…" que no se
  // relacionaba con el checklist. Confusión doble. Ahora el step 0 hace el
  // flow unificado y permite "Reenviar link" inline.
  const { user } = useAuth();
  const emailVerified = !!user?.email_verified;
  const [status, setStatus] = useState(null);  // null = loading, {} = loaded
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === '1'
  );
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState('');

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    onboardingApi.status()
      .then(s => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatus({ error: true }); });
    return () => { cancelled = true; };
  }, [dismissed]);

  function handleDismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  async function handleResendVerification() {
    setResending(true);
    setResendMsg('');
    try {
      await authApi.resendVerification();
      // Incluimos el email al que se reenvió — antes solo decía "Email
      // reenviado" sin confirmar destinatario. Si el user signupeó con
      // typo en el mail, ahora puede notarlo (ver UnverifiedBanner).
      setResendMsg(user?.email ? `Reenviado a ${user.email}` : 'Email reenviado.');
    } catch (err) {
      setResendMsg(err.message || 'No se pudo reenviar. Intentá en unos minutos.');
    } finally {
      setResending(false);
    }
  }

  // Don't render si:
  //   - Dismissed (user clickeó saltar).
  //   - Aún loading (status === null).
  //   - Error fetcheando — fallar silencioso, el user no necesita ver eso.
  //   - Los 4 items ya están listos (email verified + 3 pasos del CRUD).
  if (dismissed) return null;
  if (!status) return null;
  if (status.error) return null;

  const allDone = emailVerified && ITEMS.every(item => status[item.key]);
  if (allDone) return null;

  return (
    <div
      role="region"
      aria-label="Primeros pasos"
      style={{
        background: 'rgba(14, 165, 233, 0.06)',
        border: '1px solid rgba(14, 165, 233, 0.18)',
        borderRadius: 12,
        padding: '20px 24px',
        marginBottom: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <div>
          <h3 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>
            ¡Bienvenido a Tecny!
          </h3>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
            Configuremos lo básico para que empieces a operar. 3 pasos rápidos:
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Saltar tour"
          title="Saltar tour"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            padding: 6,
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <IconX />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {/* 2026-06-25 ONB-7: step 0 "Verificá tu email" — visible solo si el
            user todavía no verificó. NO es un Link (no hay pantalla destino),
            sino una row con CTA inline "Reenviar". */}
        {!emailVerified && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              borderRadius: 8,
            }}
          >
            <IconCheckCircle done={false} />
            <div className="u-flex-1">
              <div className="u-fs-14-fw-600">
                Verificá tu email
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
                {resendMsg
                  ? resendMsg
                  : 'Hasta que verifiques, no podés crear ni editar datos. Revisá tu casilla — el link vence en 24 h.'}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleResendVerification}
              disabled={resending}
              style={{ flexShrink: 0 }}
            >
              {resending ? 'Reenviando…' : 'Reenviar link'}
            </button>
          </div>
        )}
        {ITEMS.map(item => {
          const done = !!status[item.key];
          return (
            <Link
              key={item.key}
              to={item.href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                borderRadius: 8,
                textDecoration: 'none',
                color: 'var(--text)',
                opacity: done ? 0.5 : 1,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(14, 165, 233, 0.08)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <IconCheckCircle done={done} />
              <div className="u-flex-1">
                <div style={{
                  fontWeight: 600,
                  fontSize: 14,
                  textDecoration: done ? 'line-through' : 'none',
                }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
                  {item.desc}
                </div>
              </div>
              {!done && (
                <div style={{ color: 'var(--text-muted)' }}>
                  <IconChevronRight />
                </div>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
