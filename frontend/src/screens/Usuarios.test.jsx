import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock del cliente API antes de importar la pantalla
vi.mock('../lib/api', () => ({
  usuarios: {
    list:   vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { usuarios as usuariosApi } from '../lib/api';
import Usuarios from './Usuarios';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';

function renderUsuarios() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <Usuarios />
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe('Pantalla Usuarios — alta', () => {
  beforeEach(() => {
    usuariosApi.list.mockResolvedValue([]);
    usuariosApi.create.mockReset();
  });

  it('muestra el botón "Nuevo usuario" y abre el modal de alta', async () => {
    renderUsuarios();
    const btn = await screen.findByRole('button', { name: /nuevo usuario/i });
    await userEvent.click(btn);
    expect(screen.getByRole('button', { name: /crear usuario/i })).toBeInTheDocument();
  });

  it('rechaza una contraseña que no cumple la política (sin pegarle al backend)', async () => {
    renderUsuarios();
    await userEvent.click(await screen.findByRole('button', { name: /nuevo usuario/i }));

    await userEvent.type(screen.getByPlaceholderText('Juan Pérez'), 'Test User');
    await userEvent.type(screen.getByPlaceholderText('juanp'), 'testuser');
    await userEvent.type(screen.getByPlaceholderText('••••••••'), 'abc'); // inválida
    await userEvent.click(screen.getByRole('button', { name: /crear usuario/i }));

    expect(await screen.findByText(/contraseña debe tener mínimo 8/i)).toBeInTheDocument();
    expect(usuariosApi.create).not.toHaveBeenCalled();
  });

  it('crea el usuario con datos válidos', async () => {
    usuariosApi.create.mockResolvedValue({ id: 9, nombre: 'Test User', username: 'testuser', role: 'op', perms: {} });
    renderUsuarios();
    await userEvent.click(await screen.findByRole('button', { name: /nuevo usuario/i }));

    await userEvent.type(screen.getByPlaceholderText('Juan Pérez'), 'Test User');
    await userEvent.type(screen.getByPlaceholderText('juanp'), 'testuser');
    await userEvent.type(screen.getByPlaceholderText('••••••••'), 'segura123');
    await userEvent.click(screen.getByRole('button', { name: /crear usuario/i }));

    await waitFor(() => expect(usuariosApi.create).toHaveBeenCalledTimes(1));
    const payload = usuariosApi.create.mock.calls[0][0];
    expect(payload).toMatchObject({ nombre: 'Test User', username: 'testuser', password: 'segura123', role: 'op' });
  });
});
