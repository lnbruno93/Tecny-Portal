import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

// Shell con sidebar fijo + main area scrolleable. Sin librería UI — solo
// CSS + react-router NavLink (que aplica .active automáticamente cuando
// matchea la ruta actual).
export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Navegación principal">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">T</div>
          <div>
            <div className="brand-name">Tecny</div>
            <div className="brand-sub">Admin</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/tenants" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ico" aria-hidden="true">▦</span>
            <span>Tenants</span>
          </NavLink>
          <NavLink to="/metrics" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
            <span className="ico" aria-hidden="true">▲</span>
            <span>Métricas</span>
          </NavLink>
        </nav>

        <div className="sidebar-spacer" />

        <div className="user-pill" title={user?.email || ''}>
          <div className="avatar">{(user?.username || '?').slice(0, 1).toUpperCase()}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.username || 'Sin usuario'}
            </div>
            <div className="role">super-admin</div>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={handleLogout}
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
          >
            Salir
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="crumbs">
            <span className="cur">Super-Admin Console</span>
          </div>
          <div className="topbar-spacer" />
          <div className="user-chip">
            {user?.username} <span aria-hidden="true">▾</span>
          </div>
        </div>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
