// Shell.jsx — Sidebar + Topbar + Outlet layout shell.
// Adapted from design handoff shell.jsx for Vite + React with react-router-dom.

import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useAuth } from '../contexts/AuthContext';
import { usePageActions } from '../contexts/PageActionsContext';
import { Icons } from './Icons';
import CommandPalette from './CommandPalette';

// ── UpdateBanner ─────────────────────────────────────────────────────────────
// Shown when the service worker detects a new version waiting to activate.
// registerType: 'prompt' means the SW waits for the user to confirm before
// taking over — this prevents the app from refreshing mid-use.
function UpdateBanner() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div style={{
      position: 'sticky',
      top: 0,
      zIndex: 50,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '10px 16px',
      background: 'var(--accent)',
      color: 'var(--accent-ink)',
      fontSize: 13,
      fontWeight: 500,
    }}>
      <span>Nueva versión del portal disponible.</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => updateServiceWorker(true)}
          style={{
            background: 'var(--accent-ink)',
            color: 'var(--accent)',
            border: 'none',
            borderRadius: 6,
            padding: '4px 12px',
            fontWeight: 700,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Actualizar ahora
        </button>
        <button
          onClick={() => setNeedRefresh(false)}
          style={{
            background: 'transparent',
            color: 'var(--accent-ink)',
            border: '1px solid var(--accent-ink)',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: 'pointer',
            fontSize: 12,
            opacity: 0.75,
          }}
        >
          Después
        </button>
      </div>
    </div>
  );
}

// Navigation structure — perm: key en user.perms, adminOnly: solo role=admin
// null perm = siempre visible
// `group` agrupa visualmente el menú (separador entre grupos distintos).
const NAV_MAIN = [
  { id: 'inicio',     path: '/inicio',     label: 'Inicio',     icon: 'Grid',       perm: null,          group: 1 },
  { id: 'ventas',     path: '/ventas',     label: 'Ventas',     icon: 'CreditCard', perm: 'ventas',      group: 1 },
  { id: 'cuentas',    path: '/cuentas',    label: 'Venta & Gestión B2B', icon: 'Receipt',    perm: 'cuentas',     group: 1 },
  { id: 'contactos',  path: '/contactos',  label: 'Contactos',  icon: 'Users',      perm: 'contactos',   group: 1 },
  { id: 'cajas',      path: '/cajas',      label: 'Cajas',      icon: 'Wallet',     perm: 'cajas',       group: 2 },
  { id: 'egresos',    path: '/egresos',    label: 'Egresos',    icon: 'ArrowDownRight', perm: 'cajas',   group: 2 },
  { id: 'inventario', path: '/inventario', label: 'Inventario', icon: 'Box',        perm: 'inventario',  group: 2 },
  { id: 'proveedores',path: '/proveedores',label: 'Proveedores',icon: 'Building',   perm: 'proveedores', group: 2 },
  { id: 'financiera', path: '/financiera', label: 'Financiera', icon: 'Trend',      perm: 'financiera',  group: 2 },
  { id: 'cotizador',  path: '/cotizador',  label: 'Cotizador',  icon: 'Calculator', perm: 'cotizador',   group: 3 },
  { id: 'usados',     path: '/usados',     label: 'Usados | Cotizador',            icon: 'Phone',      perm: 'usados',      group: 3 },
  { id: 'envios',     path: '/envios',     label: 'Envíos',     icon: 'Truck',      perm: 'envios',      group: 4 },
  { id: 'proyectos',  path: '/proyectos',  label: 'Proyectos',  icon: 'Calendar',   perm: 'proyectos',   group: 5 },
];

const NAV_SYS = [
  { id: 'historial', path: '/historial', label: 'Historial', icon: 'Refresh',  perm: 'financiera'  },
  { id: 'usuarios',  path: '/usuarios',  label: 'Usuarios',  icon: 'Users',    adminOnly: true      },
  { id: 'config',    path: '/config',    label: 'Config',    icon: 'Settings', perm: 'financiera'  },
];

// Map path segment → display label for breadcrumb
const SCREEN_LABELS = {
  inicio:     'Inicio',
  cotizador:  'Cotizador',
  financiera: 'Financiera',
  cajas:      'Cajas',
  egresos:    'Egresos',
  envios:     'Envíos',
  cuentas:    'Venta & Gestión B2B',
  contactos:  'Contactos',
  proveedores: 'Proveedores',
  usados:     'Usados | Cotizador',
  inventario: 'Inventario',
  proyectos:  'Proyectos',
  ventas:     'Ventas',
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

// Filtra items de nav según los permisos del usuario actual
function useVisibleNav(items) {
  const { user } = useAuth();
  if (!user) return [];
  if (user.role === 'admin') return items; // admin ve todo
  return items.filter(n => {
    if (n.adminOnly) return false;
    if (!n.perm) return true; // siempre visible (ej. Inicio)
    return user.perms?.[n.perm] === true;
  });
}

function Sidebar({ badges = {}, open, onClose }) {
  const visibleMain = useVisibleNav(NAV_MAIN);
  const visibleSys  = useVisibleNav(NAV_SYS);

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
        {visibleMain.map((n, i) => {
          const I = Icons[n.icon];
          // Separador entre grupos (no antes del primer ítem visible)
          const prev = visibleMain[i - 1];
          const divider = prev && prev.group !== n.group;
          return (
            <div key={n.id}>
              {divider && <div className="nav-divider" />}
              <NavLink
                to={n.path}
                className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
                onClick={onClose}
              >
                <span className="ico">{I && <I size={16} />}</span>
                <span>{n.label}</span>
                {badges[n.id] != null && <span className="badge">{badges[n.id]}</span>}
              </NavLink>
            </div>
          );
        })}

        <div className="sidebar-spacer" />

        {visibleSys.length > 0 && (
          <>
            <div className="nav-section">Sistema</div>
            {visibleSys.map((n) => {
              const I = Icons[n.icon];
              return (
                <NavLink
                  key={n.id}
                  to={n.path}
                  className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
                  onClick={onClose}
                >
                  <span className="ico">{I && <I size={16} />}</span>
                  <span>{n.label}</span>
                </NavLink>
              );
            })}
          </>
        )}

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
        onClick={() => primaryAction?.onClick?.()}
        disabled={!primaryAction}
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
        <UpdateBanner />
        <div className="content">
          <Outlet />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
