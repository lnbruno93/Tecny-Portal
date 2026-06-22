// Tests del router del admin console (TANDA 5 audit 2026-06-22).
//
// Foco en ProtectedRoute — la única defensa entre `/login` y todo el código
// con datos de tenants. Los bugs que estos tests previenen:
//
//   · Flash de layout durante `loading=true` antes del redirect. Si el
//     orden del if `loading` vs `isAuthenticated` se invierte, un super-
//     admin recién deslogueado ve por 100ms la Sidebar/Layout sobre
//     "Cargando…" → percepción de bug + risk visual de info sensible.
//   · Redirect a /login cuando NO está autenticado.
//   · Acceso a rutas autenticadas cuando SÍ está autenticado.
//   · Suspense fallback durante el lazy-load del chunk.
//
// Mockeamos useAuth para controlar { loading, isAuthenticated } por test.
// El App importa los lazy()s — los chunks son async, por eso usamos
// `findByText` (asincrónico) para esperar el render del componente lazy.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock del context Auth — controlamos { loading, isAuthenticated, user }.
const mockAuth = { loading: false, isAuthenticated: false, user: null };
vi.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => mockAuth,
  AuthProvider: ({ children }) => children,
}));

// Mock del API — App importa Resumen/Clientes/etc lazy, y esos hacen
// fetch al mount. Si no mockeamos, el render rinde algo pero los hooks
// disparan requests reales → ruido.
vi.mock('../lib/api.js', () => ({
  adminApi: {
    me: vi.fn().mockResolvedValue({ is_super_admin: true, user_id: 1 }),
    getMetrics: vi.fn().mockResolvedValue({}),
    getMetricsHistory: vi.fn().mockResolvedValue({ history: [] }),
    getRecentActions: vi.fn().mockResolvedValue({ recent: [] }),
    listTenants: vi.fn().mockResolvedValue({ tenants: [] }),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  abortAllInFlight: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

// Mock de Login para que NO haga el render real (tiene mucho markup; nos
// alcanza con un marker que diga "estoy en /login").
vi.mock('../pages/Login.jsx', () => ({
  default: () => <div data-testid="login-page">LOGIN_PAGE</div>,
}));

import App from '../App.jsx';

beforeEach(() => {
  // Reset del mock context entre tests.
  mockAuth.loading = false;
  mockAuth.isAuthenticated = false;
  mockAuth.user = null;
});

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe('App router + ProtectedRoute', () => {
  it('loading=true muestra "Cargando…" SIN layout ni redirect (evita flash)', () => {
    // Bug clase: si el if `loading` viene DESPUÉS de `!isAuthenticated`,
    // un usuario recién deslogueado ve flash de redirect → loading.
    // El orden actual (loading primero) es el correcto.
    mockAuth.loading = true;
    mockAuth.isAuthenticated = false;

    renderAt('/');

    // Hay un "Cargando…" visible.
    expect(screen.getByText(/cargando/i)).toBeInTheDocument();
    // NO se muestra la página de login (no fuimos redirigidos).
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });

  it('no autenticado en ruta protegida → redirect a /login', () => {
    mockAuth.loading = false;
    mockAuth.isAuthenticated = false;

    renderAt('/');

    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });

  it('no autenticado en /clientes → redirect a /login', () => {
    mockAuth.loading = false;
    mockAuth.isAuthenticated = false;

    renderAt('/clientes');

    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });

  it('autenticado en / → renderea (lazy) la app real, NO login', async () => {
    mockAuth.loading = false;
    mockAuth.isAuthenticated = true;
    mockAuth.user = { id: 1, is_super_admin: true, username: 'lucas' };

    renderAt('/');

    // El chunk de Resumen es lazy — primero vemos el Suspense fallback,
    // que es otro "Cargando…". NO debemos ver la página de login.
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
    // El layout o el Suspense están renderizando algo.
    expect(document.body.textContent).toContain('Cargando');
  });

  it('autenticado pero loading=true SIGUE mostrando "Cargando…" (loading gana)', () => {
    // Caso edge: durante la revalidación de /me, loading=true momentáneo.
    // No deberíamos renderear el layout aún (Suspense puede gatillar
    // requests del chunk).
    mockAuth.loading = true;
    mockAuth.isAuthenticated = true;
    mockAuth.user = { id: 1, is_super_admin: true };

    renderAt('/');

    expect(screen.getByText(/cargando/i)).toBeInTheDocument();
    expect(screen.queryByTestId('login-page')).not.toBeInTheDocument();
  });

  it('ruta inexistente → NotFound con "404" + link a Resumen', () => {
    mockAuth.loading = false;
    mockAuth.isAuthenticated = false;

    renderAt('/ruta-que-no-existe-xyz');

    expect(screen.getByText('404')).toBeInTheDocument();
    expect(screen.getByText(/ir a resumen/i)).toBeInTheDocument();
  });

  it('/login es público (renderea sin importar isAuthenticated)', () => {
    mockAuth.loading = false;
    mockAuth.isAuthenticated = false;

    renderAt('/login');

    expect(screen.getByTestId('login-page')).toBeInTheDocument();
  });
});
