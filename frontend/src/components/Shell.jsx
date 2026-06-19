// Shell.jsx — Sidebar + Topbar + Outlet layout shell.
// Adapted from design handoff shell.jsx for Vite + React with react-router-dom.

import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { usePageActions } from '../contexts/PageActionsContext';
import { Icons } from './Icons';
import CommandPalette from './CommandPalette';
import UnverifiedBanner from './UnverifiedBanner';
import ChangePasswordModal from './ChangePasswordModal';
import { alertas as alertasApi } from '../lib/api';

// ── UpdateBanner ─────────────────────────────────────────────────────────────
// Shown when the service worker detects a new version waiting to activate.
//
// vite.config.js usa registerType: 'autoUpdate' + skipWaiting/clientsClaim
// para que el nuevo SW se active solo. needRefresh sigue disparándose para que
// el user clickee "Actualizar" y forzar el reload — sin reload el documento
// HTML queda viejo (incluye CSP, JS bundles cacheados via SW).
//
// onRegisteredSW: poll periódico (1h) para detectar nuevos releases si el user
// tiene una tab abierta horas/días. Sin esto, el browser solo checkea el SW en
// navigations + page load — un PWA standalone que el user no cierra nunca
// nunca vería el banner. La runtime rule NetworkFirst de navigation (vite.config
// .js) ya garantiza que el HTML viene fresco con el CSP del momento cuando hay
// red, pero el update() acá asegura que también se detecte la versión nueva del
// SW para que el JS bundle se actualice.
const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000; // 1h

function UpdateBanner() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      setInterval(() => {
        // .update() puede tirar si el browser no soporta o hay error de red.
        // Silenciamos — el siguiente intervalo lo retrya.
        registration.update().catch(() => {});
      }, SW_UPDATE_INTERVAL_MS);
    },
  });

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
// `group` agrupa visualmente el menú; cada grupo se renderiza con su título
// (NAV_GROUPS) arriba del primer ítem visible del grupo.
//
// 2026-06-10: agrupación pedida por Lucas — etiquetas visibles para que el
// menú se sienta más organizado y la navegación sea predecible.
const NAV_GROUPS = {
  1: 'Comercial',
  2: 'Cajas y Proveedores',
  3: 'Opciones Financieras',
  4: 'Otras herramientas',
  5: 'Logística',
  6: 'Proyectos',
};
const NAV_MAIN = [
  // Comercial
  { id: 'inicio',     path: '/inicio',     label: 'Inicio',     icon: 'Grid',       perm: null,          group: 1 },
  { id: 'resumen',    path: '/resumen',    label: 'Resumen del mes', icon: 'Trend',  perm: 'financiera',  group: 1 },
  { id: 'ventas',     path: '/ventas',     label: 'Ventas',     icon: 'CreditCard', perm: 'ventas',      group: 1 },
  { id: 'cuentas',    path: '/cuentas',    label: 'Venta & Gestión B2B', icon: 'Receipt',    perm: 'cuentas',     group: 1 },
  { id: 'contactos',  path: '/contactos',  label: 'Contactos',  icon: 'Users',      perm: 'contactos',   group: 1 },
  // Cajas y Proveedores
  { id: 'cajas',      path: '/cajas',      label: 'Cajas',      icon: 'Wallet',     perm: 'cajas',       group: 2 },
  { id: 'conciliacion', path: '/conciliacion', label: 'Conciliación bancaria', icon: 'Refresh', perm: 'cajas', group: 2 },
  { id: 'egresos',    path: '/egresos',    label: 'Egresos',    icon: 'ArrowDownRight', perm: 'cajas',   group: 2 },
  { id: 'inventario', path: '/inventario', label: 'Inventario', icon: 'Box',        perm: 'inventario',  group: 2 },
  { id: 'proveedores',path: '/proveedores',label: 'Proveedores | Compras',icon: 'Building',   perm: 'proveedores', group: 2 },
  // Opciones Financieras  (la ruta /financiera y el permiso siguen siendo
  // `financiera` para no romper enlaces ni audit trail; solo cambia el label
  // visible a "Transferencias", 2026-06-10.)
  // Orden definido por Lucas 2026-06-14 — Cambios primero (flujo de obtener
  // ARS), después Transferencias (cobrar), después Tarjetas (cobrar con crédito).
  { id: 'cambios',    path: '/cambios',    label: 'Cambios de Divisa', icon: 'Dollar', perm: 'cambios',  group: 3 },
  { id: 'financiera', path: '/financiera', label: 'Transferencias', icon: 'Trend',  perm: 'financiera',  group: 3 },
  { id: 'tarjetas',   path: '/tarjetas',   label: 'Tarjetas de Crédito', icon: 'CreditCard', perm: 'tarjetas', group: 3 },
  // Otras herramientas
  { id: 'cotizador',  path: '/cotizador',  label: 'Cotizador',  icon: 'Calculator', perm: 'cotizador',   group: 4 },
  { id: 'usados',     path: '/usados',     label: 'Usados y Cotizador',            icon: 'Phone',      perm: 'usados',      group: 4 },
  // Logística
  { id: 'envios',     path: '/envios',     label: 'Envíos',     icon: 'Truck',      perm: 'envios',      group: 5 },
  // Proyectos
  { id: 'proyectos',  path: '/proyectos',  label: 'Proyectos',  icon: 'Calendar',   perm: 'proyectos',   group: 6 },
];

const NAV_SYS = [
  { id: 'historial', path: '/historial', label: 'Historial', icon: 'Refresh',  perm: 'financiera'  },
  { id: 'usuarios',  path: '/usuarios',  label: 'Usuarios',  icon: 'Users',    adminOnly: true      },
  { id: 'config',    path: '/config',    label: 'Config',    icon: 'Settings', perm: 'financiera'  },
];

// Map path segment → display label for breadcrumb. 2026-06-10: actualizado a
// "Transferencias" y "Usados y Cotizador" en paralelo con NAV_MAIN.
const SCREEN_LABELS = {
  inicio:     'Inicio',
  resumen:    'Resumen del mes',
  cotizador:  'Cotizador',
  financiera: 'Transferencias',
  cambios:    'Cambios de Divisa',
  tarjetas:   'Tarjetas de Crédito',
  cajas:      'Cajas',
  capital:    '360 & Capital',
  conciliacion: 'Conciliación bancaria',
  egresos:    'Egresos',
  envios:     'Envíos',
  cuentas:    'Venta & Gestión B2B',
  contactos:  'Contactos',
  proveedores: 'Proveedores | Compras',
  usados:     'Usados y Cotizador',
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
          <div className="brand-mark">T</div>
          <div>
            <div className="brand-name">Tecny</div>
            <div className="brand-sub">Portal operativo</div>
          </div>
        </div>

        <div className="sidebar-scroll">
        {/* "Herramientas" es el título general. Los sub-títulos vienen de
            NAV_GROUPS y se muestran arriba del primer item visible de cada
            grupo (sin separador horizontal — el título mismo marca el corte).
            2026-06-10. */}
        <div className="nav-section">Herramientas</div>
        {visibleMain.map((n, i) => {
          const I = Icons[n.icon];
          const prev = visibleMain[i - 1];
          // Mostrar header de grupo cuando cambia (también para el primer item).
          const showGroupHeader = !prev || prev.group !== n.group;
          const groupLabel = NAV_GROUPS[n.group];
          return (
            <div key={n.id}>
              {showGroupHeader && groupLabel && (
                <div className="nav-subsection">{groupLabel}</div>
              )}
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
              // Si hay badge en "config" (alertas activas), el click navega
              // directo a la tab Alertas via hash (#alertas) — Config.jsx lo
              // lee al montar. Sin badge, va al destino normal.
              const isConfigConBadge = n.id === 'config' && badges[n.id] != null;
              const target = isConfigConBadge ? `${n.path}#alertas` : n.path;
              return (
                <NavLink
                  key={n.id}
                  to={target}
                  className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
                  onClick={onClose}
                  aria-label={isConfigConBadge ? `${n.label} — ${badges[n.id]} alertas pendientes` : n.label}
                >
                  <span className="ico">{I && <I size={16} />}</span>
                  <span>{n.label}</span>
                  {badges[n.id] != null && (
                    <span className="badge" style={{ background: 'var(--neg)', color: '#fff' }}>{badges[n.id]}</span>
                  )}
                </NavLink>
              );
            })}
          </>
        )}
        </div>

        <UserPill />
      </aside>
    </>
  );
}

function UserPill() {
  const { user, logout } = useAuth();
  const { isDark, toggle: toggleTheme } = useTheme();
  const [showChangePassword, setShowChangePassword] = useState(false);

  if (!user) return null;

  const initials = getInitials(user.nombre || user.username);
  const displayName = user.nombre || user.username;
  const roleLabel = user.role === 'admin' ? 'Admin' : 'Operador';

  return (
    <>
      <div className="user-pill" style={{ cursor: 'default' }}>
        <div className="avatar">{initials}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="name">{displayName}</div>
          <div className="role">
            {roleLabel} · @{user.username}
          </div>
        </div>
        {/* 2026-06-19 #338: toggle dark/light. Icono sol cuando estamos en
            dark (action: "ir a light"), luna cuando estamos en light (action:
            "ir a dark"). aria-label describe el destino, no el estado actual. */}
        <button
          className="icon-btn"
          onClick={toggleTheme}
          title={isDark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
          aria-label={isDark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
          style={{ flexShrink: 0 }}
        >
          {isDark ? <Icons.Sun size={14} /> : <Icons.Moon size={14} />}
        </button>
        {/* 2026-06-18 #306: botón cambiar contraseña.
            Antes el endpoint existía pero no había forma de invocarlo desde la
            UI — los admins debían usar fetch desde DevTools console (filtraba
            passwords en console history). Cierra el gap detectado en staging. */}
        <button
          className="icon-btn"
          onClick={() => setShowChangePassword(true)}
          title="Cambiar contraseña"
          aria-label="Cambiar contraseña"
          style={{ flexShrink: 0 }}
        >
          <Icons.Lock size={14} />
        </button>
        <button
          className="icon-btn"
          onClick={logout}
          title="Cerrar sesión"
          aria-label="Cerrar sesión"
          style={{ flexShrink: 0 }}
        >
          <Icons.Logout size={14} />
        </button>
      </div>
      <ChangePasswordModal
        open={showChangePassword}
        onClose={() => setShowChangePassword(false)}
      />
    </>
  );
}

function Topbar({ onMenuClick, onSearchClick }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { primaryAction } = usePageActions();
  const segment = location.pathname.split('/').filter(Boolean)[0] || 'inicio';
  const label = SCREEN_LABELS[segment] || segment;

  return (
    <div className="topbar">
      <button className="icon-btn hamburger-btn" title="Menu" onClick={onMenuClick}>
        <Icons.Menu size={17} />
      </button>
      {segment !== 'inicio' && (
        <button className="icon-btn" title="Volver" onClick={() => navigate(-1)} style={{ fontSize: 18, lineHeight: 1 }}>←</button>
      )}
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
      {/* "Notificaciones" oculto hasta que tenga feature real. La auditoría
          detectó que aparecer sin onClick parecía bug. */}
      {/* <button className="icon-btn" title="Notificaciones"><Icons.Bell size={17} /></button> */}
      {/* "Nuevo" solo se renderiza cuando la pantalla actual registra una
          primaryAction vía usePageActions(). Pantallas que no la registran
          (Inicio, Historial, Capital, Desglose360, Forbidden, etc.) ya no
          muestran un botón a 35% opacidad que parecía deshabilitado. */}
      {primaryAction && (
        <button
          className="icon-btn"
          title={primaryAction.label || 'Nuevo'}
          aria-label={primaryAction.label || 'Nuevo'}
          onClick={() => primaryAction.onClick?.()}
          style={{ color: 'var(--accent)' }}
        >
          <Icons.Plus size={17} />
        </button>
      )}
    </div>
  );
}

export default function Shell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [badges, setBadges] = useState({});
  const { user } = useAuth();
  // 2026-06-19 #338: tema dinámico (vault dark / linen light).
  // El ThemeProvider también setea documentElement.data-theme como side
  // effect, pero acá lo aplicamos al contenedor `.app` para garantizar
  // que el árbol React refleja el tema actual incluso si algún ancestor
  // del DOM tiene un atributo distinto (defensive en SPAs con múltiples
  // mount points / portals fuera del root).
  const { theme } = useTheme();

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

  // Refresca el contador de alertas cada 2 min. Best-effort: si falla
  // (sin permiso financiera, sin sesión, etc.), se ignora silenciosamente.
  // El badge solo se muestra si total_alertas > 0.
  useEffect(() => {
    if (!user) return;
    const hasFinanciera = user.role === 'admin' || user.perms?.financiera === true;
    if (!hasFinanciera) return;
    let cancelled = false;
    function refresh() {
      alertasApi.list()
        .then(r => {
          // El badge cuelga del item "config" del menú Sistema — Alertas
          // ahora vive como tab dentro de Config, así el contador aparece
          // donde el usuario va a actuar sobre ellas.
          if (!cancelled) setBadges(b => ({ ...b, config: r.total_alertas || null }));
        })
        .catch(() => {});
    }
    refresh();
    const id = setInterval(refresh, 2 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user]);

  return (
    <div className="app" data-theme={theme}>
      <Sidebar badges={badges} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="main">
        <Topbar
          onMenuClick={() => setSidebarOpen(s => !s)}
          onSearchClick={() => setPaletteOpen(true)}
        />
        <UpdateBanner />
        <UnverifiedBanner />
        <div className="content">
          <Outlet />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
