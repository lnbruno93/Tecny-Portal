// Router del admin console:
//   · /login                  → real
//   · /                       → Resumen, real (KPIs + chart + activity + top)
//   · /clientes               → Clientes, real (lista + filtros + búsqueda)
//   · /clientes/:id           → Ficha, real (detalle + 2 tabs + 4 modals de mutations)
//   · /planes                 → Planes, real (editor de precios #353)
//   · /tc-defaults            → TcDefaults, real (editor de TC default por país, F4 #470)
//   · /facturacion, /onboarding, /uso, /soporte
//                             → placeholders ComingSoon (no implementadas todavía)

import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Layout from './components/Layout.jsx';
import { useAuth } from './contexts/AuthContext.jsx';

// PERF-3 fix (audit 2026-06-22): code-split de rutas autenticadas con
// React.lazy + Suspense. El user que aterriza en /login NO necesita el
// código de Ficha + 4 modals + ColChart + Planes — eso son ~40KB que
// se descargan solo después de loguearse. Login queda en el initial
// bundle por velocidad (es la pantalla pre-auth obvia).
const Resumen    = lazy(() => import('./pages/Resumen.jsx'));
const Clientes   = lazy(() => import('./pages/Clientes.jsx'));
const Ficha      = lazy(() => import('./pages/Ficha.jsx'));
const Planes     = lazy(() => import('./pages/Planes.jsx'));
const TcDefaults = lazy(() => import('./pages/TcDefaults.jsx'));
// #498: Mi cuenta — gestión de password y 2FA del super-admin desde el back
// office (antes había que salir a app.tecnyapp.com para hacerlo).
const MiCuenta   = lazy(() => import('./pages/MiCuenta.jsx'));

function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  // Mientras el AuthProvider revalida el token cacheado (mount inicial),
  // mostramos un placeholder neutro para evitar el flicker login → layout.
  if (loading) {
    return (
      <div
        style={{ display: 'grid', placeItems: 'center', height: '100vh' }}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
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
          <div
            style={{ display: 'grid', placeItems: 'center', minHeight: 200 }}
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="muted" style={{ fontSize: 13 }}>Cargando…</div>
          </div>
        }
      >
        {children}
      </Suspense>
    </Layout>
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
      {/* Multi-país F4 (#470): editor de TC default por país (AR ARS/USD, UY UYU/USD). */}
      <Route
        path="/tc-defaults"
        element={
          <ProtectedRoute>
            <TcDefaults />
          </ProtectedRoute>
        }
      />
      {/* #498: Mi cuenta — password + 2FA del super-admin.
          Se accede desde el user-pill del sidebar (o desde el CTA del banner
          de Resumen cuando 2FA no está activo). Query param opcional
          ?tab=seguridad|perfil preserva el tab activo. */}
      <Route
        path="/mi-cuenta"
        element={
          <ProtectedRoute>
            <MiCuenta />
          </ProtectedRoute>
        }
      />
      {/* #450 (2026-06-26): rutas /facturacion, /onboarding, /uso, /soporte
          eliminadas. Eran páginas ComingSoon — confundían más de lo que ayudaban.
          Bookmarks viejos caen al NotFound (que tiene un botón "Ir a Resumen"). */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
