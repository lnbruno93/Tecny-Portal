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

  // S-7 regresión (audit 2026-06-22): si backend devuelve 200 con body
  // sin `user` (bug del server o proxy raro), antes mostraba "no es
  // super-admin" — confuso porque el user legítimo no perdió permisos,
  // simplemente la respuesta vino mal. Ahora distinguimos los casos.
  it('respuesta sin data.user → mensaje "Respuesta inválida" (no enum-leak)', async () => {
    adminApi.login.mockResolvedValue({ token: 'X' }); // sin .user

    renderLogin();
    fireEvent.change(screen.getByLabelText(/usuario/i), { target: { value: 'lucas' } });
    fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/respuesta inválida/i);
    });

    const { saveToken } = await import('../../lib/api.js');
    expect(saveToken).not.toHaveBeenCalled();
  });

  it('respuesta sin data.token → mensaje "Respuesta inválida"', async () => {
    adminApi.login.mockResolvedValue({ user: { id: 1, is_super_admin: true } }); // sin .token

    renderLogin();
    fireEvent.change(screen.getByLabelText(/usuario/i), { target: { value: 'lucas' } });
    fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/respuesta inválida/i);
    });
  });

  // 2FA flow — regresión #510 (2026-07-04). Antes: si el backend respondía
  // 401 { twofa_required: true }, el frontend mostraba "Usuario o contraseña
  // incorrectos" (interpretaba el flag como creds mal). Ahora detectamos el
  // flag y mostramos el input de 6 dígitos para completar el login.
  describe('flujo 2FA', () => {
    it('detecta twofa_required y muestra el input de código', async () => {
      const err = new Error('Se requiere código 2FA.');
      err.status = 401;
      err.responseBody = { twofa_required: true, code: 'TWOFA_REQUIRED' };
      adminApi.login.mockRejectedValueOnce(err);

      renderLogin();
      fireEvent.change(screen.getByLabelText(/usuario/i), { target: { value: 'lucas' } });
      fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'ok' } });
      fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

      // Aparece el input de código y desaparece el de password
      await waitFor(() => {
        expect(screen.getByLabelText(/código de 6 dígitos/i)).toBeInTheDocument();
      });
      expect(screen.queryByLabelText(/contraseña/i)).not.toBeInTheDocument();
      // NO se muestra error — el 2FA required no es "creds mal"
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      // Título cambia a "Verificación en dos pasos"
      expect(screen.getByText(/verificación en dos pasos/i)).toBeInTheDocument();
    });

    it('reintenta con code y guarda token si el TOTP es válido', async () => {
      const err = new Error('Se requiere código 2FA.');
      err.status = 401;
      err.responseBody = { twofa_required: true };
      adminApi.login
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({
          token: 'jwt-abc',
          user: { id: 1, username: 'lucas', is_super_admin: true },
        });

      renderLogin();
      fireEvent.change(screen.getByLabelText(/usuario/i), { target: { value: 'lucas' } });
      fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'ok' } });
      fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

      const codeInput = await screen.findByLabelText(/código de 6 dígitos/i);
      fireEvent.change(codeInput, { target: { value: '123456' } });
      fireEvent.click(screen.getByRole('button', { name: /verificar código/i }));

      await waitFor(() => {
        expect(adminApi.login).toHaveBeenCalledTimes(2);
      });
      // La 2da llamada debe incluir el code como 3er argumento
      expect(adminApi.login).toHaveBeenLastCalledWith('lucas', 'ok', '123456');

      const { saveToken } = await import('../../lib/api.js');
      await waitFor(() => expect(saveToken).toHaveBeenCalledWith('jwt-abc'));
    });

    it('código TOTP inválido → mensaje específico (no "usuario/contraseña")', async () => {
      const twofaErr = new Error('Se requiere código 2FA.');
      twofaErr.status = 401;
      twofaErr.responseBody = { twofa_required: true };
      const invalidCodeErr = new Error('Código inválido.');
      invalidCodeErr.status = 401;
      invalidCodeErr.responseBody = { code: 'INVALID_2FA_CODE' }; // sin twofa_required
      adminApi.login
        .mockRejectedValueOnce(twofaErr)
        .mockRejectedValueOnce(invalidCodeErr);

      renderLogin();
      fireEvent.change(screen.getByLabelText(/usuario/i), { target: { value: 'lucas' } });
      fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'ok' } });
      fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

      const codeInput = await screen.findByLabelText(/código de 6 dígitos/i);
      fireEvent.change(codeInput, { target: { value: '999999' } });
      fireEvent.click(screen.getByRole('button', { name: /verificar código/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(/código.*inválido/i);
      });
      // Seguimos en la pantalla de código (no volvió a creds)
      expect(screen.getByLabelText(/código de 6 dígitos/i)).toBeInTheDocument();
    });

    it('botón "Usar otra cuenta" resetea el flujo', async () => {
      const err = new Error('Se requiere código 2FA.');
      err.status = 401;
      err.responseBody = { twofa_required: true };
      adminApi.login.mockRejectedValueOnce(err);

      renderLogin();
      fireEvent.change(screen.getByLabelText(/usuario/i), { target: { value: 'lucas' } });
      fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'ok' } });
      fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

      await screen.findByLabelText(/código de 6 dígitos/i);
      fireEvent.click(screen.getByRole('button', { name: /usar otra cuenta/i }));

      // Volvimos a los inputs de creds
      expect(screen.getByLabelText(/usuario/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/contraseña/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/código de 6 dígitos/i)).not.toBeInTheDocument();
    });

    it('input de código filtra no-dígitos y limita a 6', async () => {
      const err = new Error('2FA');
      err.status = 401;
      err.responseBody = { twofa_required: true };
      adminApi.login.mockRejectedValueOnce(err);

      renderLogin();
      fireEvent.change(screen.getByLabelText(/usuario/i), { target: { value: 'lucas' } });
      fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: 'ok' } });
      fireEvent.click(screen.getByRole('button', { name: /ingresar/i }));

      const codeInput = await screen.findByLabelText(/código de 6 dígitos/i);
      fireEvent.change(codeInput, { target: { value: '12abc34567890' } });
      // Quedan solo los dígitos y máximo 6
      expect(codeInput.value).toBe('123456');
    });
  });
});
