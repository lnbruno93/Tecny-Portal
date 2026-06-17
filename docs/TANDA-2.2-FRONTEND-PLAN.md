# TANDA 2.2 Frontend — Plan de implementación

**Estado al 2026-06-17 02:30 AM:** scaffolds creados, integraciones pendientes.

## Archivos creados (scaffolds — UI a completar)

- `frontend/src/screens/Signup.jsx` — form básico funcional, sin estilos.
- `frontend/src/screens/VerifyEmail.jsx` — flow funcional, sin estilos.
- `frontend/src/components/UnverifiedBanner.jsx` — banner básico.

Los tres están funcionales como esqueleto (compilan + hacen el request correcto al backend), solo falta:
- Polish visual (mirror del split-screen de Login para Signup).
- Manejo de loading/error refinado.
- Integración con AuthContext (helpers nuevos).

## Cambios pendientes para que funcione end-to-end

### 1. `frontend/src/contexts/AuthContext.jsx` — agregar 2 métodos

```js
// Llamado desde Signup.jsx tras recibir { token, user } del backend.
function setAuthFromSignup({ token, user }) {
  localStorage.setItem('token', token);
  setUser(user);
}

// Llamado desde VerifyEmail.jsx tras verificar — refresh el user de /me.
async function refreshUser() {
  const res = await api.get('/auth/me');
  setUser(res);
}

// Exponer en el value del provider:
return (
  <AuthContext.Provider value={{ user, login, logout, setAuthFromSignup, refreshUser }}>
    {children}
  </AuthContext.Provider>
);
```

### 2. `frontend/src/App.jsx` — rutas públicas

Las rutas `/signup` y `/verify-email` deben estar **AFUERA** del `RequireAuth`. Reestructurar:

```jsx
<BrowserRouter>
  <Routes>
    {/* Rutas públicas — accesibles sin login */}
    <Route path="/signup" element={
      <Suspense fallback={<PageLoader />}><Signup /></Suspense>
    } />
    <Route path="/verify-email" element={
      <Suspense fallback={<PageLoader />}><VerifyEmail /></Suspense>
    } />
    <Route path="/login" element={
      <Suspense fallback={<PageLoader />}><Login /></Suspense>
    } />

    {/* Rutas privadas — requieren login */}
    <Route element={
      <RequireAuth>
        <Suspense fallback={<PageLoader />}>
          <Shell />
        </Suspense>
      </RequireAuth>
    }>
      {/* todas las rutas actuales (inicio, cotizador, etc.) */}
    </Route>
  </Routes>
</BrowserRouter>
```

NOTA: Login actualmente vive DENTRO del `<RequireAuth>`. Hay que moverlo afuera. La lógica de "si user existe, redirect a /inicio" la maneja `RequireAuth` (o un useEffect en Login).

### 3. `frontend/src/components/Shell.jsx` (o equivalent layout)

Renderizar `<UnverifiedBanner />` arriba del contenido principal del Shell, sticky.

```jsx
import UnverifiedBanner from './UnverifiedBanner';

// En el render del Shell:
<>
  <Header />
  <UnverifiedBanner />
  <main>{children}</main>
</>
```

### 4. CSS — `frontend/src/styles.css`

Agregar estilos para:
- `.unverified-banner` — fondo warning, padding, layout horizontal con botón a la derecha.
- `#signup-screen` — reusar `.lg-*` del Login (scopear con `.auth-screen` común).
- `#verify-email-screen` — card centrada simple.

### 5. Tests (opcional para MVP)

- `screens/Signup.test.jsx` — render form, submit con valores válidos → mock fetch → setAuthFromSignup llamado.
- `screens/VerifyEmail.test.jsx` — render con ?token=xxx → mock fetch success → muestra ✓.

## Orden recomendado para mañana

1. AuthContext — agregar setAuthFromSignup + refreshUser (15 min).
2. App.jsx — reestructurar rutas (10 min).
3. Signup.jsx — pulir visual mirror Login (30-45 min).
4. VerifyEmail.jsx — pulir visual (15 min).
5. UnverifiedBanner.jsx + integrar en Shell (15 min).
6. CSS + responsive (20 min).
7. Test manual end-to-end con backend staging (10 min).
8. Commit + push + PR (5 min).

**Total estimado: ~2-2.5h focal.**

## Decisiones a confirmar mañana

- ¿Mostrar el banner unverified también en /cotizador y otras pantallas read-only? **Sí** (consistencia).
- ¿Hacer logout automático si el user está unverified y han pasado N días? **No** por ahora — keep simple. Si abuse, lo agregamos.
- ¿Permitir login con email O username? Actualmente login solo username — el signup público usa email. Para signup users, el username se auto-deriva del email (ej: `lucas` para `lucas@example.com`). El user puede loguear con ese username derivado. **OK por ahora** — TANDA 2.3 puede agregar login con email opcional.
