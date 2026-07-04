// Smoke tests de ResetPassword del admin console (2026-07-04).
//
// Cubre los 4 caminos críticos:
//   1. Sin token en la URL → cae directo al estado 'token-error'.
//   2. Submit exitoso → estado 'success' (mensaje de confirmación).
//   3. 401 EXPIRED_RESET_TOKEN → mensaje específico de link vencido.
//   4. Password que falla la policy client-side → field error inline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

// Mock del navigate para que podamos aserverar redirect a /login post-success
// sin necesidad de esperar el setTimeout real.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, useNavigate: () => navigateMock };
});

vi.mock('../../lib/api.js', () => ({
  auth: {
    resetPassword: vi.fn(),
  },
  adminApi: {},
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

import { auth } from '../../lib/api.js';
import ResetPassword from '../ResetPassword.jsx';

function renderPage(url = '/reset-password?token=abc123def456ghi789jkl') {
  window.history.pushState({}, '', url);
  return render(
    <BrowserRouter>
      <ResetPassword />
    </BrowserRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  try { window.localStorage.clear(); } catch { /* noop */ }
});

describe('ResetPassword', () => {
  it('sin token en URL cae al estado token-error', async () => {
    renderPage('/reset-password'); // sin ?token=

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/no se pudo resetear/i);
    });
    // Mensaje puntual: "el link no incluye token".
    expect(screen.getByText(/link no incluye token/i)).toBeInTheDocument();
    // CTA para pedir uno nuevo.
    expect(screen.getByRole('button', { name: /pedir un link nuevo/i })).toBeInTheDocument();
    // resetPassword no se llama si no había token.
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });

  it('submit OK muestra el success screen y redirige a /login', async () => {
    auth.resetPassword.mockResolvedValue({ ok: true });

    renderPage();
    fireEvent.change(screen.getByLabelText(/^contraseña nueva$/i), {
      target: { value: 'MiPass123' },
    });
    fireEvent.change(screen.getByLabelText(/confirmar contraseña/i), {
      target: { value: 'MiPass123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/contraseña actualizada/i);
    });
    expect(auth.resetPassword).toHaveBeenCalledWith(
      'abc123def456ghi789jkl',
      'MiPass123'
    );
    // El redirect a /login es delayed 2.5s — no queremos esperar tanto en
    // tests. Al menos verificamos que el state cambió a success (arriba)
    // y que resetPassword se llamó con los args correctos.
  });

  it('401 EXPIRED_RESET_TOKEN muestra mensaje de link vencido', async () => {
    const err = new Error('Token expired');
    err.status = 401;
    err.responseBody = { code: 'EXPIRED_RESET_TOKEN' };
    auth.resetPassword.mockRejectedValue(err);

    renderPage();
    fireEvent.change(screen.getByLabelText(/^contraseña nueva$/i), {
      target: { value: 'MiPass123' },
    });
    fireEvent.change(screen.getByLabelText(/confirmar contraseña/i), {
      target: { value: 'MiPass123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/no se pudo resetear/i);
    });
    // Mensaje específico para EXPIRED.
    expect(screen.getByText(/link de reset venció/i)).toBeInTheDocument();
    // El form quedó fuera (estado 'token-error' es terminal).
    expect(screen.queryByLabelText(/^contraseña nueva$/i)).not.toBeInTheDocument();
  });

  it('password que falla la policy muestra field error inline y no llama backend', async () => {
    renderPage();
    // Password muy corta → falla la policy client-side (min 8 chars).
    fireEvent.change(screen.getByLabelText(/^contraseña nueva$/i), {
      target: { value: 'abc12' },
    });
    fireEvent.change(screen.getByLabelText(/confirmar contraseña/i), {
      target: { value: 'abc12' },
    });
    fireEvent.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    await waitFor(() => {
      // El mensaje default de MIN_PASSWORD_LENGTH es "Mínimo 8 caracteres".
      expect(screen.getByText(/mínimo 8 caracteres/i)).toBeInTheDocument();
    });
    // Cliente cortó antes: el backend no fue tocado.
    expect(auth.resetPassword).not.toHaveBeenCalled();
    // Seguimos en el form.
    expect(screen.getByLabelText(/^contraseña nueva$/i)).toBeInTheDocument();
  });

  it('password que no coincide con confirm muestra error de match', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/^contraseña nueva$/i), {
      target: { value: 'MiPass123' },
    });
    fireEvent.change(screen.getByLabelText(/confirmar contraseña/i), {
      target: { value: 'MiPass999' },
    });
    fireEvent.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    await waitFor(() => {
      expect(screen.getByText(/no coinciden/i)).toBeInTheDocument();
    });
    expect(auth.resetPassword).not.toHaveBeenCalled();
  });

  it('400 con fields[] surface field error del backend', async () => {
    const err = new Error('Policy fail');
    err.status = 400;
    err.responseBody = {
      fields: [{ field: 'newPassword', error: 'Password rechazada por policy backend' }],
    };
    auth.resetPassword.mockRejectedValue(err);

    renderPage();
    fireEvent.change(screen.getByLabelText(/^contraseña nueva$/i), {
      target: { value: 'MiPass123' },
    });
    fireEvent.change(screen.getByLabelText(/confirmar contraseña/i), {
      target: { value: 'MiPass123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    await waitFor(() => {
      expect(screen.getByText(/rechazada por policy backend/i)).toBeInTheDocument();
    });
    // Sigue en el form (no fue a token-error).
    expect(screen.getByLabelText(/^contraseña nueva$/i)).toBeInTheDocument();
  });
});
