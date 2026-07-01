// Smoke test de la pantalla Equipo (#499).
//
// Cubre:
//   1. Render loading state → carga data → muestra super-admins + invites
//   2. Botón "Revocar" de vos-mismo está disabled con tooltip
//   3. Empty state de invitaciones pendientes cuando no hay ninguna
//   4. Click "Invitar admin" abre el modal (chequeamos placeholder del form)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../../lib/api.js', () => ({
  adminApi: {
    team: {
      list:          vi.fn(),
      invite:        vi.fn(),
      revokeInvite:  vi.fn(),
      resendInvite:  vi.fn(),
      revokeAdmin:   vi.fn(),
    },
    me: vi.fn(),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 1, username: 'lucas.bruno', is_super_admin: true },
  }),
  AuthProvider: ({ children }) => children,
}));

import { adminApi } from '../../lib/api.js';
import Equipo from '../Equipo.jsx';

function renderEquipo() {
  return render(
    <BrowserRouter>
      <Equipo />
    </BrowserRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Equipo', () => {
  it('empty state cuando no hay invites pendientes', async () => {
    adminApi.team.list.mockResolvedValue({
      super_admins: [
        {
          id: 1, username: 'lucas.bruno', email: 'lucas@tecnyapp.com',
          twofa_enabled: true, is_you: true, created_at: '2026-01-01T00:00:00Z',
        },
      ],
      pending_invites: [],
    });

    renderEquipo();

    await waitFor(() => screen.getByText('lucas.bruno'));
    expect(screen.getByText(/no hay invitaciones pendientes/i)).toBeInTheDocument();
    // El único super-admin ve el mensaje de "único" en el subtítulo.
    expect(screen.getByText(/único super-admin/i)).toBeInTheDocument();
  });

  it('renderiza super-admins con badges 2FA y flag "Vos"', async () => {
    adminApi.team.list.mockResolvedValue({
      super_admins: [
        {
          id: 1, username: 'lucas.bruno', email: 'lucas@tecnyapp.com',
          twofa_enabled: true, is_you: true, created_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 2, username: 'partner', email: 'p@tecnyapp.com',
          twofa_enabled: false, is_you: false, created_at: '2026-06-01T00:00:00Z',
        },
      ],
      pending_invites: [],
    });

    renderEquipo();

    await waitFor(() => screen.getByText('lucas.bruno'));
    expect(screen.getByText('partner')).toBeInTheDocument();
    expect(screen.getByText('Vos')).toBeInTheDocument();
    // Uno con 2FA Activo, otro con 2FA Pendiente.
    expect(screen.getByText(/2FA Activo/i)).toBeInTheDocument();
    expect(screen.getByText(/2FA Pendiente/i)).toBeInTheDocument();
  });

  it('el botón Revocar de vos-mismo está deshabilitado', async () => {
    adminApi.team.list.mockResolvedValue({
      super_admins: [
        {
          id: 1, username: 'lucas.bruno', email: 'lucas@tecnyapp.com',
          twofa_enabled: true, is_you: true,
        },
        {
          id: 2, username: 'partner', email: 'p@tecnyapp.com',
          twofa_enabled: true, is_you: false,
        },
      ],
      pending_invites: [],
    });

    renderEquipo();

    await waitFor(() => screen.getByText('lucas.bruno'));
    const revokeMine   = screen.getByLabelText(/revocar super-admin de lucas\.bruno/i);
    const revokeOther  = screen.getByLabelText(/revocar super-admin de partner/i);
    expect(revokeMine).toBeDisabled();
    expect(revokeOther).not.toBeDisabled();
  });

  it('click en "Invitar admin" abre el modal', async () => {
    adminApi.team.list.mockResolvedValue({
      super_admins: [
        { id: 1, username: 'lucas.bruno', email: 'lucas@tecnyapp.com', twofa_enabled: true, is_you: true },
      ],
      pending_invites: [],
    });

    renderEquipo();

    await waitFor(() => screen.getByText('lucas.bruno'));
    fireEvent.click(screen.getByRole('button', { name: /invitar admin/i }));
    // Modal muestra el placeholder del input email.
    expect(screen.getByPlaceholderText(/socio@ejemplo\.com/i)).toBeInTheDocument();
  });

  it('renderiza invitaciones pendientes con botones Reenviar/Revocar', async () => {
    adminApi.team.list.mockResolvedValue({
      super_admins: [
        { id: 1, username: 'lucas.bruno', email: 'l@t.com', twofa_enabled: true, is_you: true },
      ],
      pending_invites: [
        {
          id: 10,
          email: 'pending@t.com',
          nombre: 'Pending Person',
          invited_by_username: 'lucas.bruno',
          invited_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 47 * 3600e3).toISOString(),
        },
      ],
    });

    renderEquipo();

    await waitFor(() => screen.getByText(/pending@t\.com/));
    expect(screen.getByText(/Pending Person/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reenviar/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/revocar invitación de pending@t\.com/i)).toBeInTheDocument();
  });

  it('error al cargar muestra banner', async () => {
    adminApi.team.list.mockRejectedValue(new Error('Sin conexión con el servidor.'));
    renderEquipo();
    await waitFor(() => {
      expect(screen.getByText(/Sin conexión con el servidor/i)).toBeInTheDocument();
    });
  });
});
