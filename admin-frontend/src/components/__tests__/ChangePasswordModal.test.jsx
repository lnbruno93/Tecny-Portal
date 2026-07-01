// Smoke test de ChangePasswordModal (task #498).
//
// Cobertura:
//   1. Render cuando open=true muestra los 3 inputs (current/new/confirm)
//   2. No renderiza contenido cuando open=false
//   3. Validación cliente: passwords que no coinciden muestran error inline
//   4. Éxito llama logout() del AuthContext (con delay — usamos fake timers)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

const mockLogout = vi.fn();

vi.mock('../../lib/api.js', () => ({
  auth: {
    changePassword: vi.fn(),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 1, username: 'lucas', is_super_admin: true },
    logout: mockLogout,
  }),
  AuthProvider: ({ children }) => children,
}));

import { auth } from '../../lib/api.js';
import ChangePasswordModal from '../ChangePasswordModal.jsx';

function renderModal(props = {}) {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  return render(
    <BrowserRouter>
      <ChangePasswordModal {...defaultProps} {...props} />
    </BrowserRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLogout.mockClear();
});

describe('ChangePasswordModal', () => {
  it('cuando open=true renderiza los 3 inputs de password', () => {
    renderModal();
    expect(screen.getByLabelText(/contraseña actual/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^contraseña nueva$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirmar contraseña nueva/i)).toBeInTheDocument();
  });

  it('cuando open=false no renderiza contenido', () => {
    renderModal({ open: false });
    expect(screen.queryByLabelText(/contraseña actual/i)).not.toBeInTheDocument();
  });

  it('muestra error inline si las passwords nuevas no coinciden', async () => {
    renderModal();

    fireEvent.change(screen.getByLabelText(/contraseña actual/i), { target: { value: 'oldPw123' } });
    fireEvent.change(screen.getByLabelText(/^contraseña nueva$/i), { target: { value: 'newPw12345' } });
    fireEvent.change(screen.getByLabelText(/confirmar contraseña nueva/i), { target: { value: 'differentPw' } });

    // Click en "Cambiar contraseña" del footer del modal.
    fireEvent.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    await waitFor(() => {
      expect(screen.getByText(/no coinciden/i)).toBeInTheDocument();
    });
    // El API NO se llama porque la validación cliente cortó antes.
    expect(auth.changePassword).not.toHaveBeenCalled();
  });

  it('llama logout tras un cambio exitoso', async () => {
    // NO usamos fake timers acá: mezclarlos con waitFor de RTL es frágil
    // (RTL corre polling con setTimeout, si los timers están fake el poll
    // nunca dispara y el waitFor cuelga hasta timeout). Con timers reales,
    // el setTimeout(logout, 800) del modal fira solito — waitFor lo cazará.
    auth.changePassword.mockResolvedValue({ ok: true });

    renderModal();

    fireEvent.change(screen.getByLabelText(/contraseña actual/i), { target: { value: 'oldPw123' } });
    fireEvent.change(screen.getByLabelText(/^contraseña nueva$/i), { target: { value: 'newPw12345' } });
    fireEvent.change(screen.getByLabelText(/confirmar contraseña nueva/i), { target: { value: 'newPw12345' } });

    fireEvent.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    await waitFor(() => {
      expect(auth.changePassword).toHaveBeenCalledWith('oldPw123', 'newPw12345', undefined);
    });

    // El logout se dispara con setTimeout(..., 800). waitFor con timeout
    // generoso lo espera.
    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalled();
    }, { timeout: 2000 });
  });
});
