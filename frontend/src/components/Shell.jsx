// Shell.jsx — Sidebar + Topbar + Outlet layout shell.
// Adapted from design handoff shell.jsx for Vite + React with react-router-dom.

import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { usePageActions } from '../contexts/PageActionsContext';
import { Icons } from './Icons';
import CommandPalette from './CommandPalette';

// Navigation structure matching the 7+3 design
const NAV_MAIN = [
  { id: 'inicio',     path: '/inicio',     label: 'Inicio',     icon: 'Grid'       },
  { id: 'cotizador',  path: '/cotizador',  label: 'Cotizador',  icon: 'Calculator' },
  { id: 'financiera', path: '/financiera', label: 'Financiera', icon: 'Trend'      },
  { id: 'cajas',      path: '/cajas',      label: 'Cajas',      icon: 'Wallet'     },
  { id: 'envios',     path: '/envios',     label: 'Envíos',     icon: 'Truck'      },
  { id: 'cuentas',    path: '/cuentas',    label: 'Cuentas CC', icon: 'Receipt'    },
  { id: 'usados',     path: '/usados',     label: 'Usados',     icon: 'Phone'      },
];

const NAV_SYS = [
  { id: 'historial', path: '/historial', label: 'Historial', icon: 'Refresh'   },
  { id: 'usuarios',  path: '/usuarios',  label: 'Usuarios',  icon: 'Users'     },
  { id: 'config',    path: '/config',    label: 'Config',    icon: 'Settings'  },
];

// Map path segment → display label for breadcrumb
const SCREEN_LABELS = {
  inicio:     'Inicio',
  cotizador:  'Cotizador',
  financiera: 'Financiera',
  cajas:      'Cajas',
  envios:     'Envíos',
  cuentas:    'Cuentas CC',
  usados:     'Usados',
  historial:  'Historial',
  usuarios:   'Usuarios',
  config:     'Config',
};

function getInitials(name) {
  if (!name) return '??';
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function Sidebar({ badges = {}, open, onClose }) {
  return (
    <>
      {open && (
        <div className="sidebar-overlay" onClick={onClose} />
      )}
      <aside className={'sidebar' + (open ? ' sidebar-open' : '')}>
        <div className="brand">
          <div className="brand-mark">iP</div>
          <div>
            <div className="brand-name">iPro</div>
            <div className="brand-sub">Portal operativo</div>
          </div>
        </div>

        <div className="nav-section">Herramientas</div>
        {NAV_MAIN.map((n) => {
          const I = Icons[n.icon];
          return (
            <NavLink
              key={n.id}
              to={n.path}
              className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
              onClick={onClose}
            >
              <span className="ico">{I && <I size={17} />}</span>
              <span>{n.label}</span>
              {badges[n.id] != null && <span className="badge">{badges[n.id]}</span>}
            </NavLink>
          );
        })}

        <div className="sidebar-spacer" />

        <div className="nav-section">Sistema</div>
        {NAV_SYS.map((n) => {
          const I = Icons[n.icon];
          return (
            <NavLink
              key={n.id}
              to={n.path}
              className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
              onClick={onClose}
            >
              <span className="ico">{I && <I size={17} />}</span>
              <span>{n.label}</span>
            </NavLink>
          );
        })}

        <UserPill />
      </aside>
    </>
  );
}

function UserPill() {
  const { user, logout } = useAuth();
  if (!user) return null;

  const initials = getInitials(user.nombre || user.username);
  const displayName = user.nombre || user.username;
  const roleLabel = user.role === 'admin' ? 'Admin' : 'Operador';

  return (
    <div className="user-pill" style={{ cursor: 'default' }}>
      <div className="avatar">{initials}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="name">{displayName}</div>
        <div className="role">
          {roleLabel} · @{user.username}
        </div>
      </div>
      <button
        className="icon-btn"
        onClick={logout}
        title="Cerrar sesión"
        style={{ flexShrink: 0 }}
      >
        <Icons.Logout size={14} />
      </button>
    </div>
  );
}

function Topbar({ onMenuClick, onSearchClick }) {
  const location = useLocation();
  const { primaryAction } = usePageActions();
  const segment = location.pathname.split('/').filter(Boolean)[0] || 'inicio';
  const label = SCREEN_LABELS[segment] || segment;

  return (
    <div className="topbar">
      <button className="icon-btn hamburger-btn" title="Menu" onClick={onMenuClick}>
        <Icons.Menu size={17} />
      </button>
      <div className="crumbs">
        <span>Portal</span>
        <span className="sep">/</span>
        <span className="cur">{label}</span>
      </div>
      <div className="topbar-spacer" />
      <div className="search" onClick={onSearchClick} style={{ cursor: 'pointer' }}>
        <Icons.Search size={14} />
        <span>Buscar comprobantes, clientes, IMEIs…</span>
        <kbd>⌘K</kbd>
      </div>
      <button className="icon-btn" title="Notificaciones">
        <Icons.Bell size={17} />
      </button>
      <button
        className="icon-btn"
        title={primaryAction?.label || 'Nuevo'}
        onClick={() => primaryAction?.onClick()}
        style={primaryAction ? { color: 'var(--accent)' } : { opacity: 0.35, cursor: 'default' }}
      >
        <Icons.Plus size={17} />
      </button>
    </div>
  );
}

export default function Shell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Global ⌘K / Ctrl+K shortcut to open the command palette
  useEffect(() => {
    function handleKeydown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(prev => !prev);
      }
    }
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, []);

  return (
    <div className="app" data-theme="vault">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="main">
        <Topbar
          onMenuClick={() => setSidebarOpen(s => !s)}
          onSearchClick={() => setPaletteOpen(true)}
        />
        <div className="content">
          <Outlet />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
