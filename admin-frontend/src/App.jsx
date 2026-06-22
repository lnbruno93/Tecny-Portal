// Router del admin console. Estado actual (post-Sub-fase C.1.3):
//   · /login                  → real
//   · /                       → Resumen, real (KPIs + chart + activity + top)
//   · /clientes               → Clientes, real (lista + filtros + búsqueda)
//   · /clientes/:id           → Ficha, real (detalle + 2 tabs + 4 modals de mutations)
//   · /planes                 → Planes, real (editor de precios C.1.3 #353)
//   · /facturacion, /onboarding, /uso, /soporte
//                             → placeholders ComingSoon (Sub-fases futuras)

import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Resumen from './pages/Resumen.jsx';
import Clientes from './pages/Clientes.jsx';
import Ficha from './pages/Ficha.jsx';
import Planes from './pages/Planes.jsx';
import Layout from './components/Layout.jsx';
import { useAuth } from './contexts/AuthContext.jsx';
import { PageHead } from './components/primitives/index.jsx';

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  // Mientras el AuthProvider revalida el token cacheado (mount inicial),
  // mostramos un placeholder neutro para evitar el flicker login → layout.
  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
        <div className="muted" style={{ fontSize: 13 }}>Cargando…</div>
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Layout>{children}</Layout>;
}

function ComingSoon({ title, label }) {
  return (
    <>
      <PageHead
        label={label}
        title={title}
        subtitle="Esta sección se implementa en la próxima fase."
      />
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>Próximamente.</p>
      </div>
    </>
  );
}

function NotFound() {
  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100vh',
        textAlign: 'center',
        padding: 32,
        background: 'var(--bg)',
      }}
    >
      <div>
        <h1 style={{ fontSize: 48, margin: 0, color: 'var(--text)' }}>404</h1>
        <p className="muted">Esta ruta no existe.</p>
        <a
          href="/"
          className="btn btn-primary"
          style={{ marginTop: 16, display: 'inline-flex' }}
        >
          Ir a Resumen
        </a>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Resumen />
          </ProtectedRoute>
        }
      />
      <Route
        path="/clientes"
        element={
          <ProtectedRoute>
            <Clientes />
          </ProtectedRoute>
        }
      />
      <Route
        path="/clientes/:id"
        element={
          <ProtectedRoute>
            <Ficha />
          </ProtectedRoute>
        }
      />
      <Route
        path="/planes"
        element={
          <ProtectedRoute>
            <Planes />
          </ProtectedRoute>
        }
      />
      <Route
        path="/facturacion"
        element={
          <ProtectedRoute>
            <ComingSoon label="Facturación" title="Facturación y cobros" />
          </ProtectedRoute>
        }
      />
      <Route
        path="/onboarding"
        element={
          <ProtectedRoute>
            <ComingSoon label="Onboarding" title="Onboarding" />
          </ProtectedRoute>
        }
      />
      <Route
        path="/uso"
        element={
          <ProtectedRoute>
            <ComingSoon label="Uso" title="Uso de la plataforma" />
          </ProtectedRoute>
        }
      />
      <Route
        path="/soporte"
        element={
          <ProtectedRoute>
            <ComingSoon label="Soporte" title="Soporte" />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
