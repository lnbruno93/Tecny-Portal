// Smoke test de la pantalla AcceptSuperAdminInvite (#499).
//
// Cubre:
//   1. Verify OK → form password + info del invitador visible
//   2. Verify fail → mensaje "Invitación no válida"
//   3. Sin token en URL → invalid state

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

const navigateMock = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, useNavigate: () => navigateMock };
});

vi.mock('../../lib/api.js', () => ({
  publicInvite: {
    verify: vi.fn(),
    accept: vi.fn(),
  },
  saveToken: vi.fn(),
  getToken: vi.fn(() => null),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
  adminApi: {},
}));

import { publicInvite } from '../../lib/api.js';
import AcceptSuperAdminInvite from '../AcceptSuperAdminInvite.jsx';

function renderPage(url = '/aceptar-invitacion?token=abc123def456ghi789jkl') {
  window.history.pushState({}, '', url);
  return render(
    <BrowserRouter>
      <AcceptSuperAdminInvite />
    </BrowserRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AcceptSuperAdminInvite', () => {
  it('verify OK muestra form password + info del invitador', async () => {
    publicInvite.verify.mockResolvedValue({
      email: 'nuevo@t.com',
      nombre: 'Nuevo',
      invited_by_username: 'lucas.bruno',
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/aceptá tu invitación/i)).toBeInTheDocument();
    });
    // Se muestra quién invitó.
    expect(screen.getByText(/@lucas\.bruno/)).toBeInTheDocument();
    // Se muestra el email del invitado.
    expect(screen.getByText(/nuevo@t\.com/)).toBeInTheDocument();
    // Los 2 inputs de password.
    expect(screen.getByLabelText(/^contraseña$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirmar contraseña/i)).toBeInTheDocument();
  });

  it('verify fail muestra mensaje de "no válida"', async () => {
    publicInvite.verify.mockRejectedValue(Object.assign(new Error('nope'), { status: 404 }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Invitación no válida/i)).toBeInTheDocument();
    });
    // Fallback CTA.
    expect(screen.getByText(/pedile a la persona que te invitó/i)).toBeInTheDocument();
  });

  it('sin token en URL cae al estado invalid', async () => {
    renderPage('/aceptar-invitacion');
    await waitFor(() => {
      expect(screen.getByText(/Invitación no válida/i)).toBeInTheDocument();
    });
    // verify NO se llama si no hay token.
    expect(publicInvite.verify).not.toHaveBeenCalled();
  });
});
