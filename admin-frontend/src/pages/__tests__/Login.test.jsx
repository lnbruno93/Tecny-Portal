// Tests críticos del Login del admin. Cubrimos los 3 escenarios que
// rompen la seguridad si fallan:
//   1. Render básico (sanity check del wiring)
//   2. Server devuelve user.is_super_admin === false → NO guarda token,
//      muestra mensaje específico. Este es el gate cliente del doble gate.
//   3. Server devuelve 401 → mensaje legible, sin enum-leak.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

// Mockear adminApi ANTES del import de los módulos que lo usan. Vitest
// hoist-ea vi.mock al tope del archivo, pero el factory se evalúa lazy.
vi.mock('../../lib/api.js', () => {
  return {
    adminApi: {
      login: vi.fn(),
      me: vi.fn(),
    },
    getToken: vi.fn(() => null),
    saveToken: vi.fn(),
    clearToken: vi.fn(),
    resolveApiBase: (u) => u || 'http://localhost',
  };
});

// Imports DESPUÉS del mock, así Login y AuthContext reciben el mock.
import { adminApi } from '../../lib/api.js';
import { AuthProvider } from '../../contexts/AuthContext.jsx';
import Login from '../Login.jsx';

function renderLogin() {
  return render(
    <BrowserRouter>
      <AuthProvider>
        <Login />
      </AuthProvider>
    </BrowserRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Limpiar el localStorage entre tests para que un test no contamine
  // al siguiente con state de auth previa.
  try { window.localStorage.clear(); } catch { /* noop */ }
});

describe('Login', () => {
  it('renderiza el formulario con campos y botón', () => {
    renderLogin();
    expect(screen.getByLabelText(/usuario/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/contraseña/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ingresar/i })).toBeInTheDocument();
    expect(screen.getByText(/back-office del saas/i)).toBeInTheDocument();
  });

  it('bloquea login y muestra mensaje cuando el user NO es super-admin', async () => {
    // El backend devuelve un user válido (creds correctas) pero sin el
    // flag is_super_admin. El gate cliente debe cortar acá: ni guarda
    // token ni navega.
    adminApi.login.mockResolvedValue({
      token: 'jwt-xxx',
      user: { id: 5, username: 'lucas', is_super_admin: false },
    });

    renderLogin();
    fireEvent.change(screen.getByLabelText(/usuario/i), { target: { value: 'lucas' } });
    fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'pwd' } });
    fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/solo para super-admins/i);
    });
    // El login fue llamado (intentamos auth) pero el saveToken jamás se
    // dispara — verificamos via el mock importado.
    const { saveToken } = await import('../../lib/api.js');
    expect(saveToken).not.toHaveBeenCalled();
  });

  it('muestra mensaje legible cuando el server responde 401', async () => {
    const err = new Error('Usuario o contraseña incorrectos');
    err.status = 401;
    adminApi.login.mockRejectedValue(err);

    renderLogin();
    fireEvent.change(screen.getByLabelText(/usuario/i), { target: { value: 'lucas' } });
    fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/usuario o contraseña incorrectos/i);
    });
  });
});
