import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mocks — UnverifiedBanner usa:
//   - useAuth().user → detecta email_verified y muestra/oculta.
//   - auth.resendVerification de lib/api → POST al backend.
let mockUser = null;
const mockResendVerification = vi.fn();

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

vi.mock('../lib/api', () => ({
  auth: {
    resendVerification: (...args) => mockResendVerification(...args),
  },
}));

import UnverifiedBanner from './UnverifiedBanner';

describe('UnverifiedBanner — TANDA 2.2 Fase B', () => {
  beforeEach(() => {
    mockUser = null;
    mockResendVerification.mockReset();
  });

  it('no renderiza nada si no hay user logueado', () => {
    mockUser = null;
    const { container } = render(<UnverifiedBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('no renderiza nada si user.email_verified === true', () => {
    mockUser = { id: 1, email: 'a@b.com', email_verified: true };
    const { container } = render(<UnverifiedBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renderiza banner con el email del user cuando email_verified === false', () => {
    mockUser = { id: 1, email: 'lucas@example.com', email_verified: false };
    render(<UnverifiedBanner />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/verificá tu email/i)).toBeInTheDocument();
    expect(screen.getByText('lucas@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reenviar email/i })).toBeInTheDocument();
  });

  it('click "Reenviar email" llama a auth.resendVerification + muestra success', async () => {
    mockUser = { id: 1, email: 'lucas@example.com', email_verified: false };
    mockResendVerification.mockResolvedValue({ ok: true });
    render(<UnverifiedBanner />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /reenviar email/i }));

    await waitFor(() => expect(mockResendVerification).toHaveBeenCalled());
    expect(await screen.findByText(/email reenviado/i)).toBeInTheDocument();
  });

  it('click Reenviar con error 429 muestra mensaje del backend', async () => {
    mockUser = { id: 1, email: 'lucas@example.com', email_verified: false };
    const err = new Error('Demasiados reenvíos. Esperá 1 hora.');
    err.status = 429;
    mockResendVerification.mockRejectedValue(err);
    render(<UnverifiedBanner />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /reenviar email/i }));

    expect(await screen.findByText(/demasiados reenvíos/i)).toBeInTheDocument();
  });

  it('click "Cerrar" oculta el banner', async () => {
    mockUser = { id: 1, email: 'lucas@example.com', email_verified: false };
    const { container } = render(<UnverifiedBanner />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /ocultar banner/i }));

    // Después del click, el banner ya no se renderiza.
    expect(container.firstChild).toBeNull();
  });

  it('mientras loadea, el botón se deshabilita y cambia texto a "Enviando…"', async () => {
    mockUser = { id: 1, email: 'lucas@example.com', email_verified: false };
    let resolveResend;
    mockResendVerification.mockImplementation(() => new Promise(r => { resolveResend = r; }));
    render(<UnverifiedBanner />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /reenviar email/i }));
    expect(await screen.findByRole('button', { name: /enviando…/i })).toBeDisabled();

    resolveResend({ ok: true });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /reenviar email/i })).not.toBeDisabled();
    });
  });
});
