// Smoke tests de ForgotPassword del admin console (2026-07-04).
//
// Cubre los 3 caminos que importa validar:
//   1. Render inicial (título + input email + botón submit).
//   2. Submit exitoso → muestra card anti-enum genérica ("si tiene cuenta").
//      Verifica también que el email pasa al backend normalizado (lowercase+trim).
//   3. Error de red (throw en forgotPassword) → banner de error visible.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

// Mock del módulo api.js. Único método que ForgotPassword necesita es
// auth.forgotPassword — el resto de exports lo dejamos vacío para satisfacer
// el shape que otros módulos podrían importar transitivamente.
vi.mock('../../lib/api.js', () => ({
  auth: {
    forgotPassword: vi.fn(),
  },
  adminApi: {},
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

import { auth } from '../../lib/api.js';
import ForgotPassword from '../ForgotPassword.jsx';

function renderPage() {
  return render(
    <BrowserRouter>
      <ForgotPassword />
    </BrowserRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  try { window.localStorage.clear(); } catch { /* noop */ }
});

describe('ForgotPassword', () => {
  it('renderiza el título, input email y botón submit', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /recuperar contraseña/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mandar link/i })).toBeInTheDocument();
    // Link a login siempre visible.
    expect(screen.getByRole('link', { name: /volver al login/i })).toBeInTheDocument();
  });

  it('submit exitoso muestra card anti-enumeración y normaliza el email', async () => {
    auth.forgotPassword.mockResolvedValue({ ok: true });

    renderPage();
    // Meto un email con mayúsculas + espacios para verificar la normalización.
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: '  Lucas@Tecnyapp.COM  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /mandar link/i }));

    await waitFor(() => {
      // Card genérica anti-enum — no distingue "existe" vs "no existe".
      expect(screen.getByRole('heading', { name: /revisá tu email/i })).toBeInTheDocument();
    });
    // Copy anti-enum: "si TIENE una cuenta de super-admin" (condicional).
    expect(screen.getByText(/tiene una cuenta de super-admin/i)).toBeInTheDocument();
    // El email se muestra normalizado (lowercase + trim).
    expect(screen.getByText('lucas@tecnyapp.com')).toBeInTheDocument();
    // Y se pasó normalizado al backend.
    expect(auth.forgotPassword).toHaveBeenCalledWith('lucas@tecnyapp.com');
  });

  it('error de red muestra banner y mantiene el form', async () => {
    // Simulamos un error tipo "sin conexión" (throw desde el wrapper api()).
    const netErr = new Error('Sin conexión con el servidor. Verificá tu red.');
    auth.forgotPassword.mockRejectedValue(netErr);

    renderPage();
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'test@t.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /mandar link/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/sin conexión/i);
    });
    // NO cambió al estado submitted — el form sigue visible.
    expect(screen.getByRole('button', { name: /mandar link/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /revisá tu email/i })).not.toBeInTheDocument();
  });

  it('error 500 del servidor muestra mensaje específico ("problema del servidor")', async () => {
    const err = new Error('Server error');
    err.status = 500;
    auth.forgotPassword.mockRejectedValue(err);

    renderPage();
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'test@t.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /mandar link/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/problema del servidor/i);
    });
  });
});
