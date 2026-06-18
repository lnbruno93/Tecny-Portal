/**
 * Tests del ResetPassword screen (TANDA 0 #321).
 *
 * Cubre:
 *   - Token ausente en URL → pantalla token-error directa.
 *   - Validación client-side: pass corta, sin letra, sin número, confirm mismatch.
 *   - Happy path: submit → screen success → setTimeout navigate.
 *   - Backend devuelve 401 EXPIRED_RESET_TOKEN → screen token-error con copy expirado.
 *   - Backend devuelve 401 USED_RESET_TOKEN → screen token-error con copy ya-usado.
 *   - Backend devuelve 401 INVALID_RESET_TOKEN → screen token-error con copy genérico.
 *   - Backend devuelve 400 password policy → inline en field newPassword.
 *   - Backend devuelve 500/network → mensaje general en alert.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mockResetPassword = vi.fn();

vi.mock('../lib/api', () => ({
  auth: {
    resetPassword: (...args) => mockResetPassword(...args),
  },
}));

import ResetPassword from './ResetPassword';

// Helper: renderizar con un token-en-URL específico vía MemoryRouter.
function renderRP({ token = 'valid-hex-token-1234567890abcdef1234567890abcdef' } = {}) {
  const initialPath = token ? `/reset-password?token=${token}` : '/reset-password';
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/" element={<div>LOGIN_HOME</div>} />
        <Route path="/forgot-password" element={<div>FORGOT</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const getNew = () => screen.getByLabelText(/contraseña nueva/i);
const getConfirm = () => screen.getByLabelText(/confirmar contraseña/i);
const getSubmit = () => screen.getByRole('button', { name: /cambiar contraseña/i });

describe('ResetPassword', () => {
  beforeEach(() => { mockResetPassword.mockReset(); });

  it('sin token en URL → muestra pantalla token-error', () => {
    renderRP({ token: null });
    expect(screen.getByRole('heading', { name: /no se pudo resetear/i })).toBeInTheDocument();
    expect(screen.getByText(/el link no incluye token/i)).toBeInTheDocument();
  });

  it('valida client: pass < 8 caracteres → error inline + NO llama API', async () => {
    const user = userEvent.setup();
    renderRP();
    await user.type(getNew(), 'abc1');
    await user.type(getConfirm(), 'abc1');
    await user.click(getSubmit());
    expect(screen.getByText(/mínimo 8 caracteres/i)).toBeInTheDocument();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('valida client: pass sin letra → error', async () => {
    const user = userEvent.setup();
    renderRP();
    await user.type(getNew(), '12345678');
    await user.type(getConfirm(), '12345678');
    await user.click(getSubmit());
    expect(screen.getByText(/al menos una letra/i)).toBeInTheDocument();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('valida client: pass sin número → error', async () => {
    const user = userEvent.setup();
    renderRP();
    await user.type(getNew(), 'abcdefgh');
    await user.type(getConfirm(), 'abcdefgh');
    await user.click(getSubmit());
    expect(screen.getByText(/al menos un número/i)).toBeInTheDocument();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('valida client: confirm no matchea → error', async () => {
    const user = userEvent.setup();
    renderRP();
    await user.type(getNew(), 'NuevaPwd123');
    await user.type(getConfirm(), 'OtraPwd456');
    await user.click(getSubmit());
    expect(screen.getByText(/no coinciden/i)).toBeInTheDocument();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('happy path: success screen + redirect después de 2.5s', async () => {
    mockResetPassword.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    renderRP({ token: 'happy-token-123' });
    await user.type(getNew(), 'NuevaPwd123');
    await user.type(getConfirm(), 'NuevaPwd123');
    await user.click(getSubmit());

    await waitFor(() => expect(mockResetPassword)
      .toHaveBeenCalledWith('happy-token-123', 'NuevaPwd123'));

    expect(await screen.findByRole('heading', { name: /contraseña actualizada/i })).toBeInTheDocument();

    // Espera al redirect (2.5s con margen).
    await waitFor(() => expect(screen.getByText('LOGIN_HOME')).toBeInTheDocument(), { timeout: 3500 });
  });

  it('401 EXPIRED_RESET_TOKEN → pantalla error con copy expirado', async () => {
    mockResetPassword.mockRejectedValue(Object.assign(new Error('err'), {
      status: 401,
      responseBody: { error: 'venció', code: 'EXPIRED_RESET_TOKEN' },
    }));

    const user = userEvent.setup();
    renderRP();
    await user.type(getNew(), 'NuevaPwd123');
    await user.type(getConfirm(), 'NuevaPwd123');
    await user.click(getSubmit());

    expect(await screen.findByText(/link de reset venció/i)).toBeInTheDocument();
    // Link a /forgot-password presente.
    expect(screen.getByRole('link', { name: /pedir un link nuevo/i })).toBeInTheDocument();
  });

  it('401 USED_RESET_TOKEN → pantalla error con copy ya-usado', async () => {
    mockResetPassword.mockRejectedValue(Object.assign(new Error('err'), {
      status: 401,
      responseBody: { error: 'usado', code: 'USED_RESET_TOKEN' },
    }));

    const user = userEvent.setup();
    renderRP();
    await user.type(getNew(), 'NuevaPwd123');
    await user.type(getConfirm(), 'NuevaPwd123');
    await user.click(getSubmit());

    expect(await screen.findByText(/este link ya fue usado/i)).toBeInTheDocument();
  });

  it('401 INVALID_RESET_TOKEN → pantalla error genérico de invalidez', async () => {
    mockResetPassword.mockRejectedValue(Object.assign(new Error('err'), {
      status: 401,
      responseBody: { error: 'inválido', code: 'INVALID_RESET_TOKEN' },
    }));

    const user = userEvent.setup();
    renderRP();
    await user.type(getNew(), 'NuevaPwd123');
    await user.type(getConfirm(), 'NuevaPwd123');
    await user.click(getSubmit());

    expect(await screen.findByText(/el link de reset es inválido/i)).toBeInTheDocument();
  });

  it('400 password policy → inline en field newPassword', async () => {
    mockResetPassword.mockRejectedValue(Object.assign(new Error('err'), {
      status: 400,
      responseBody: {
        error: 'Datos inválidos',
        fields: [{ field: 'newPassword', error: 'Backend dice algo específico' }],
      },
    }));

    const user = userEvent.setup();
    renderRP();
    await user.type(getNew(), 'NuevaPwd123');
    await user.type(getConfirm(), 'NuevaPwd123');
    await user.click(getSubmit());

    expect(await screen.findByText(/backend dice algo específico/i)).toBeInTheDocument();
  });

  it('error genérico (500/network) → mensaje en alert', async () => {
    mockResetPassword.mockRejectedValue(new Error('Network down'));

    const user = userEvent.setup();
    renderRP();
    await user.type(getNew(), 'NuevaPwd123');
    await user.type(getConfirm(), 'NuevaPwd123');
    await user.click(getSubmit());

    expect(await screen.findByText(/network down/i)).toBeInTheDocument();
  });
});
