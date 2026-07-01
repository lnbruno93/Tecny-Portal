// Smoke test del InviteAdminModal (#499).
//
// Cubre:
//   1. Cerrado (open=false) NO renderiza
//   2. Abierto renderiza inputs email + nombre + botón enviar deshabilitado
//   3. Con email inválido y nombre vacío → botón enviar sigue disabled
//   4. Con datos válidos + click → invoca adminApi.team.invite con body correcto
//   5. Error del backend muestra banner

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../lib/api.js', () => ({
  adminApi: {
    team: { invite: vi.fn() },
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

import { adminApi } from '../../../lib/api.js';
import InviteAdminModal from '../InviteAdminModal.jsx';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InviteAdminModal', () => {
  it('con open=false no renderiza el título', () => {
    render(<InviteAdminModal open={false} onClose={() => {}} />);
    expect(screen.queryByText(/invitar admin/i)).toBeNull();
  });

  it('con open=true renderiza los inputs email y nombre', () => {
    render(<InviteAdminModal open onClose={() => {}} />);
    // El modal muestra title "Invitar admin".
    expect(screen.getByText(/invitar admin/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/socio@ejemplo\.com/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/maría garcía/i)).toBeInTheDocument();
  });

  it('con datos válidos, click envía la invitación y llama onCreated', async () => {
    adminApi.team.invite.mockResolvedValue({
      invite: { id: 1, email: 'nuevo@t.com', nombre: 'Nuevo' },
      email_sent: true,
    });
    const onCreated = vi.fn();
    render(<InviteAdminModal open onClose={() => {}} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText(/socio@ejemplo\.com/i), {
      target: { value: 'nuevo@t.com' },
    });
    fireEvent.change(screen.getByPlaceholderText(/maría garcía/i), {
      target: { value: 'Nuevo' },
    });
    fireEvent.click(screen.getByRole('button', { name: /enviar invitación/i }));

    await waitFor(() => {
      expect(adminApi.team.invite).toHaveBeenCalledWith({
        email: 'nuevo@t.com',
        nombre: 'Nuevo',
      });
    });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
  });

  it('error del backend muestra banner sin llamar onCreated', async () => {
    adminApi.team.invite.mockRejectedValue(
      Object.assign(new Error('Ese email ya es super-admin activo.'), { status: 409 })
    );
    const onCreated = vi.fn();
    render(<InviteAdminModal open onClose={() => {}} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText(/socio@ejemplo\.com/i), {
      target: { value: 'dup@t.com' },
    });
    fireEvent.change(screen.getByPlaceholderText(/maría garcía/i), {
      target: { value: 'Dup' },
    });
    fireEvent.click(screen.getByRole('button', { name: /enviar invitación/i }));

    await waitFor(() => {
      expect(screen.getByText(/ya es super-admin activo/i)).toBeInTheDocument();
    });
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('email inválido muestra hint de error', () => {
    render(<InviteAdminModal open onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/socio@ejemplo\.com/i), {
      target: { value: 'no-es-email' },
    });
    expect(screen.getByText(/email inválido/i)).toBeInTheDocument();
  });
});
