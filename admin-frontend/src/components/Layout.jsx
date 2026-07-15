// Layout principal: sidebar fijo (2 secciones) + topbar (breadcrumbs +
// search placeholder + bell + plus + user pill). Es el shell que envuelve
// TODAS las rutas autenticadas; el Login renderiza fuera de esto.
//
// Las acciones de la topbar (search, bell, plus) son visuales — se van a
// cablear contra endpoints reales cuando existan. Logout sí funciona,
// porque es la única forma de salir de un estado de sesión roto.

import { useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { Icon, Icons } from './Icons.jsx';
import CreateTenantModal from './modals/CreateTenantModal.jsx';

const NAV = [
  {
    sec: 'Gestión',
    items: [
      { id: 'resumen',     label: 'Resumen',     icon: 'Grid',     path: '/' },
      { id: 'clientes',    label: 'Clientes',    icon: 'Building', path: '/clientes' },
      // #499 (2026-07-01): gestión de co-super-admins (invitar/revocar).
      // Entre Clientes y Planes — pattern "gente" antes de "producto".
      { id: 'equipo',      label: 'Equipo',      icon: 'Users',    path: '/equipo' },
      { id: 'planes',      label: 'Planes',      icon: 'Tag',      path: '/planes' },
    ],
  },
  {
    // 2026-07-15 (task #130): sección "Operación" vuelve al sidebar con
    // Facturación como primer item real. Antes se había eliminado en #450
    // (Facturación/Onboarding/Uso/Soporte eran todas ComingSoon).
    sec: 'Operación',
    items: [
      { id: 'facturacion', label: 'Facturación', icon: 'CreditCard', path: '/facturacion' },
    ],
  },
  {
    // 2026-07-13 CMS Landing Fase 1: editor de contenido del sitio público.
    // Sección separada porque no es "gestión de clientes" — es config de
    // NUESTRA marca (Tecny) que aparece en tecnyapp.com.
    sec: 'Marca',
    items: [
      { id: 'sitio',       label: 'Sitio público', icon: 'Building', path: '/sitio-publico' },
    ],
  },
];

// Mapa flat para derivar el label del breadcrumb desde la ruta. Mantenido
// chico: rutas anidadas (ej. /clientes/:id) se manejan ad-hoc abajo.
const FLAT_NAV = NAV.flatMap((s) => s.items);

function getCrumbLabel(pathname) {
  // /clientes/:id → "Ficha"
  if (/^\/clientes\/[^/]+$/.test(pathname)) return 'Ficha';
  const hit = FLAT_NAV.find((it) =>
    it.path === '/' ? pathname === '/' : pathname.startsWith(it.path)
  );
  return hit?.label || '—';
}

function initialsFromUser(user) {
  const src = user?.username || user?.email || '';
  if (!src) return '?';
  // username puede ser "lucas.bruno" → "LB"; email tomamos antes del @.
  const base = src.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return base
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase() || '?';
}

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // #452: estado del modal "Crear tenant manual" disparado desde el botón
  // "+" del topbar. Vive en Layout para que esté disponible desde cualquier
  // ruta autenticada — el usuario puede invocarlo sin estar en Clientes.
  const [createOpen, setCreateOpen] = useState(false);

  const onLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const displayName = user?.username || user?.email || 'Admin';
  const currentLabel = getCrumbLabel(location.pathname);

  return (
    <div className="app">
      {/* TANDA 6 a11y (audit 2026-06-22): skip link como PRIMER focusable
          de la página. Permite a usuarios de teclado saltarse la sidebar
          completa (8 items + user pill + logout = mucho Tab) y caer
          directo en el contenido. Visually hidden hasta que reciba
          focus por teclado — no ocupa espacio visual normal. WCAG 2.4.1. */}
      <a href="#main-content" className="skip-link">
        Saltar al contenido principal
      </a>
      <aside className="sidebar" aria-label="Navegación principal">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">T</div>
          <div>
            <div className="brand-name">Tecny</div>
            <div className="brand-sub">Back-office</div>
          </div>
        </div>

        {NAV.map((section) => (
          <div key={section.sec}>
            <div className="nav-section">{section.sec}</div>
            {section.items.map((it) => (
              <NavLink
                key={it.id}
                to={it.path}
                end={it.path === '/'}
                className={({ isActive }) =>
                  isActive ? 'nav-item active' : 'nav-item'
                }
              >
                <span className="ico"><Icon name={it.icon} size={16} /></span>
                <span className="label">{it.label}</span>
              </NavLink>
            ))}
          </div>
        ))}

        <div className="sidebar-spacer" />

        {/* #498: el user-pill ahora es un Link a /mi-cuenta. Antes era un
            div puramente decorativo; ahora expone el acceso a la pantalla
            "Mi cuenta" (2FA + password). Mantenemos las mismas clases CSS
            para no cambiar el look, sólo la interactividad (hover/pointer
            los da el navegador por ser un <a>). El aria-label deja claro
            qué pasa al click, útil para screen readers. */}
        <Link
          to="/mi-cuenta"
          className="user-pill"
          title={displayName}
          aria-label={`Mi cuenta — ${displayName}`}
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <div className="avatar" aria-hidden="true">{initialsFromUser(user)}</div>
          <div className="user-meta">
            <div className="user-name">{displayName}</div>
            <div className="user-role">Founder · Admin</div>
          </div>
          <span className="chev"><Icons.ChevronUp size={14} /></span>
        </Link>

        {/*
          Logout explícito y visible: es el "escape" de una sesión rota
          (token expirado pero is_super_admin todavía true en cache, p.ej.).
          Cuando agreguemos menú contextual al user-pill, el botón se va al menú.
        */}
        <button
          type="button"
          className="btn btn-ghost btn-logout"
          onClick={onLogout}
        >
          <span className="ico"><Icons.Logout size={14} /></span>
          <span className="label-txt">Cerrar sesión</span>
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <nav className="crumbs" aria-label="Breadcrumb">
            <span>Tecny Admin</span>
            <span className="sep">/</span>
            <span className="cur">{currentLabel}</span>
          </nav>

          <div className="topbar-spacer" />

          {/* UX-2 fix (audit 2026-06-22): search/bell/plus son placeholders
              futuros (sub-fase no determinada). Antes se renderizaban con
              opacidad full y placeholder atractivo ("Buscar clientes…"),
              el operador los clickeaba esperando que funcionen. Ahora con
              opacity reducida y tooltip "Próximamente" — visualmente queda
              claro que están en wait-state, sin perder el slot del layout
              para cuando se implementen. */}
          <div
            className="search"
            role="search"
            aria-label="Búsqueda global"
            title="Búsqueda global — próximamente"
            style={{ opacity: 0.4, cursor: 'not-allowed' }}
          >
            <span className="ico"><Icons.Search size={14} /></span>
            <input
              type="search"
              placeholder="Próximamente"
              disabled
              aria-disabled="true"
              style={{ cursor: 'not-allowed' }}
            />
            <kbd aria-hidden="true">⌘K</kbd>
          </div>

          <button
            type="button"
            className="icon-btn"
            aria-label="Notificaciones (próximamente)"
            title="Notificaciones — próximamente"
            disabled
            style={{ opacity: 0.4, cursor: 'not-allowed' }}
          >
            <Icons.Bell size={16} />
            <span className="dot" aria-hidden="true" />
          </button>
          {/* #452: botón "+" del topbar abre el modal Crear tenant manual.
              Antes estaba en wait-state ("Próximamente"); ahora dispara el flow
              de onboarding manual desde cualquier ruta del back office. */}
          <button
            type="button"
            className="icon-btn"
            aria-label="Crear tenant manual"
            title="Crear tenant manual"
            onClick={() => setCreateOpen(true)}
          >
            <Icons.Plus size={16} />
          </button>
        </header>

        {/* TANDA 6 a11y (audit 2026-06-22): id="main-content" como target
            del skip-link. tabIndex=-1 para que el focus programático del
            skip funcione (el focus salta acá y la próxima Tab navega el
            contenido). El outline:none evita el ring feo al recibir el
            focus desde un skip. */}
        <div
          className="content"
          id="main-content"
          tabIndex={-1}
          style={{ outline: 'none' }}
        >
          <div className="content-narrow">{children}</div>
        </div>
      </main>

      {/* #452: modal de creación de tenant manual, accesible desde el "+"
          del topbar. Vive a nivel Layout para que esté siempre montable
          (no requiere estar en Clientes ni Resumen). Después de crear,
          navegamos a la ficha del tenant nuevo. */}
      <CreateTenantModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(res) => {
          setCreateOpen(false);
          if (res?.tenant?.id) {
            navigate(`/clientes/${res.tenant.id}`);
          }
        }}
      />
    </div>
  );
}
