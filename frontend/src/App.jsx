import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { PageActionsProvider } from './contexts/PageActionsContext';
import { ToastProvider } from './contexts/ToastContext';
import { ConfirmProvider } from './components/ConfirmModal';
import Shell from './components/Shell';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './screens/Login';
import Forbidden from './screens/Forbidden';

// Lazy-load screens — Vite genera un chunk por pantalla (~40% menos bundle inicial)
const Inicio     = lazy(() => import('./screens/Inicio'));
const CuentasCC  = lazy(() => import('./screens/CuentasCC'));
const Financiera = lazy(() => import('./screens/Financiera'));
const Envios     = lazy(() => import('./screens/Envios'));
const Cajas      = lazy(() => import('./screens/Cajas'));
const Usados     = lazy(() => import('./screens/Usados'));
const Historial  = lazy(() => import('./screens/Historial'));
const Usuarios   = lazy(() => import('./screens/Usuarios'));
const Config     = lazy(() => import('./screens/Config'));
const Cotizador  = lazy(() => import('./screens/Cotizador'));
const Inventario = lazy(() => import('./screens/Inventario'));
const Ventas     = lazy(() => import('./screens/Ventas'));
const Proveedores = lazy(() => import('./screens/Proveedores'));
const Proyectos  = lazy(() => import('./screens/Proyectos'));
const Contactos  = lazy(() => import('./screens/Contactos'));
const Cambios    = lazy(() => import('./screens/Cambios'));

function PageLoader() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: 'var(--text-muted)',
      fontSize: 14,
    }}>
      Cargando…
    </div>
  );
}

// ── Auth gate ──────────────────────────────────────────────────────────────────
function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      color: 'var(--text-muted)',
      fontSize: 14,
    }}>
      Verificando sesión…
    </div>
  );
  if (!user) return <Login />;
  return children;
}

// ── Permission gate ────────────────────────────────────────────────────────────
// perm: key en user.perms (ej. 'financiera')
// adminOnly: true → solo role === 'admin'
function RequirePermission({ perm, adminOnly, children }) {
  const { user } = useAuth();
  if (!user) return null;

  // Admin bypasses all permission checks
  if (user.role === 'admin') return children;

  // Admin-only route
  if (adminOnly) return <Forbidden />;

  // Permission check
  if (perm && !user.perms?.[perm]) return <Forbidden />;

  return children;
}

// ── App ────────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
      <ConfirmProvider>
      <PageActionsProvider>
        <BrowserRouter>
          <RequireAuth>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<Shell />}>
                  <Route index element={<Navigate to="/inicio" replace />} />

                  {/* ── Siempre visible ── */}
                  <Route path="inicio" element={
                    <ErrorBoundary><Inicio /></ErrorBoundary>
                  } />

                  {/* ── Por permiso ── */}
                  <Route path="cotizador" element={
                    <RequirePermission perm="cotizador">
                      <ErrorBoundary><Cotizador /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="financiera/*" element={
                    <RequirePermission perm="financiera">
                      <ErrorBoundary><Financiera /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="cajas/*" element={
                    <RequirePermission perm="cajas">
                      <ErrorBoundary><Cajas /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="envios" element={
                    <RequirePermission perm="envios">
                      <ErrorBoundary><Envios /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="cuentas/*" element={
                    <RequirePermission perm="cuentas">
                      <ErrorBoundary><CuentasCC /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="usados" element={
                    <RequirePermission perm="usados">
                      <ErrorBoundary><Usados /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="inventario" element={
                    <RequirePermission perm="inventario">
                      <ErrorBoundary><Inventario /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="ventas" element={
                    <RequirePermission perm="ventas">
                      <ErrorBoundary><Ventas /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="proveedores" element={
                    <RequirePermission perm="proveedores">
                      <ErrorBoundary><Proveedores /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="proyectos" element={
                    <RequirePermission perm="proyectos">
                      <ErrorBoundary><Proyectos /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="contactos" element={
                    <RequirePermission perm="contactos">
                      <ErrorBoundary><Contactos /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="cambios" element={
                    <RequirePermission perm="cambios">
                      <ErrorBoundary><Cambios /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  {/* ── Historial y Config requieren 'financiera' ── */}
                  <Route path="historial" element={
                    <RequirePermission perm="financiera">
                      <ErrorBoundary><Historial /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="config" element={
                    <RequirePermission perm="financiera">
                      <ErrorBoundary><Config /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  {/* ── Solo admin ── */}
                  <Route path="usuarios" element={
                    <RequirePermission adminOnly>
                      <ErrorBoundary><Usuarios /></ErrorBoundary>
                    </RequirePermission>
                  } />
                </Route>
              </Routes>
            </Suspense>
          </RequireAuth>
        </BrowserRouter>
      </PageActionsProvider>
      </ConfirmProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
