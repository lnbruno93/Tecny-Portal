// Tests de la Ficha de cliente (Sub-fase B.3 #353).
//
// Cubrimos:
//   1. Render básico: nombre, plan, status, stat cards con data real
//   2. Tenant ACTIVO (suspended_at=null): aparece "Suspender", click abre modal
//   3. Tenant SUSPENDIDO: aparece "Reactivar", click abre modal
//   4. Tenant plan='trial': aparece "Extender trial"; plan='pro': NO aparece
//   5. Tab "Actividad" + Seg "Bot" llama getActivity con type='bot'
//   6. 404 → mensaje "Tenant no encontrado" + botón "Volver a clientes"
//
// No cubrimos los modals en detalle acá — tienen sus propios tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

// Mockeamos adminApi antes del import de los módulos que lo usan.
vi.mock('../../lib/api.js', () => ({
  adminApi: {
    getTenant: vi.fn(),
    getActivity: vi.fn(),
    patchTenant: vi.fn(),
    suspendTenant: vi.fn(),
    reactivateTenant: vi.fn(),
    extendTrial: vi.fn(),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

// Mock de react-router-dom: inyectamos useParams con id fijo + useNavigate stub.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useParams: () => ({ id: '12' }),
  };
});

import { adminApi } from '../../lib/api.js';
import Ficha from '../Ficha.jsx';

function renderFicha() {
  return render(
    <BrowserRouter>
      <Ficha />
    </BrowserRouter>
  );
}

// Fixture base: tenant ACTIVO, plan='pro', no suspendido. Cada test
// modifica overrides para cubrir su caso.
function happyTenant(overrides = {}) {
  return {
    id: 12,
    nombre: 'Aurora Mobile',
    slug: 'aurora-mobile',
    plan: 'pro',
    custom_mrr_usd: null,
    suspended_at: null,
    suspended_reason: null,
    trial_until: null,
    created_at: '2026-05-10T00:00:00Z',
    notes: 'Cliente VIP',
    users_count: 7,
    last_venta_at: '2026-06-19T14:22:01.123Z',
    signups_30d: 2,
    mrr_usd: 99,
    recent_admin_actions: [
      {
        id: '9',
        action: 'plan_change',
        before_state: {},
        after_state: {},
        reason: 'upgrade',
        created_at: new Date(Date.now() - 60000).toISOString(),
        super_admin_username: 'lucas',
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockReset();
});

describe('Ficha', () => {
  it('renderiza nombre, plan, status y stat cards con data real', async () => {
    adminApi.getTenant.mockResolvedValue(happyTenant());

    renderFicha();

    await waitFor(() => {
      expect(screen.getByText('Aurora Mobile')).toBeInTheDocument();
    });

    // Plan + status badges
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('Activa')).toBeInTheDocument();

    // Stat card labels
    expect(screen.getByText('MRR')).toBeInTheDocument();
    expect(screen.getByText('Usuarios activos')).toBeInTheDocument();
    expect(screen.getByText('Salud (proxy)')).toBeInTheDocument();
    expect(screen.getByText('Última venta')).toBeInTheDocument();

    // Verifica que llamó al endpoint con id=12.
    expect(adminApi.getTenant).toHaveBeenCalledWith('12');
  });

  it('tenant activo: muestra "Suspender", click abre modal de suspensión', async () => {
    adminApi.getTenant.mockResolvedValue(happyTenant());

    renderFicha();

    const btn = await screen.findByRole('button', { name: /suspender/i });
    expect(btn).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reactivar/i })).not.toBeInTheDocument();

    fireEvent.click(btn);

    // Modal abre con título "Suspender cuenta" (h2 del header)
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: /suspender cuenta/i })).toBeInTheDocument();
  });

  it('tenant suspendido: muestra "Reactivar", click abre modal de reactivación', async () => {
    adminApi.getTenant.mockResolvedValue(happyTenant({
      suspended_at: '2026-06-01T00:00:00Z',
      suspended_reason: 'falta de pago',
    }));

    renderFicha();

    const btn = await screen.findByRole('button', { name: /reactivar/i });
    expect(btn).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^suspender$/i })).not.toBeInTheDocument();

    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: /reactivar cuenta/i })).toBeInTheDocument();
  });

  it('plan trial muestra "Extender trial"; plan pro no lo muestra', async () => {
    // Caso A: plan='pro' → no debe aparecer el botón
    adminApi.getTenant.mockResolvedValueOnce(happyTenant({ plan: 'pro' }));
    const { unmount } = renderFicha();
    await waitFor(() => {
      expect(screen.getByText('Aurora Mobile')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /extender trial/i })).not.toBeInTheDocument();
    unmount();

    // Caso B: plan='trial' + trial_until → SÍ aparece
    adminApi.getTenant.mockResolvedValueOnce(happyTenant({
      plan: 'trial',
      trial_until: '2026-07-15',
    }));
    renderFicha();
    await waitFor(() => {
      expect(screen.getAllByText('Aurora Mobile').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('button', { name: /extender trial/i })).toBeInTheDocument();
  });

  it('tab "Actividad" + Seg "Bot" llama getActivity con type="bot"', async () => {
    adminApi.getTenant.mockResolvedValue(happyTenant());
    adminApi.getActivity.mockResolvedValue({
      type: 'bot',
      summary: { mensajes_total: 0, mensajes_user: 0, conversaciones: 0, ultimo_mensaje: null },
      recent_conversations: [],
    });

    renderFicha();

    await screen.findByText('Aurora Mobile');

    // Click en tab "Actividad"
    fireEvent.click(screen.getByRole('tab', { name: /actividad/i }));

    // Por default arranca en sub-tab 'ventas' → debe llamar getActivity('ventas')
    adminApi.getActivity.mockResolvedValue({ type: 'ventas', items: [] });
    await waitFor(() => {
      expect(adminApi.getActivity).toHaveBeenCalledWith('12', 'ventas', 20);
    });

    // Cambiar a sub-tab Bot
    fireEvent.click(screen.getByRole('tab', { name: /bot/i }));

    await waitFor(() => {
      expect(adminApi.getActivity).toHaveBeenCalledWith('12', 'bot', 20);
    });
  });

  it('getTenant 404 muestra "Tenant no encontrado" + botón "Volver a clientes"', async () => {
    const err = new Error('Tenant not found');
    err.status = 404;
    adminApi.getTenant.mockRejectedValue(err);

    renderFicha();

    await waitFor(() => {
      expect(screen.getByText(/tenant no encontrado/i)).toBeInTheDocument();
    });

    // Hay al menos un botón "Volver a clientes" (puede haber 2 — el del back + el del empty)
    const buttons = screen.getAllByRole('button', { name: /volver a clientes/i });
    expect(buttons.length).toBeGreaterThan(0);

    // Click navega a /clientes
    fireEvent.click(buttons[0]);
    expect(navigateMock).toHaveBeenCalledWith('/clientes');
  });
});
