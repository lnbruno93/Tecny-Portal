// Router del admin console:
//   · /login                  → real
//   · /                       → Resumen, real (KPIs + chart + activity + top)
//   · /clientes               → Clientes, real (lista + filtros + búsqueda)
//   · /clientes/:id           → Ficha, real (detalle + 2 tabs + 4 modals de mutations)
//   · /planes                 → Planes, real (editor de precios #353)
//   · /facturacion, /onboarding, /uso, /soporte
//                             → placeholders ComingSoon (no implementadas todavía)

import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Layout from './components/Layout.jsx';
import { useAuth } from './contexts/AuthContext.jsx';
import { PageHead } from './components/primitives/index.jsx';

// PERF-3 fix (audit 2026-06-22): code-split de rutas autenticadas con
// React.lazy + Suspense. El user que aterriza en /login NO necesita el
// código de Ficha + 4 modals + ColChart + Planes — eso son ~40KB que
// se descargan solo después de loguearse. Login queda en el initial
// bundle por velocidad (es la pantalla pre-auth obvia).
const Resumen  = lazy(() => import('./pages/Resumen.jsx'));
const Clientes = lazy(() => import('./pages/Clientes.jsx'));
const Ficha    = lazy(() => import('./pages/Ficha.jsx'));
const Planes   = lazy(() => import('./pages/Planes.jsx'));

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
  // Suspense fallback: skeleton mínimo mientras se descarga el chunk de
  // la página (primera visita post-login a cada ruta). Después queda
  // cached y el render es instantáneo.
  return (
    <Layout>
      <Suspense
        fallback={
          <div style={{ display: 'grid', placeItems: 'center', minHeight: 200 }}>
            <div className="muted" style={{ fontSize: 13 }}>Cargando…</div>
          </div>
        }
      >
        {children}
      </Suspense>
    </Layout>
  );
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
