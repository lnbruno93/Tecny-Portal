// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Login from '../Login.jsx';
import { AuthProvider } from '../../contexts/AuthContext.jsx';
import * as apiModule from '../../lib/api.js';

// Helper: render con providers necesarios.
function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Login />
      </AuthProvider>
    </MemoryRouter>
  );
}

describe('Login', () => {
  beforeEach(() => {
    // Limpiamos localStorage para que AuthProvider arranque sin sesión cacheada.
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renderiza el formulario con campos de usuario y contraseña', () => {
    renderLogin();
    expect(screen.getByLabelText(/usuario o email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/contraseña/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ingresar/i })).toBeInTheDocument();
  });

  it('muestra error si el user logueado NO es super-admin', async () => {
    // Mock del endpoint login devolviendo un user normal (no super-admin).
    vi.spyOn(apiModule.adminApi, 'login').mockResolvedValue({
      token: 'fake-jwt',
      user: { id: 1, username: 'normal', email: 'a@b.com', is_super_admin: false },
    });

    renderLogin();
    fireEvent.change(screen.getByLabelText(/usuario o email/i), { target: { value: 'normal' } });
    fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/solo para super-admins/i);
    // Confirmamos que NO se guardó el token (gate de seguridad client-side).
    expect(localStorage.getItem('admin_token')).toBeNull();
  });

  it('muestra error específico si las credenciales son inválidas (401)', async () => {
    const err = new Error('Usuario o contraseña incorrectos');
    err.status = 401;
    vi.spyOn(apiModule.adminApi, 'login').mockRejectedValue(err);

    renderLogin();
    fireEvent.change(screen.getByLabelText(/usuario o email/i), { target: { value: 'bad' } });
    fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/incorrectos/i);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /ingresar/i })).not.toBeDisabled();
    });
  });
});
