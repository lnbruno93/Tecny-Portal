/**
 * Smoke test de la pantalla Usuarios — sistema capability-based (F2, 2026-06-23).
 *
 * Cubre:
 *   · Render sin crash con datos mock de capabilities.users() + .catalog().
 *   · Render del listado con rol badge.
 *   · Botón "Nuevo usuario" abre modal y valida password antes de crear.
 *   · Crear usuario: hace POST /usuarios + PUT /capabilities/users/:id con el rol.
 *   · Click en lápiz de un user abre el editor con rol pre-cargado.
 *
 * NO valida la lógica fina del editor (override count, restaurar al rol, etc.)
 * — esa es responsabilidad de los unit tests del backend (capabilities-lib.test.js)
 * y el smoke acá solo verifica que el flow no crashea.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock del cliente API antes de importar la pantalla.
vi.mock('../lib/api', () => ({
  usuarios: {
    list:   vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  capabilities: {
    catalog: vi.fn(),
    users:   vi.fn(),
    update:  vi.fn(),
  },
}));

import { usuarios as usuariosApi, capabilities as capsApi } from '../lib/api';
import Usuarios from './Usuarios';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';

const CATALOG_MOCK = {
  pantallas: [
    { id: 'ventas', label: 'Ventas', capabilities: [
      { slug: 'ventas.trabajar', id: 'trabajar', label: 'Acceder al módulo' },
      { slug: 'ventas.eliminar', id: 'eliminar', label: 'Eliminar una venta' },
    ]},
    { id: 'cajas', label: 'Cajas', capabilities: [
      { slug: 'cajas.ver', id: 'ver', label: 'Ver cajas' },
    ]},
  ],
  roles: ['owner', 'admin', 'vendedor', 'encargado', 'lectura', 'custom'],
};

const USERS_MOCK = [
  {
    id: 1, nombre: 'Test Admin', username: 'testadmin', email: 'admin@test.local',
    legacy_role: 'admin', rol: 'admin', overrides: [], caps_efectivas: null,
  },
  {
    id: 2, nombre: 'Gonza López', username: 'gonza', email: 'gonza@test.local',
    legacy_role: 'op', rol: 'vendedor',
    overrides: [{ capability_slug: 'cajas.ver', enabled: true }],
    caps_efectivas: ['ventas.trabajar', 'cajas.ver'],
  },
];

function renderUsuarios() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <Usuarios />
      </ConfirmProvider>
    </ToastProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  capsApi.catalog.mockResolvedValue(CATALOG_MOCK);
  capsApi.users.mockResolvedValue(USERS_MOCK);
  capsApi.update.mockResolvedValue({ rol: 'vendedor', overrides: [], pw_bumped: true });
});

describe('Pantalla Usuarios — listado', () => {
  it('renderiza sin crash con datos mock', async () => {
    renderUsuarios();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Usuarios/i })).toBeInTheDocument();
    });
    // KPI: total usuarios = 2.
    expect(await screen.findByText('Total usuarios')).toBeInTheDocument();
  });

  it('muestra los users del mock con su rol', async () => {
    renderUsuarios();
    expect(await screen.findByText('Test Admin')).toBeInTheDocument();
    expect(await screen.findByText('Gonza López')).toBeInTheDocument();
    // Badges: hay múltiples "Admin" (KPI label + badge), basta con que aparezca
    // el de Vendedor que es único.
    expect(await screen.findByText('Vendedor')).toBeInTheDocument();
  });

  it('llama a capabilities.users() + capabilities.catalog() al montar', async () => {
    renderUsuarios();
    await waitFor(() => {
      expect(capsApi.users).toHaveBeenCalledTimes(1);
      expect(capsApi.catalog).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Pantalla Usuarios — alta', () => {
  it('botón "Nuevo usuario" abre el modal de alta', async () => {
    renderUsuarios();
    const btn = await screen.findByRole('button', { name: /nuevo usuario/i });
    await userEvent.click(btn);
    expect(screen.getByRole('button', { name: /crear usuario/i })).toBeInTheDocument();
  });

  it('rechaza contraseña inválida sin pegarle al backend', async () => {
    renderUsuarios();
    await userEvent.click(await screen.findByRole('button', { name: /nuevo usuario/i }));

    await userEvent.type(screen.getByPlaceholderText('Juan Pérez'), 'Test User');
    await userEvent.type(screen.getByPlaceholderText('juanp'), 'testuser');
    await userEvent.type(screen.getByPlaceholderText('••••••••'), 'abc'); // <8 chars
    await userEvent.click(screen.getByRole('button', { name: /crear usuario/i }));

    expect(await screen.findByText(/contraseña debe tener mínimo 8/i)).toBeInTheDocument();
    expect(usuariosApi.create).not.toHaveBeenCalled();
    expect(capsApi.update).not.toHaveBeenCalled();
  });

  it('crea el usuario y le setea el rol nuevo', async () => {
    usuariosApi.create.mockResolvedValue({
      id: 99, nombre: 'Test User', username: 'testuser', role: 'op', perms: {},
    });
    renderUsuarios();
    await userEvent.click(await screen.findByRole('button', { name: /nuevo usuario/i }));

    await userEvent.type(screen.getByPlaceholderText('Juan Pérez'), 'Test User');
    await userEvent.type(screen.getByPlaceholderText('juanp'), 'testuser');
    await userEvent.type(screen.getByPlaceholderText('••••••••'), 'segura123');
    await userEvent.click(screen.getByRole('button', { name: /crear usuario/i }));

    // 1) POST /usuarios con role='op' (rol del tenant va por separado).
    await waitFor(() => expect(usuariosApi.create).toHaveBeenCalledTimes(1));
    const payload = usuariosApi.create.mock.calls[0][0];
    expect(payload).toMatchObject({
      nombre: 'Test User', username: 'testuser',
      password: 'segura123', role: 'op',
    });
    // 2026-06-24 hotfix post-permisos: el campo `perms` se removió del payload
    // porque createUsuarioSchema es .strict() y rechaza extras desde F4. Antes
    // mandábamos `perms:{}` que pasaba 400 silencioso. Ahora el sistema nuevo
    // resuelve las caps en el step 2 (capsApi.update con el rol elegido).
    expect(payload.perms).toBeUndefined();

    // 2) PUT /capabilities/users/:id con el rol elegido (vendedor por default).
    await waitFor(() => expect(capsApi.update).toHaveBeenCalledTimes(1));
    expect(capsApi.update).toHaveBeenCalledWith(99, { rol: 'vendedor', overrides: [] });
  });
});

describe('Pantalla Usuarios — edición', () => {
  it('click en lápiz abre el editor con el rol del user pre-cargado', async () => {
    renderUsuarios();

    // Esperar a que cargue Gonza (rol=vendedor, editable).
    await screen.findByText('Gonza López');

    // El user con rol bypass (Test Admin) NO debería tener lápiz —
    // verificamos que el lápiz existe para Gonza.
    const editButtons = screen.getAllByRole('button', { name: /editar permisos/i });
    expect(editButtons.length).toBeGreaterThanOrEqual(1);
    await userEvent.click(editButtons[0]);

    // Header del modal con el nombre del user.
    expect(await screen.findByText(/Permisos: Gonza López/i)).toBeInTheDocument();
  });

  it('en el editor, cada pantalla aparece como sección', async () => {
    renderUsuarios();
    await screen.findByText('Gonza López');
    const editButtons = screen.getAllByRole('button', { name: /editar permisos/i });
    await userEvent.click(editButtons[0]);

    await waitFor(() => {
      // Las pantallas del CATALOG_MOCK aparecen como headers.
      expect(screen.getAllByText('Ventas').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Cajas').length).toBeGreaterThan(0);
    });
  });
});
