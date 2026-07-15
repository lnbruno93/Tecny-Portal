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
// 2026-07-04: pantallas públicas del flow "Olvidé mi contraseña". Se cargan
// lazy porque el user típico (super-admin loguéandose normal) nunca las abre
// — no las queremos en el initial bundle del login. El delay de descarga es
// aceptable: el user llega desde un email, no lo apura un segundo.
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.jsx'));
const ResetPassword  = lazy(() => import('./pages/ResetPassword.jsx'));

// PERF-3 fix (audit 2026-06-22): code-split de rutas autenticadas con
// React.lazy + Suspense. El user que aterriza en /login NO necesita el
// código de Ficha + 4 modals + ColChart + Planes — eso son ~40KB que
// se descargan solo después de loguearse. Login queda en el initial
// bundle por velocidad (es la pantalla pre-auth obvia).
const Resumen    = lazy(() => import('./pages/Resumen.jsx'));
const Clientes   = lazy(() => import('./pages/Clientes.jsx'));
const Ficha      = lazy(() => import('./pages/Ficha.jsx'));
const Planes     = lazy(() => import('./pages/Planes.jsx'));
// #498: Mi cuenta — gestión de password y 2FA del super-admin desde el back
// office (antes había que salir a app.tecnyapp.com para hacerlo).
const MiCuenta   = lazy(() => import('./pages/MiCuenta.jsx'));
// #499 (2026-07-01): Equipo — lista de super-admins + gestión de invitaciones.
const Equipo     = lazy(() => import('./pages/Equipo.jsx'));
// 2026-07-13 CMS Landing Fase 1: editar el contenido de tecnyapp.com
// (contacto: mail, WA, dirección, IG) sin redeploy.
const SitioPublico = lazy(() => import('./pages/SitioPublico.jsx'));
// 2026-07-15 (task #130): Facturación y cobros — dashboard SaaS billing.
// Mock por ahora (backend genera facturas desde tenants reales) hasta que
// integremos billing real (Stripe/MP).
const Facturacion = lazy(() => import('./pages/Facturacion.jsx'));
// #499 pantalla PÚBLICA (sin auth): landing del invitado que clickea el link
// del email. Se carga fuera del ProtectedRoute — el user recién va a crearse.
const AcceptSuperAdminInvite = lazy(() => import('./pages/AcceptSuperAdminInvite.jsx'));

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
      {/* #499 (2026-07-01): landing del invitado a super-admin. Pública. La
          carga con Suspense fallback porque también es lazy — el user llega
          desde el email, no importa un poquito de latencia extra vs el login. */}
      <Route
        path="/aceptar-invitacion"
        element={
          <Suspense fallback={<div style={{ display:'grid', placeItems:'center', height:'100vh' }}><div className="muted">Cargando…</div></div>}>
            <AcceptSuperAdminInvite />
          </Suspense>
        }
      />
      {/* 2026-07-04: flow "Olvidé mi contraseña" para super-admins. Ambas
          rutas son PÚBLICAS (fuera del ProtectedRoute) — el user está
          deslogueado cuando llega acá. El backend endpoints
          (POST /api/auth/forgot-password y /reset-password) son shared con
          el portal (TANDA 0 #321). El link del email lleva a
          /reset-password?token=<hex>. */}
      <Route
        path="/forgot-password"
        element={
          <Suspense fallback={<div style={{ display:'grid', placeItems:'center', height:'100vh' }}><div className="muted">Cargando…</div></div>}>
            <ForgotPassword />
          </Suspense>
        }
      />
      <Route
        path="/reset-password"
        element={
          <Suspense fallback={<div style={{ display:'grid', placeItems:'center', height:'100vh' }}><div className="muted">Cargando…</div></div>}>
            <ResetPassword />
          </Suspense>
        }
      />
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
      {/* #499 (2026-07-01): Equipo — gestión de super-admins. */}
      <Route
        path="/equipo"
        element={
          <ProtectedRoute>
            <Equipo />
          </ProtectedRoute>
        }
      />
      {/* 2026-07-13 CMS Landing: editor de contenido del sitio público. */}
      <Route
        path="/sitio-publico"
        element={
          <ProtectedRoute>
            <SitioPublico />
          </ProtectedRoute>
        }
      />
      {/* 2026-07-15 (task #130): Facturación y cobros — vuelve como ruta real
          (antes había sido eliminada en #450 por estar en ComingSoon). Ahora
          renderiza una pantalla con backend mock — cuando integremos billing
          real, se reescribe el endpoint por debajo sin tocar acá. */}
      <Route
        path="/facturacion"
        element={
          <ProtectedRoute>
            <Facturacion />
          </ProtectedRoute>
        }
      />
      {/* #450 (2026-06-26): rutas /onboarding, /uso, /soporte eliminadas.
          Eran páginas ComingSoon — confundían más de lo que ayudaban.
          Bookmarks viejos caen al NotFound (que tiene un botón "Ir a Resumen"). */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
