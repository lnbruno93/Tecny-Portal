// ExpiredBanner — TANDA 4.C billing pre-live 2026-06-25.
//
// Banner sticky en el top del Shell para tenants vencidos o por vencer.
//
// 3 estados visuales según user.tenant.paid_until + user.tenant.is_active:
//
//   1. Tenant suspended (is_active=false con suspended_at)
//      → Banner rojo permanente, sin CTA — solo "Contactá soporte".
//   2. Tenant expirado (paid_until < hoy, is_active=false)
//      → Banner rojo permanente con mailto:hola@tecnyapp.com.
//      → El usuario puede LEER todo pero los writes devuelven 402 → toast.
//   3. Tenant por vencer (paid_until ∈ [hoy, hoy+7d], is_active=true)
//      → Banner amarillo, dismissable.
//      → Permite operar normalmente, solo recordatorio para que pague.
//
// No aparece si:
//   - paid_until=null (grandfathered, sin enforcement).
//   - paid_until > hoy+7d (lejos del vencimiento).
//   - Usuario super-admin (ve su admin panel, no necesita este banner).
//
// Diseño: mismo shape que UnverifiedBanner — sticky top, dismissable
// solo el estado warning (el rojo permanece hasta resolver).

import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

const IconWarn = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

// Días restantes hasta paid_until. Negativo si ya pasó. null si paid_until
// es null/inválido.
//
// IMPORTANTE: `new Date('YYYY-MM-DD')` parsea como UTC midnight (no local).
// Comparado con `new Date()` que es local, da off-by-one en TZ negativas (AR).
// Parseamos manual para tratar el string como FECHA LOCAL (sin TZ shift).
function parseLocalDate(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return null;
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function daysUntil(isoDate) {
  const target = parseLocalDate(isoDate);
  if (!target) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((target - today) / 86400000);
}

function fmtDate(iso) {
  const d = parseLocalDate(iso);
  if (!d) return '';
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export default function ExpiredBanner() {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  // No mostrar si:
  // - No hay user logueado
  // - No hay tenant info (fallback /me sin tenant)
  // - Super-admin (tiene su propia consola)
  if (!user || !user.tenant || user.is_super_admin) return null;

  const { paid_until, is_active, suspended_at } = user.tenant;

  // Caso 1: Suspended (admin manual). Banner rojo permanente, sin CTA pago.
  if (suspended_at) {
    return (
      <div className="expired-banner expired-banner--neg" role="alert">
        <span className="expired-banner-icon"><IconWarn /></span>
        <span className="expired-banner-text">
          <strong>Tu cuenta está suspendida.</strong>
          {' '}Contactá soporte en{' '}
          <a href="mailto:hola@tecnyapp.com">hola@tecnyapp.com</a>
          {' '}para reactivarla.
        </span>
      </div>
    );
  }

  // Caso 2: Expirado por paid_until (is_active=false sin suspended).
  if (!is_active) {
    return (
      <div className="expired-banner expired-banner--neg" role="alert">
        <span className="expired-banner-icon"><IconWarn /></span>
        <span className="expired-banner-text">
          <strong>Tu cuenta venció</strong>
          {paid_until && <> el {fmtDate(paid_until)}</>}
          . Podés seguir viendo tus datos pero no crear ni modificar.
          {' '}Renová escribiéndonos a{' '}
          <a href="mailto:hola@tecnyapp.com?subject=Renovaci%C3%B3n%20Tecny%20Portal">
            hola@tecnyapp.com
          </a>.
        </span>
      </div>
    );
  }

  // Caso 3: Por vencer (paid_until ∈ [hoy, hoy+7d]). Warning amarillo dismissable.
  const days = daysUntil(paid_until);
  if (days != null && days >= 0 && days <= 7 && !dismissed) {
    return (
      <div className="expired-banner expired-banner--warn" role="status">
        <span className="expired-banner-icon"><IconWarn /></span>
        <span className="expired-banner-text">
          Tu cuenta vence{' '}
          {days === 0 ? <strong>hoy</strong>
            : days === 1 ? <strong>mañana</strong>
            : <>en <strong>{days} días</strong></>}
          {' '}({fmtDate(paid_until)}).
          {' '}Para renovar escribinos a{' '}
          <a href="mailto:hola@tecnyapp.com?subject=Renovaci%C3%B3n%20Tecny%20Portal">
            hola@tecnyapp.com
          </a>.
        </span>
        <span className="expired-banner-actions">
          <button
            className="expired-banner-btn-ghost"
            onClick={() => setDismissed(true)}
            aria-label="Ocultar banner (vuelve al refrescar la página)"
          >
            Cerrar
          </button>
        </span>
      </div>
    );
  }

  return null;
}
