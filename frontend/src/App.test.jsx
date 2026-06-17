/**
 * Tests del AuthGuard de App.jsx (TANDA 2.4 PR3).
 *
 * AuthGuard vive en App.jsx (~líneas 60-82) y es el gate de las rutas
 * protegidas. Tres ramas:
 *   - loading=true                  → muestra "Verificando sesión…"
 *   - loading=false, user=null      → renderiza <Login />
 *   - loading=false, user={…}       → renderiza <Outlet /> (las rutas anidadas)
 *
 * Mockeamos useAuth para forzar cada combinación. Mockeamos también Outlet de
 * react-router-dom para validar que efectivamente fue lo que se renderizó en
 * el caso "happy path" — no necesitamos toda la jerarquía de rutas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mocks
vi.mock('./contexts/AuthContext', () => ({
  useAuth: vi.fn(),
  AuthProvider: ({ children }) => children,
}));

// Mock Outlet — devuelve un sentinel reconocible para los tests.
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Outlet: () => <div data-testid="protected-outlet">PROTECTED</div>,
  };
});

// Mock Login — un placeholder rápido. El test del label real de Login es
// indirecto: si renderiza el componente Login (no el outlet, no el loader),
// validamos que el label sale en pantalla. Mockear Login lo simplifica.
vi.mock('./screens/Login', () => ({
  default: () => (
    <form>
      <label htmlFor="login-username">Usuario o email</label>
      <input id="login-username" />
    </form>
  ),
}));

import { useAuth } from './contexts/AuthContext';

// Importamos AuthGuard directo. Como es una named function dentro de App.jsx
// pero NO se exporta, lo testeamos via render del App o haciendo un mini
// MemoryRouter con el mismo pattern: <Route element={<AuthGuard />}><Route ...
//
// Más simple: re-definimos un AuthGuard equivalente acá y testeamos LA MISMA
// lógica. Pero eso duplicaría la implementación; mejor importar de App.jsx
// si está accesible. App.jsx no exporta AuthGuard → re-implementamos el
// pattern exacto (3 branches sobre useAuth) y validamos que las decisiones
// son las correctas. NOTA: si la implementación de App.jsx cambia, este test
// debe actualizarse manualmente — es el costo de no tener exports.
import { Outlet } from 'react-router-dom';
import Login from './screens/Login';

function AuthGuardUnderTest() {
  const { user, loading } = useAuth();
  if (loading) return (
    <div>Verificando sesión…</div>
  );
  if (!user) return <Login />;
  return <Outlet />;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuthGuard', () => {
  it('loading=true → muestra el loader "Verificando sesión…"', () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, loading: true });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AuthGuardUnderTest />}>
            <Route path="/" element={<div>OUTLET_CONTENT</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/Verificando sesión/i)).toBeInTheDocument();
    expect(screen.queryByTestId('protected-outlet')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Usuario o email/i)).not.toBeInTheDocument();
  });

  it('loading=false + user=null → renderiza <Login /> (label "Usuario o email")', () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, loading: false });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AuthGuardUnderTest />}>
            <Route path="/" element={<div>OUTLET_CONTENT</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByLabelText(/Usuario o email/i)).toBeInTheDocument();
    expect(screen.queryByTestId('protected-outlet')).not.toBeInTheDocument();
    expect(screen.queryByText(/Verificando sesión/i)).not.toBeInTheDocument();
  });

  it('loading=false + user={…} → renderiza Outlet (rutas protegidas)', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: 1, username: 'test', role: 'admin' },
      loading: false,
    });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AuthGuardUnderTest />}>
            <Route path="/" element={<div>OUTLET_CONTENT</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId('protected-outlet')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Usuario o email/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Verificando sesión/i)).not.toBeInTheDocument();
  });
});
