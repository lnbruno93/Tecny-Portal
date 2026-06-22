// Layout principal: sidebar fijo (2 secciones) + topbar (breadcrumbs +
// search placeholder + bell + plus + user pill). Es el shell que envuelve
// TODAS las rutas autenticadas; el Login renderiza fuera de esto.
//
// Las acciones de la topbar (search, bell, plus) son visuales — se van a
// cablear contra endpoints reales cuando existan. Logout sí funciona,
// porque es la única forma de salir de un estado de sesión roto.

import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { Icon, Icons } from './Icons.jsx';

const NAV = [
  {
    sec: 'Gestión',
    items: [
      { id: 'resumen',  label: 'Resumen',  icon: 'Grid',     path: '/' },
      { id: 'clientes', label: 'Clientes', icon: 'Building', path: '/clientes' },
      { id: 'planes',   label: 'Planes',   icon: 'Tag',      path: '/planes' },
    ],
  },
  {
    sec: 'Operación',
    items: [
      { id: 'facturacion', label: 'Facturación', icon: 'CreditCard', path: '/facturacion' },
      { id: 'onboarding',  label: 'Onboarding',  icon: 'Bolt',       path: '/onboarding' },
      { id: 'uso',         label: 'Uso',         icon: 'TrendUp',    path: '/uso' },
      { id: 'soporte',     label: 'Soporte',     icon: 'Bell',       path: '/soporte' },
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

  const onLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const displayName = user?.username || user?.email || 'Admin';
  const currentLabel = getCrumbLabel(location.pathname);

  return (
    <div className="app">
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

        <div className="user-pill" title={displayName}>
          <div className="avatar" aria-hidden="true">{initialsFromUser(user)}</div>
          <div className="user-meta">
            <div className="user-name">{displayName}</div>
            <div className="user-role">Founder · Admin</div>
          </div>
          <span className="chev"><Icons.ChevronUp size={14} /></span>
        </div>

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

          {/* Search placeholder — se cablea al endpoint global cuando exista. */}
          <div className="search" role="search" aria-label="Búsqueda global">
            <span className="ico"><Icons.Search size={14} /></span>
            <input
              type="search"
              placeholder="Buscar clientes, facturas, tickets…"
              disabled
              aria-disabled="true"
            />
            <kbd>⌘K</kbd>
          </div>

          <button
            type="button"
            className="icon-btn"
            aria-label="Notificaciones"
            title="Notificaciones (próximamente)"
            disabled
          >
            <Icons.Bell size={16} />
            <span className="dot" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Crear"
            title="Crear (próximamente)"
            disabled
          >
            <Icons.Plus size={16} />
          </button>
        </header>

        <div className="content">
          <div className="content-narrow">{children}</div>
        </div>
      </main>
    </div>
  );
}
