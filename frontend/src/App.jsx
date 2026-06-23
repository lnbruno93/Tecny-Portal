import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { PageActionsProvider } from './contexts/PageActionsContext';
import { ToastProvider } from './contexts/ToastContext';
import { ConfirmProvider } from './components/ConfirmModal';
import { TcReferenciaProvider } from './contexts/TcReferenciaContext';
import { FeatureFlagsProvider } from './contexts/FeatureFlagsContext';
import Shell from './components/Shell';
import ErrorBoundary from './components/ErrorBoundary';
import Login from './screens/Login';
import Forbidden from './screens/Forbidden';

// Rutas públicas TANDA 2.2 — accesibles SIN sesión (no pasan por AuthGuard).
const Signup = lazy(() => import('./screens/Signup'));
const VerifyEmail = lazy(() => import('./screens/VerifyEmail'));
// TANDA 0 #321 — forgot-password auto-servicio.
const ForgotPassword = lazy(() => import('./screens/ForgotPassword'));
const ResetPassword = lazy(() => import('./screens/ResetPassword'));
// Landing comercial (#331) — montada en `/`. Lazy load para no inflar el
// bundle del portal (los users logueados nunca la cargan: hay redirect a
// /inicio en el Route `/`).
const Landing = lazy(() => import('./screens/Landing'));

// Páginas legales públicas (#332) — Términos, Privacidad, Seguridad.
// Lazy + named exports del mismo archivo. Cada una hace su propio
// chunk del bundle compartido `LegalPages`.
const TermsPage    = lazy(() => import('./screens/LegalPages').then((m) => ({ default: m.TermsPage })));
const PrivacyPage  = lazy(() => import('./screens/LegalPages').then((m) => ({ default: m.PrivacyPage })));
const SecurityPage = lazy(() => import('./screens/LegalPages').then((m) => ({ default: m.SecurityPage })));

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
const Desglose360 = lazy(() => import('./screens/Desglose360'));
const RecepcionStock = lazy(() => import('./screens/RecepcionStock'));
const NotFound   = lazy(() => import('./screens/NotFound'));
const Ventas     = lazy(() => import('./screens/Ventas'));
const Proveedores = lazy(() => import('./screens/Proveedores'));
const Proyectos  = lazy(() => import('./screens/Proyectos'));
const Contactos  = lazy(() => import('./screens/Contactos'));
const Egresos    = lazy(() => import('./screens/Egresos'));
const Sanidad    = lazy(() => import('./screens/Sanidad'));
const Capital    = lazy(() => import('./screens/Capital'));
const Resumen    = lazy(() => import('./screens/Resumen'));
// (Nota: Alertas ahora vive como tab dentro de Config.jsx, no como ruta propia)
const Conciliacion = lazy(() => import('./screens/Conciliacion'));
const Cambios    = lazy(() => import('./screens/Cambios'));
const Tarjetas   = lazy(() => import('./screens/Tarjetas'));

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
// Pattern react-router v6: layout route con <Outlet />. Si hay user → renderea
// las rutas anidadas (Shell + permisos). Si no → renderea Login.jsx directo
// sin /login route — el Login se monta en lugar del Shell. Funciona para
// rutas internas (/inicio, /cotizador, etc.) y también si alguien hace
// click en "Iniciar sesión" desde /signup (cae acá vía el catch-all interno).
function AuthGuard() {
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
  return <Outlet />;
}

// ── Landing gate ───────────────────────────────────────────────────────────────
// Para la ruta pública `/`: si el user ya está logueado, lo mandamos directo al
// portal (/inicio) — no queremos que vea marketing si entró por bookmark. Si
// no hay sesión, mostramos la landing comercial. Pattern estándar de SaaS
// (Stripe, Linear, Netflix).
//
// Mientras carga el estado de auth (loading=true en AuthContext), devolvemos
// la landing igual — el flash de marketing es preferible al pantallazo en
// blanco. Cuando termine de cargar y haya sesión, el Navigate hace su efecto.
function LandingOrRedirect() {
  const { user, loading } = useAuth();
  if (!loading && user) return <Navigate to="/inicio" replace />;
  return <Landing />;
}

// Lo mismo para /login y /signup: si el user YA está logueado, no tiene
// sentido mostrarle el form — redirect al portal.
function RedirectIfAuthed({ children }) {
  const { user, loading } = useAuth();
  if (!loading && user) return <Navigate to="/inicio" replace />;
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
    <ThemeProvider>
    <AuthProvider>
      <ToastProvider>
      <ConfirmProvider>
      <TcReferenciaProvider>
      <FeatureFlagsProvider>
      <PageActionsProvider>
        <BrowserRouter>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              {/* ── Landing comercial (#331) ── */}
              {/* `/` es pública. Si hay JWT, LandingOrRedirect → /inicio. */}
              <Route path="/" element={
                <ErrorBoundary><LandingOrRedirect /></ErrorBoundary>
              } />

              {/* ── /login ── ruta explícita post-#331 para que la landing
                  pueda linkear a ella. Si el user YA tiene sesión, redirect
                  a /inicio en lugar de mostrar el form. */}
              <Route path="/login" element={
                <RedirectIfAuthed>
                  <ErrorBoundary><Login /></ErrorBoundary>
                </RedirectIfAuthed>
              } />

              {/* ── Rutas públicas (TANDA 2.2) ── */}
              <Route path="/signup" element={
                <RedirectIfAuthed>
                  <ErrorBoundary><Signup /></ErrorBoundary>
                </RedirectIfAuthed>
              } />
              <Route path="/verify-email" element={
                <ErrorBoundary><VerifyEmail /></ErrorBoundary>
              } />
              {/* TANDA 0 #321 — forgot-password auto-servicio. */}
              <Route path="/forgot-password" element={
                <ErrorBoundary><ForgotPassword /></ErrorBoundary>
              } />
              <Route path="/reset-password" element={
                <ErrorBoundary><ResetPassword /></ErrorBoundary>
              } />

              {/* ── Páginas legales públicas (#332) ── */}
              {/* Sin guard de auth: tienen que ser accesibles desde la
                  landing por usuarios anónimos antes del signup. */}
              <Route path="/terms" element={
                <ErrorBoundary><TermsPage /></ErrorBoundary>
              } />
              <Route path="/privacy" element={
                <ErrorBoundary><PrivacyPage /></ErrorBoundary>
              } />
              <Route path="/security" element={
                <ErrorBoundary><SecurityPage /></ErrorBoundary>
              } />

              {/* ── Rutas protegidas: AuthGuard intercepta. ── */}
              {/* Post-#331: Shell pasa de `path="/"` a layout pathless
                  porque `/` ahora es Landing. Las child routes son
                  absolutas (/inicio, /cotizador, etc.) en lugar de
                  relativas. */}
              <Route element={<AuthGuard />}>
                <Route element={<Shell />}>
                  {/* ── Siempre visible ── */}
                  <Route path="/inicio" element={
                    <ErrorBoundary><Inicio /></ErrorBoundary>
                  } />

                  {/* ── Por permiso ── */}
                  <Route path="/cotizador" element={
                    <RequirePermission perm="cotizador">
                      <ErrorBoundary><Cotizador /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/financiera/*" element={
                    <RequirePermission perm="financiera">
                      <ErrorBoundary><Financiera /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/cajas/*" element={
                    <RequirePermission perm="cajas">
                      <ErrorBoundary><Cajas /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/egresos" element={
                    <RequirePermission perm="cajas">
                      <ErrorBoundary><Egresos /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/sanidad" element={
                    <RequirePermission perm="cajas">
                      <ErrorBoundary><Sanidad /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/capital" element={
                    <RequirePermission perm="cajas">
                      <ErrorBoundary><Capital /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/resumen" element={
                    <RequirePermission perm="financiera">
                      <ErrorBoundary><Resumen /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/conciliacion" element={
                    <RequirePermission perm="cajas">
                      <ErrorBoundary><Conciliacion /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/envios" element={
                    <RequirePermission perm="envios">
                      <ErrorBoundary><Envios /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/cuentas/*" element={
                    <RequirePermission perm="cuentas">
                      <ErrorBoundary><CuentasCC /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/usados" element={
                    <RequirePermission perm="usados">
                      <ErrorBoundary><Usados /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/inventario" element={
                    <RequirePermission perm="inventario">
                      <ErrorBoundary><Inventario /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/inventario/desglose" element={
                    <RequirePermission perm="inventario">
                      <ErrorBoundary><Desglose360 /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/inventario/recepcion" element={
                    <RequirePermission perm="inventario">
                      <ErrorBoundary><RecepcionStock /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/ventas" element={
                    <RequirePermission perm="ventas">
                      <ErrorBoundary><Ventas /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/proveedores" element={
                    <RequirePermission perm="proveedores">
                      <ErrorBoundary><Proveedores /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="/proyectos" element={
                    <RequirePermission perm="proyectos">
                      <ErrorBoundary><Proyectos /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="/contactos" element={
                    <RequirePermission perm="contactos">
                      <ErrorBoundary><Contactos /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="/cambios" element={
                    <RequirePermission perm="cambios">
                      <ErrorBoundary><Cambios /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="/tarjetas" element={
                    <RequirePermission perm="tarjetas">
                      <ErrorBoundary><Tarjetas /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  {/* ── Historial y Config requieren 'financiera' ── */}
                  <Route path="/historial" element={
                    <RequirePermission perm="financiera">
                      <ErrorBoundary><Historial /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/config" element={
                    <RequirePermission perm="financiera">
                      <ErrorBoundary><Config /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  {/* ── Solo admin ── */}
                  <Route path="/usuarios" element={
                    <RequirePermission adminOnly>
                      <ErrorBoundary><Usuarios /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  {/* ── 404 catch-all ── */}
                  <Route path="*" element={<ErrorBoundary><NotFound /></ErrorBoundary>} />
                </Route>
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </PageActionsProvider>
      </FeatureFlagsProvider>
      </TcReferenciaProvider>
      </ConfirmProvider>
      </ToastProvider>
    </AuthProvider>
    </ThemeProvider>
  );
}
