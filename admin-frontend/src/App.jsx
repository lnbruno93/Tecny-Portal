import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Login from './pages/Login.jsx';
import TenantsList from './pages/TenantsList.jsx';
import Layout from './components/Layout.jsx';
import { useAuth } from './contexts/AuthContext.jsx';

// ProtectedRoute: si no hay token + user.is_super_admin → redirect a /login,
// preservando la URL original en state.from para post-login redirect.
//
// Mostramos un splash en blanco mientras `loading` es true — sin esto, hay
// un flash de "redirect a /login" al refresh, porque el AuthContext arranca
// con loading=true mientras valida el token cacheado contra /me.
function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <div className="muted" style={{ fontSize: 13 }}>Cargando…</div>
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Layout>{children}</Layout>;
}

// Placeholder para rutas todavía no implementadas (Fase 4).
function ComingSoon({ title }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">Esta sección se implementa en Fase 4.</p>
        </div>
      </div>
      <div className="card">
        <p className="muted">Próximamente.</p>
      </div>
    </>
  );
}

function NotFound() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', textAlign: 'center', padding: 32 }}>
      <div>
        <h1 style={{ fontSize: 48, margin: 0 }}>404</h1>
        <p className="muted">Esta ruta no existe en el admin console.</p>
        <a href="/tenants" className="btn btn-primary" style={{ marginTop: 16 }}>Volver a Tenants</a>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Navigate to="/tenants" replace />} />
      <Route
        path="/tenants"
        element={<ProtectedRoute><TenantsList /></ProtectedRoute>}
      />
      <Route
        path="/tenants/:id"
        element={<ProtectedRoute><ComingSoon title="Detalle de tenant" /></ProtectedRoute>}
      />
      <Route
        path="/metrics"
        element={<ProtectedRoute><ComingSoon title="Métricas globales" /></ProtectedRoute>}
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
