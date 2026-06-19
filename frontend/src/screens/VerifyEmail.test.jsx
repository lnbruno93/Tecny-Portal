import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mocks — VerifyEmail usa:
//   - useSearchParams para extraer el token del query string.
//   - useNavigate para redirect a / post-success (2.5s después).
//   - useAuth().refreshUser para re-fetch /me y actualizar email_verified.
//   - auth.verifyEmail de lib/api → POST al backend con el token.
const mockNavigate = vi.fn();
const mockRefreshUser = vi.fn();
const mockVerifyEmail = vi.fn();
let mockToken = 'fake-token-hex-32-chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [{ get: (key) => (key === 'token' ? mockToken : null) }],
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ refreshUser: mockRefreshUser }),
}));

vi.mock('../lib/api', () => ({
  auth: {
    verifyEmail: (...args) => mockVerifyEmail(...args),
  },
}));

import VerifyEmail from './VerifyEmail';

const renderV = () => render(<MemoryRouter><VerifyEmail /></MemoryRouter>);

describe('VerifyEmail — TANDA 2.2 Fase B', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockRefreshUser.mockReset();
    mockVerifyEmail.mockReset();
    mockToken = 'fake-token-hex-32-chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  // Sin afterEach restoreTimers — los tests individuales que usan timers reales
  // ya hacen vi.useRealTimers() al final.

  it('estado inicial loading: muestra "Verificando tu email…" + spinner', async () => {
    // verifyEmail no resuelve, queda en loading.
    mockVerifyEmail.mockImplementation(() => new Promise(() => {}));
    renderV();
    expect(screen.getByText(/verificando tu email/i)).toBeInTheDocument();
    expect(document.querySelector('.auth-spinner')).toBeInTheDocument();
  });

  it('verify exitoso: muestra ✓ + llama refreshUser + redirect a / después de 2.5s', async () => {
    mockVerifyEmail.mockResolvedValue({ ok: true });
    mockRefreshUser.mockResolvedValue(null);
    renderV();

    // Espera el render del estado success.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /listo/i })).toBeInTheDocument();
    });
    expect(mockVerifyEmail).toHaveBeenCalledWith('fake-token-hex-32-chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(mockRefreshUser).toHaveBeenCalled();

    // Antes de 2.5s, no redirige.
    expect(mockNavigate).not.toHaveBeenCalled();

    // Avanzo el timer 2500ms.
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('error del backend: muestra ✗ + mensaje + link a /', async () => {
    mockVerifyEmail.mockRejectedValue(new Error('Token expirado o ya usado'));
    renderV();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /no se pudo verificar/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/token expirado o ya usado/i)).toBeInTheDocument();
    // CTA fallback: link "Iniciá sesión" → /
    expect(screen.getByRole('link', { name: /iniciá sesión/i })).toHaveAttribute('href', '/');
    // No navega automáticamente en error.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('error con reason="already_used": muestra estado amistoso (✓) + redirect', async () => {
    // Backend devuelve 400 con reason='already_used' cuando el user clickea
    // el mismo link 2 veces. UX TANDA 2.2 Fase B: lo tratamos como info, no
    // error — el email YA está verificado.
    const err = new Error('Este email ya fue verificado. Podés iniciar sesión.');
    err.responseBody = { error: err.message, reason: 'already_used' };
    err.status = 400;
    mockVerifyEmail.mockRejectedValue(err);
    renderV();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /ya estaba verificado/i })).toBeInTheDocument();
    });
    // Tiene el ícono verde (--ok), NO el rojo (--err).
    expect(document.querySelector('.auth-card-icon--ok')).toBeInTheDocument();
    expect(document.querySelector('.auth-card-icon--err')).not.toBeInTheDocument();

    // Igual que success: redirige a / después de 2.5s.
    expect(mockNavigate).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('sin token en URL: muestra error específico sin llamar al backend', async () => {
    mockToken = null;
    renderV();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /no se pudo verificar/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/no incluye token/i)).toBeInTheDocument();
    expect(mockVerifyEmail).not.toHaveBeenCalled();
  });
});
