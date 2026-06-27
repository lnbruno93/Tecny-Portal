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
import { userHasCap, userHasAnyCap } from './lib/userHasCap';

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
// 2026-06-27 #454 Red B2B F1: gestión de partnerships cross-tenant.
const RedB2B     = lazy(() => import('./screens/RedB2B'));
const RedB2BOperaciones        = lazy(() => import('./screens/RedB2BOperaciones'));
const RedB2BOperacionDetalle   = lazy(() => import('./screens/RedB2BOperacionDetalle'));
// 2026-06-28 #455 Red B2B F2: pantalla buyer-side de productos pendientes.
const RedB2BPendingReview = lazy(() => import('./screens/RedB2BPendingReview'));
// MOCKUP — pantalla de preview del nuevo modelo de permisos (Rol + Override).
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

// ── Capability gate ────────────────────────────────────────────────────────────
// 2026-06-23 F4 + F5c: cutover capability-based + soporte de OR-de-caps para
// pantallas multi-tab.
// Props:
//   cap        — slug único 'pantalla.capability' (ej. 'financiera.trabajar')
//   anyCap     — array de slugs; pasa si tiene AL MENOS UNA. Útil para
//                pantallas como /config con tabs de distintas caps.
//   adminOnly  — true → solo bypass por rol global o tenant_cap_rol=owner/admin
//
// Lógica:
//   1. Admin global (users.role='admin') pasa todo.
//   2. Owner/admin del tenant (user.tenant_cap_rol) pasa todo.
//   3. adminOnly → Forbidden si no es bypass.
//   4. cap/anyCap chequean user.caps (array de slugs del response /login | /me).
//      Si user.caps es null (bypass server-side), pasa.
// 2026-06-24 TANDA 4 DRY: delegamos los chequeos de bypass+cap a userHasCap/
// userHasAnyCap (lib/userHasCap.js), que es la source of truth compartida
// con useVisibleNav en Shell.jsx. Mantenemos `adminOnly` inline porque es la
// única check que NO chequea cap — solo bypass por rol — y agregar un cuarto
// helper en lib solo para eso sería overkill.
function RequirePermission({ cap, anyCap, adminOnly, children }) {
  const { user } = useAuth();
  if (!user) return null;

  // adminOnly: solo pasan los bypass roles. Replicamos la check de los
  // helpers (admin global + owner/admin del tenant) sin pasar por slug.
  if (adminOnly) {
    const isBypass = user.role === 'admin'
      || user.tenant_cap_rol === 'owner'
      || user.tenant_cap_rol === 'admin';
    return isBypass ? children : <Forbidden />;
  }

  if (cap && !userHasCap(user, cap)) return <Forbidden />;
  if (anyCap && !userHasAnyCap(user, anyCap)) return <Forbidden />;

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
                    <RequirePermission cap="cotizador.trabajar">
                      <ErrorBoundary><Cotizador /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/financiera/*" element={
                    <RequirePermission cap="financiera.trabajar">
                      <ErrorBoundary><Financiera /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/cajas/*" element={
                    <RequirePermission cap="cajas.ver">
                      <ErrorBoundary><Cajas /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/egresos" element={
                    <RequirePermission cap="egresos.ver">
                      <ErrorBoundary><Egresos /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/sanidad" element={
                    <RequirePermission cap="sanidad.trabajar">
                      <ErrorBoundary><Sanidad /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  {/* 2026-06-27 #454 Red B2B F1: gateado por cap cross_tenant.write */}
                  <Route path="/red-b2b" element={
                    <RequirePermission cap="cross_tenant.write">
                      <ErrorBoundary><RedB2B /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  {/* 2026-06-28 #455 Red B2B F2: pendientes de revisión (buyer-side) */}
                  <Route path="/red-b2b/pending-review" element={
                    <RequirePermission cap="cross_tenant.write">
                      <ErrorBoundary><RedB2BPendingReview /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  {/* 2026-06-28 #456 Red B2B F3: operaciones cross-tenant (CORE) */}
                  <Route path="/red-b2b/operaciones" element={
                    <RequirePermission cap="cross_tenant.write">
                      <ErrorBoundary><RedB2BOperaciones /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/red-b2b/operaciones/:id" element={
                    <RequirePermission cap="cross_tenant.write">
                      <ErrorBoundary><RedB2BOperacionDetalle /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/capital" element={
                    <RequirePermission cap="cajas.ver">
                      <ErrorBoundary><Capital /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/resumen" element={
                    <RequirePermission cap="resumen.ver">
                      <ErrorBoundary><Resumen /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/conciliacion" element={
                    <RequirePermission cap="cajas.conciliacion">
                      <ErrorBoundary><Conciliacion /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/envios" element={
                    <RequirePermission cap="envios.trabajar">
                      <ErrorBoundary><Envios /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/cuentas/*" element={
                    <RequirePermission cap="b2b.trabajar">
                      <ErrorBoundary><CuentasCC /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/usados" element={
                    <RequirePermission cap="usados.ver">
                      <ErrorBoundary><Usados /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/inventario" element={
                    <RequirePermission cap="inventario.ver">
                      <ErrorBoundary><Inventario /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/inventario/desglose" element={
                    <RequirePermission cap="inventario.ver">
                      <ErrorBoundary><Desglose360 /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/inventario/recepcion" element={
                    <RequirePermission cap="inventario.ver">
                      <ErrorBoundary><RecepcionStock /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/ventas" element={
                    <RequirePermission cap="ventas.trabajar">
                      <ErrorBoundary><Ventas /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  <Route path="/proveedores" element={
                    <RequirePermission cap="proveedores.trabajar">
                      <ErrorBoundary><Proveedores /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="/proyectos" element={
                    <RequirePermission cap="proyectos.trabajar">
                      <ErrorBoundary><Proyectos /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="/contactos" element={
                    <RequirePermission cap="contactos.ver">
                      <ErrorBoundary><Contactos /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="/cambios" element={
                    <RequirePermission cap="cambios.trabajar">
                      <ErrorBoundary><Cambios /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  <Route path="/tarjetas" element={
                    <RequirePermission cap="tarjetas.trabajar">
                      <ErrorBoundary><Tarjetas /></ErrorBoundary>
                    </RequirePermission>
                  } />

                  {/* ── Historial y Config requieren 'financiera' ── */}
                  <Route path="/historial" element={
                    <RequirePermission cap="historial.ver">
                      <ErrorBoundary><Historial /></ErrorBoundary>
                    </RequirePermission>
                  } />
                  {/* 2026-06-23 F5c: Config tiene 3 tabs (general/alertas/
                      mantenimiento), cada uno con su cap. El route abre si
                      tenés AL MENOS UNA. Adentro Config.jsx esconde los tabs
                      que no podés ver. */}
                  <Route path="/config" element={
                    <RequirePermission anyCap={['config.general', 'config.alertas', 'config.mantenimiento']}>
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
