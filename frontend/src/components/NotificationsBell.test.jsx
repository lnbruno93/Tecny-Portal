// Tests para NotificationsBell — sucesor de RedB2BNotificationsBell.
//
// Diferencia semántica clave vs el componente viejo:
//   - El bell SIEMPRE se renderiza para users autenticados (antes se
//     ocultaba si el user no tenía cap cross_tenant.write). Motivo: ahora
//     también muestra Novedades (release notes), que son globales sin gate.
//   - El badge suma dos fuentes: Novedades unseen + Red B2B unread.
//   - El dropdown tiene 2 secciones: "Novedades" (siempre) + "Red B2B"
//     (solo si el user tiene la cap).
//
// Cobertura:
//   · No renderiza si user es null (auth aún no resuelta).
//   · Renderiza bell aunque no tenga cap b2b (para mostrar Novedades).
//   · Badge suma novedades + b2b; "99+" si > 99.
//   · Click abre panel; sección Novedades siempre presente; sección
//     Red B2B solo con cap.
//   · Click en novedad → navega a /novedades + emite `release-notes:marked-seen`.
//   · Click en notif b2b → markRead + navega al recurso específico.
//   · "Marcar todo como leído" → llama markSeen + markAllRead + apaga badge.
//   · ESC cierra el panel; click fuera lo cierra.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mocks
let mockUser = null;
const mockCountUnread   = vi.fn();
const mockListB2b       = vi.fn();
const mockMarkRead      = vi.fn();
const mockMarkAllRead   = vi.fn();
const mockCountUnseen   = vi.fn();
const mockListNovedades = vi.fn();
const mockMarkSeen      = vi.fn();
const mockNavigate      = vi.fn();

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

vi.mock('../lib/api', () => ({
  redB2b: {
    notifications: {
      countUnread: (...a) => mockCountUnread(...a),
      list:        (...a) => mockListB2b(...a),
      markRead:    (...a) => mockMarkRead(...a),
      markAllRead: (...a) => mockMarkAllRead(...a),
    },
  },
  releaseNotes: {
    list:        (...a) => mockListNovedades(...a),
    countUnseen: (...a) => mockCountUnseen(...a),
    markSeen:    (...a) => mockMarkSeen(...a),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// Import DESPUÉS de los mocks (patrón vitest).
import NotificationsBell from './NotificationsBell';

function renderBell() {
  return render(
    <MemoryRouter>
      <NotificationsBell />
    </MemoryRouter>
  );
}

describe('NotificationsBell — Novedades + Red B2B unificado', () => {
  beforeEach(() => {
    mockUser = null;
    mockCountUnread.mockReset();
    mockListB2b.mockReset();
    mockMarkRead.mockReset();
    mockMarkAllRead.mockReset();
    mockCountUnseen.mockReset();
    mockListNovedades.mockReset();
    mockMarkSeen.mockReset();
    mockNavigate.mockReset();
    // Defaults sanos.
    mockCountUnread.mockResolvedValue({ count: 0 });
    mockListB2b.mockResolvedValue({ notifications: [] });
    mockMarkRead.mockResolvedValue({ ok: true });
    mockMarkAllRead.mockResolvedValue({ ok: true, updated: 0 });
    mockCountUnseen.mockResolvedValue({ count: 0 });
    mockListNovedades.mockResolvedValue({ release_notes: [] });
    mockMarkSeen.mockResolvedValue({ ok: true });
  });

  it('no renderiza si user es null (auth aún no resuelta)', () => {
    mockUser = null;
    const { container } = renderBell();
    expect(container.firstChild).toBeNull();
  });

  it('renderiza bell aunque el user NO tenga cap b2b (para Novedades)', async () => {
    mockUser = { id: 1, role: 'op', caps: ['ventas.trabajar'] };
    renderBell();
    // El bell button debe estar presente.
    expect(await screen.findByRole('button', { name: /notificaciones/i })).toBeInTheDocument();
  });

  it('badge muestra la suma novedades + b2b', async () => {
    mockUser = { id: 1, role: 'admin', caps: null };
    mockCountUnseen.mockResolvedValue({ count: 2 });
    mockCountUnread.mockResolvedValue({ count: 3 });
    renderBell();
    const badge = await screen.findByTestId('notif-bell-badge');
    expect(badge.textContent).toBe('5');
  });

  it('badge muestra "99+" si el total pasa de 99', async () => {
    mockUser = { id: 1, role: 'admin', caps: null };
    mockCountUnseen.mockResolvedValue({ count: 80 });
    mockCountUnread.mockResolvedValue({ count: 25 });
    renderBell();
    const badge = await screen.findByTestId('notif-bell-badge');
    expect(badge.textContent).toBe('99+');
  });

  it('sin unread no muestra badge', async () => {
    mockUser = { id: 1, role: 'admin', caps: null };
    renderBell();
    // Esperamos a que los fetches iniciales resuelvan.
    await waitFor(() => expect(mockCountUnseen).toHaveBeenCalled());
    expect(screen.queryByTestId('notif-bell-badge')).toBeNull();
  });

  it('user sin cap b2b: dropdown muestra Novedades pero no sección Red B2B', async () => {
    mockUser = { id: 1, role: 'op', caps: ['ventas.trabajar'] };
    mockCountUnseen.mockResolvedValue({ count: 1 });
    mockListNovedades.mockResolvedValue({
      release_notes: [{ id: 10, titulo: 'Nueva feature', tipo: 'feature', publicado_en: new Date().toISOString() }],
    });
    renderBell();
    const btn = await screen.findByRole('button', { name: /notificaciones/i });
    await userEvent.click(btn);
    // Espera que aparezca el panel + la novedad.
    expect(await screen.findByText(/nueva feature/i)).toBeInTheDocument();
    // Y que NO haya llamado al fetch b2b (sin cap).
    expect(mockListB2b).not.toHaveBeenCalled();
  });

  it('user con cap b2b: dropdown muestra ambas secciones', async () => {
    mockUser = { id: 1, role: 'admin', caps: null };
    mockCountUnseen.mockResolvedValue({ count: 0 });
    mockCountUnread.mockResolvedValue({ count: 1 });
    mockListNovedades.mockResolvedValue({ release_notes: [] });
    mockListB2b.mockResolvedValue({
      notifications: [{ id: 5, type: 'invitation_received', payload: { partner: { nombre: 'AcmeCorp' } }, read_at: null, created_at: new Date().toISOString() }],
    });
    renderBell();
    const btn = await screen.findByRole('button', { name: /notificaciones/i });
    await userEvent.click(btn);
    // Ambos fetches deben haberse llamado.
    await waitFor(() => expect(mockListNovedades).toHaveBeenCalled());
    await waitFor(() => expect(mockListB2b).toHaveBeenCalled());
    expect(await screen.findByText(/AcmeCorp te invitó/i)).toBeInTheDocument();
  });

  it('click en novedad navega a /novedades y emite mark-seen', async () => {
    mockUser = { id: 1, role: 'admin', caps: null };
    mockCountUnseen.mockResolvedValue({ count: 1 });
    mockListNovedades.mockResolvedValue({
      release_notes: [{ id: 42, titulo: 'Feature X', tipo: 'feature', publicado_en: new Date().toISOString() }],
    });
    // Espía sobre dispatchEvent para verificar que se emite el evento.
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    renderBell();
    const btn = await screen.findByRole('button', { name: /notificaciones/i });
    await userEvent.click(btn);
    const item = await screen.findByTestId('notif-bell-novedad');
    await userEvent.click(item);
    // Navega a /novedades.
    expect(mockNavigate).toHaveBeenCalledWith('/novedades');
    // Emitió el evento para que el sidebar apague su badge.
    const emitted = dispatchSpy.mock.calls.some(call => call[0]?.type === 'release-notes:marked-seen');
    expect(emitted).toBe(true);
    // Y llamó a markSeen para persistir el estado en el backend.
    expect(mockMarkSeen).toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  it('click en notif b2b marca read individual y navega al recurso', async () => {
    mockUser = { id: 1, role: 'admin', caps: null };
    mockCountUnread.mockResolvedValue({ count: 1 });
    mockListB2b.mockResolvedValue({
      notifications: [{
        id: 7, type: 'operation_received',
        payload: { partner: { nombre: 'Acme' }, total_usd: 500 },
        read_at: null, created_at: new Date().toISOString(),
        cross_tenant_operation_id: 99,
      }],
    });
    renderBell();
    const btn = await screen.findByRole('button', { name: /notificaciones/i });
    await userEvent.click(btn);
    const item = await screen.findByTestId('notif-bell-b2b');
    await userEvent.click(item);
    expect(mockMarkRead).toHaveBeenCalledWith(7);
    expect(mockNavigate).toHaveBeenCalledWith('/red-b2b/operaciones/99');
  });

  it('"Marcar todo como leído" llama a ambos endpoints y apaga el badge', async () => {
    mockUser = { id: 1, role: 'admin', caps: null };
    mockCountUnseen.mockResolvedValue({ count: 2 });
    mockCountUnread.mockResolvedValue({ count: 3 });
    renderBell();
    // Abro el dropdown para que el botón "Marcar todo como leído" aparezca.
    const btn = await screen.findByRole('button', { name: /notificaciones/i });
    await userEvent.click(btn);
    const marcarTodo = await screen.findByText(/marcar todo como leído/i);
    await userEvent.click(marcarTodo);
    // Ambos endpoints se llamaron.
    expect(mockMarkSeen).toHaveBeenCalled();
    expect(mockMarkAllRead).toHaveBeenCalled();
    // Badge desaparece.
    await waitFor(() => expect(screen.queryByTestId('notif-bell-badge')).toBeNull());
  });

  it('ESC cierra el panel', async () => {
    mockUser = { id: 1, role: 'admin', caps: null };
    renderBell();
    const btn = await screen.findByRole('button', { name: /notificaciones/i });
    await userEvent.click(btn);
    expect(await screen.findByTestId('notif-bell-panel')).toBeInTheDocument();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen.queryByTestId('notif-bell-panel')).toBeNull();
  });
});
