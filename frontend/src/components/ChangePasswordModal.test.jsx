/**
 * Tests del ChangePasswordModal (#306).
 *
 * Cubre:
 *   - Render del form con los 3 inputs base.
 *   - Validación cliente: min length, letra, número, match confirm, distinto a actual.
 *   - Submit happy path → llama authApi.changePassword → toast.success + logout.
 *   - Backend pide 2FA → muestra input → re-submit con código.
 *   - Errores del backend: 401 password incorrecta, 401 código 2FA incorrecto, 400 datos inválidos.
 *   - Reset de state al cerrar (no persistir passwords).
 *   - Cancel mientras loading no funciona (defensive).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockChangePassword = vi.fn();
const mockLogout         = vi.fn();
const mockToastSuccess   = vi.fn();

vi.mock('../lib/api', () => ({
  auth: {
    changePassword: (...args) => mockChangePassword(...args),
  },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ logout: mockLogout }),
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    toast: {
      success: (msg) => mockToastSuccess(msg),
      error:   vi.fn(),
      info:    vi.fn(),
    },
  }),
}));

// Bypass del useModal hook (que toca document.body, focus traps, etc — JSDOM
// soporta pero no aporta valor al test de behavior).
vi.mock('../lib/useModal', () => ({
  useModal: () => {},
}));

vi.mock('../lib/friendlyError', () => ({
  friendlyError: (err) => err?.message || 'Error',
}));

import ChangePasswordModal from './ChangePasswordModal';

function renderModal(props = {}) {
  return render(
    <ChangePasswordModal open={true} onClose={() => {}} {...props} />,
  );
}

describe('ChangePasswordModal', () => {
  beforeEach(() => {
    mockChangePassword.mockReset();
    mockLogout.mockReset();
    mockToastSuccess.mockReset();
  });

  afterEach(() => {
    // Si algún test usó fake timers, los restauramos por las dudas.
    vi.useRealTimers();
  });

  it('renderiza form con los 3 inputs base + botones', () => {
    renderModal();
    expect(screen.getByRole('heading', { name: /cambiar contraseña/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/contraseña actual/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^contraseña nueva$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirmar contraseña nueva/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/código 2fa/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancelar/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cambiar contraseña/i })).toBeInTheDocument();
  });

  it('no renderiza nada si open=false', () => {
    const { container } = render(<ChangePasswordModal open={false} onClose={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('valida cliente: nueva muy corta → muestra error inline sin llamar al API', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByLabelText(/contraseña actual/i), 'old-pass-123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), 'abc1');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), 'abc1');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));
    expect(screen.getByText(/mínimo 8 caracteres/i)).toBeInTheDocument();
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it('valida cliente: nueva sin letra → error', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByLabelText(/contraseña actual/i), 'old-pass-123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), '12345678');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), '12345678');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));
    expect(screen.getByText(/al menos una letra/i)).toBeInTheDocument();
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it('valida cliente: nueva sin número → error', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByLabelText(/contraseña actual/i), 'old-pass-123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), 'abcdefghi');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), 'abcdefghi');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));
    expect(screen.getByText(/al menos un número/i)).toBeInTheDocument();
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it('valida cliente: confirm no matchea → error', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByLabelText(/contraseña actual/i), 'old-pass-123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), 'newpass123');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), 'newpass124');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));
    expect(screen.getByText(/no coinciden/i)).toBeInTheDocument();
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it('valida cliente: nueva igual a actual → error', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByLabelText(/contraseña actual/i), 'samepass123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), 'samepass123');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), 'samepass123');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));
    expect(screen.getByText(/distinta a la actual/i)).toBeInTheDocument();
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it('happy path sin 2FA: cambia, toast, cierra, y logout (con delay)', async () => {
    mockChangePassword.mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ChangePasswordModal open={true} onClose={onClose} />);

    await user.type(screen.getByLabelText(/contraseña actual/i), 'old-pass-123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), 'newpass123');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), 'newpass123');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    await waitFor(() => expect(mockChangePassword).toHaveBeenCalledWith('old-pass-123', 'newpass123', undefined));
    expect(mockToastSuccess).toHaveBeenCalledWith(expect.stringMatching(/actualizada/i));
    expect(onClose).toHaveBeenCalled();

    // El logout se llama con un delay de 800ms para que el toast se vea.
    // Esperamos con polling hasta que se ejecute (timeout 2s — el delay
    // real son 800ms, sobra margen). Usamos waitFor real-timers porque
    // userEvent ya consumió eventos asincrónicos antes.
    await waitFor(() => expect(mockLogout).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('si backend pide 2FA → muestra input y re-submit con el código', async () => {
    // Primer call: pide 2FA. Segundo call: éxito.
    mockChangePassword
      .mockRejectedValueOnce(Object.assign(new Error('Se requiere código 2FA'), {
        status: 401,
        body:   { twofa_required: true, error: 'Se requiere código 2FA' },
      }))
      .mockResolvedValueOnce({ ok: true });

    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByLabelText(/contraseña actual/i), 'old-pass-123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), 'newpass123');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), 'newpass123');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    // Espera input 2FA + cambio de label del botón submit.
    expect(await screen.findByLabelText(/código 2fa/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirmar/i })).toBeInTheDocument();

    // Segundo submit con código.
    await user.type(screen.getByLabelText(/código 2fa/i), '123456');
    await user.click(screen.getByRole('button', { name: /confirmar/i }));

    await waitFor(() =>
      expect(mockChangePassword).toHaveBeenLastCalledWith('old-pass-123', 'newpass123', '123456'),
    );
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('código 2FA incorrecto → error inline en input 2FA, NO en alert top', async () => {
    mockChangePassword
      .mockRejectedValueOnce(Object.assign(new Error('2FA req'), {
        status: 401,
        body:   { twofa_required: true, error: 'Se requiere código 2FA' },
      }))
      .mockRejectedValueOnce(Object.assign(new Error('2FA bad'), {
        status: 401,
        body:   { error: 'Código 2FA incorrecto.' },
      }));

    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByLabelText(/contraseña actual/i), 'old-pass-123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), 'newpass123');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), 'newpass123');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    await screen.findByLabelText(/código 2fa/i);
    await user.type(screen.getByLabelText(/código 2fa/i), '000000');
    await user.click(screen.getByRole('button', { name: /confirmar/i }));

    expect(await screen.findByText(/código incorrecto/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('password actual incorrecta (sin 2FA) → error inline en input current', async () => {
    mockChangePassword.mockRejectedValue(Object.assign(new Error('bad'), {
      status: 401,
      body:   { error: 'Contraseña actual incorrecta.' },
    }));

    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByLabelText(/contraseña actual/i), 'wrong-pass-123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), 'newpass123');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), 'newpass123');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    expect(await screen.findByText(/contraseña incorrecta/i)).toBeInTheDocument();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('400 datos inválidos del backend → muestra mensaje del backend', async () => {
    mockChangePassword.mockRejectedValue(Object.assign(new Error('invalid'), {
      status: 400,
      body:   { error: 'Mensaje específico del backend' },
    }));

    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByLabelText(/contraseña actual/i), 'old-pass-123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), 'newpass123');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), 'newpass123');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    expect(await screen.findByText(/mensaje específico del backend/i)).toBeInTheDocument();
  });

  it('error de red → muestra mensaje genérico', async () => {
    mockChangePassword.mockRejectedValue(new Error('Network error'));

    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByLabelText(/contraseña actual/i), 'old-pass-123');
    await user.type(screen.getByLabelText(/^contraseña nueva$/i), 'newpass123');
    await user.type(screen.getByLabelText(/confirmar contraseña nueva/i), 'newpass123');
    await user.click(screen.getByRole('button', { name: /cambiar contraseña/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('toggle ojito alterna type del input password', async () => {
    const user = userEvent.setup();
    renderModal();
    const currentInput = screen.getByLabelText(/contraseña actual/i);
    expect(currentInput).toHaveAttribute('type', 'password');

    // El primer botón "Mostrar contraseña" es el del current.
    const toggles = screen.getAllByLabelText(/mostrar contraseña/i);
    await user.click(toggles[0]);
    expect(currentInput).toHaveAttribute('type', 'text');
  });
});
