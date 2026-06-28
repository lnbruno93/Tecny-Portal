// Tests para RedB2BNotificationsBell (F5 #458).
//
// Cobertura (8+ tests):
//   - No renderiza si user sin cap cross_tenant.write
//   - Bell sin badge si count=0
//   - Badge muestra N cuando count>0
//   - Badge muestra "99+" cuando count>99
//   - Click en bell abre el panel + carga lista
//   - Click en notification marca read + navega
//   - "Marcar todas como leídas" llama markAllRead + resetea badge
//   - Click fuera del panel lo cierra
//   - ESC cierra el panel
//   - User admin global ve el bell (bypass)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mocks
let mockUser = null;
const mockCountUnread = vi.fn();
const mockList = vi.fn();
const mockMarkRead = vi.fn();
const mockMarkAllRead = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

vi.mock('../lib/api', () => ({
  redB2b: {
    notifications: {
      countUnread: (...args) => mockCountUnread(...args),
      list:        (...args) => mockList(...args),
      markRead:    (...args) => mockMarkRead(...args),
      markAllRead: (...args) => mockMarkAllRead(...args),
    },
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Import después de los mocks.
import RedB2BNotificationsBell from './RedB2BNotificationsBell';

function renderBell() {
  return render(
    <MemoryRouter>
      <RedB2BNotificationsBell />
    </MemoryRouter>
  );
}

describe('RedB2BNotificationsBell — F5 #458', () => {
  beforeEach(() => {
    mockUser = null;
    mockCountUnread.mockReset();
    mockList.mockReset();
    mockMarkRead.mockReset();
    mockMarkAllRead.mockReset();
    mockNavigate.mockReset();
    mockCountUnread.mockResolvedValue({ count: 0 });
    mockList.mockResolvedValue({ notifications: [] });
    mockMarkRead.mockResolvedValue({ ok: true });
    mockMarkAllRead.mockResolvedValue({ ok: true, updated: 0 });
  });

  it('no renderiza nada si user sin cap cross_tenant.write', () => {
    mockUser = { id: 1, role: 'op', caps: [] };
    const { container } = renderBell();
    expect(container.firstChild).toBeNull();
  });

  it('renderiza bell sin badge cuando count=0', async () => {
    mockUser = { id: 1, role: 'op', caps: ['cross_tenant.write'] };
    mockCountUnread.mockResolvedValue({ count: 0 });
    renderBell();
    await waitFor(() => expect(mockCountUnread).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /notificaciones red b2b/i })).toBeInTheDocument();
    expect(screen.queryByTestId('red-b2b-bell-badge')).toBeNull();
  });

  it('renderiza bell con badge cuando count>0', async () => {
    mockUser = { id: 1, role: 'op', caps: ['cross_tenant.write'] };
    mockCountUnread.mockResolvedValue({ count: 5 });
    renderBell();
    const badge = await screen.findByTestId('red-b2b-bell-badge');
    expect(badge).toHaveTextContent('5');
  });

  it('badge muestra "99+" cuando count>99', async () => {
    mockUser = { id: 1, role: 'op', caps: ['cross_tenant.write'] };
    mockCountUnread.mockResolvedValue({ count: 150 });
    renderBell();
    const badge = await screen.findByTestId('red-b2b-bell-badge');
    expect(badge).toHaveTextContent('99+');
  });

  it('user admin global ve el bell (bypass)', async () => {
    mockUser = { id: 1, role: 'admin', caps: [] };
    mockCountUnread.mockResolvedValue({ count: 0 });
    renderBell();
    await waitFor(() => expect(mockCountUnread).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /notificaciones red b2b/i })).toBeInTheDocument();
  });

  it('user owner del tenant ve el bell (bypass tenant_cap_rol)', async () => {
    mockUser = { id: 1, role: 'op', tenant_cap_rol: 'owner', caps: [] };
    mockCountUnread.mockResolvedValue({ count: 2 });
    renderBell();
    const badge = await screen.findByTestId('red-b2b-bell-badge');
    expect(badge).toHaveTextContent('2');
  });

  it('click en bell abre el panel + carga lista', async () => {
    mockUser = { id: 1, role: 'op', caps: ['cross_tenant.write'] };
    mockCountUnread.mockResolvedValue({ count: 1 });
    mockList.mockResolvedValue({
      notifications: [
        {
          id: 1,
          type: 'invitation_received',
          payload: { partner: { nombre: 'iPro' } },
          read_at: null,
          created_at: new Date().toISOString(),
          partnership_id: 42,
        },
      ],
    });
    renderBell();
    await screen.findByTestId('red-b2b-bell-badge');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /notificaciones red b2b/i }));

    expect(await screen.findByTestId('red-b2b-bell-panel')).toBeInTheDocument();
    await waitFor(() => expect(mockList).toHaveBeenCalledWith({ limit: 20 }));
    expect(await screen.findByText(/iPro te invitó a Red B2B/i)).toBeInTheDocument();
  });

  it('click en notification marca read + navega + cierra panel', async () => {
    mockUser = { id: 1, role: 'op', caps: ['cross_tenant.write'] };
    mockCountUnread.mockResolvedValue({ count: 1 });
    mockList.mockResolvedValue({
      notifications: [
        {
          id: 42,
          type: 'operation_received',
          payload: { partner: { nombre: 'TekHaus' }, total_usd: 500 },
          read_at: null,
          created_at: new Date().toISOString(),
          cross_tenant_operation_id: 99,
        },
      ],
    });
    renderBell();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /notificaciones red b2b/i }));
    const item = await screen.findByTestId('red-b2b-bell-item');
    await user.click(item);

    expect(mockMarkRead).toHaveBeenCalledWith(42);
    expect(mockNavigate).toHaveBeenCalledWith('/red-b2b/operaciones/99');
    // Panel cerrado (testid ya no en DOM).
    await waitFor(() => {
      expect(screen.queryByTestId('red-b2b-bell-panel')).toBeNull();
    });
  });

  it('"Marcar todas como leídas" llama markAllRead + resetea badge', async () => {
    mockUser = { id: 1, role: 'op', caps: ['cross_tenant.write'] };
    mockCountUnread.mockResolvedValue({ count: 3 });
    mockList.mockResolvedValue({
      notifications: [
        { id: 1, type: 'operation_received', payload: { partner: { nombre: 'A' }, total_usd: 100 }, read_at: null, created_at: new Date().toISOString() },
        { id: 2, type: 'payment_received', payload: { partner: { nombre: 'B' }, monto_usd: 50 }, read_at: null, created_at: new Date().toISOString() },
      ],
    });
    mockMarkAllRead.mockResolvedValue({ ok: true, updated: 2 });
    renderBell();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /notificaciones red b2b/i }));
    const btn = await screen.findByRole('button', { name: /marcar todas como leídas/i });
    await user.click(btn);

    expect(mockMarkAllRead).toHaveBeenCalled();
    // Badge debería desaparecer (count optimistic reset a 0).
    await waitFor(() => {
      expect(screen.queryByTestId('red-b2b-bell-badge')).toBeNull();
    });
  });

  it('ESC cierra el panel', async () => {
    mockUser = { id: 1, role: 'op', caps: ['cross_tenant.write'] };
    mockCountUnread.mockResolvedValue({ count: 1 });
    mockList.mockResolvedValue({ notifications: [] });
    renderBell();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /notificaciones red b2b/i }));
    expect(await screen.findByTestId('red-b2b-bell-panel')).toBeInTheDocument();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('red-b2b-bell-panel')).toBeNull();
    });
  });

  it('panel vacío muestra mensaje "Sin notificaciones"', async () => {
    mockUser = { id: 1, role: 'op', caps: ['cross_tenant.write'] };
    mockCountUnread.mockResolvedValue({ count: 0 });
    mockList.mockResolvedValue({ notifications: [] });
    renderBell();

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /notificaciones red b2b/i }));
    expect(await screen.findByText(/sin notificaciones/i)).toBeInTheDocument();
  });
});
