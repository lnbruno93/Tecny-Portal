// Tests de la pantalla Planes (Sub-fase C.1.3 #353).
//
// Cubrimos los flows críticos que tocan al backend + UX defensiva:
//   1. Render con 4 planes y label correcto por plan
//   2. trial es read-only (input deshabilitado)
//   3. enterprise NO muestra input numérico (placeholder "Sin precio fijo")
//   4. Editar precio de starter activa el estado "dirty" → muestra botones
//   5. Guardar abre confirm modal → confirmar dispara PATCH con price_usd correcto
//   6. Después de PATCH exitoso recarga rows + muestra banner de éxito
//   7. Backend error → banner de error en el modal (NO cierra modal)
//   8. Descartar tira los cambios pendientes (vuelve al valor original)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../../lib/api.js', () => ({
  adminApi: {
    getPlanPrices: vi.fn(),
    updatePlanPrice: vi.fn(),
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
import Planes from '../Planes.jsx';

function renderPlanes() {
  return render(
    <BrowserRouter>
      <Planes />
    </BrowserRouter>
  );
}

function happyPlanPrices(overrides = {}) {
  return {
    plan_prices: [
      { plan: 'trial', price_usd: 0, active: true, notes: 'Trial siempre gratis', updated_at: null, updated_by: null, updated_by_username: null },
      { plan: 'starter', price_usd: 39, active: true, notes: 'Plan inicial', updated_at: '2026-06-22T10:00:00Z', updated_by: 1, updated_by_username: 'lucas.bruno' },
      { plan: 'pro', price_usd: 189, active: true, notes: 'Plan medio', updated_at: '2026-06-22T10:00:00Z', updated_by: 1, updated_by_username: 'lucas.bruno' },
      { plan: 'enterprise', price_usd: null, active: true, notes: 'Custom per-tenant', updated_at: null, updated_by: null, updated_by_username: null },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Planes', () => {
  it('renderiza los 4 planes con label y precio correctos', async () => {
    adminApi.getPlanPrices.mockResolvedValue(happyPlanPrices());

    renderPlanes();

    await waitFor(() => {
      expect(screen.getByText('Trial')).toBeInTheDocument();
    });
    expect(screen.getByText('Starter')).toBeInTheDocument();
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('Enterprise')).toBeInTheDocument();

    // El input de starter debe mostrar el precio del seed (39).
    const starterInput = screen.getByLabelText('Precio del plan starter');
    expect(starterInput.value).toBe('39');
    const proInput = screen.getByLabelText('Precio del plan pro');
    expect(proInput.value).toBe('189');
  });

  it('trial es read-only (input deshabilitado)', async () => {
    adminApi.getPlanPrices.mockResolvedValue(happyPlanPrices());

    renderPlanes();

    await waitFor(() => screen.getByText('Trial'));
    const trialInput = screen.getByLabelText('Precio del plan trial');
    expect(trialInput).toBeDisabled();
    expect(screen.getByText('(no editable)')).toBeInTheDocument();
  });

  it('enterprise no muestra input numérico, sino placeholder', async () => {
    adminApi.getPlanPrices.mockResolvedValue(happyPlanPrices());

    renderPlanes();

    await waitFor(() => screen.getByText('Enterprise'));
    // No hay input numérico labelado para enterprise.
    expect(screen.queryByLabelText('Precio del plan enterprise')).toBeNull();
    expect(screen.getByText('Sin precio fijo')).toBeInTheDocument();
    expect(screen.getByText('(custom per-tenant)')).toBeInTheDocument();
  });

  it('editar starter activa botones Descartar/Guardar', async () => {
    adminApi.getPlanPrices.mockResolvedValue(happyPlanPrices());

    renderPlanes();

    await waitFor(() => screen.getByLabelText('Precio del plan starter'));
    const starterInput = screen.getByLabelText('Precio del plan starter');

    // Antes de editar, no hay botón Guardar visible.
    expect(screen.queryByText('Guardar cambios')).toBeNull();

    fireEvent.change(starterInput, { target: { value: '49' } });

    // Aparece el chip dirty + botones de acción.
    expect(screen.getByText(/cambios sin guardar/)).toBeInTheDocument();
    expect(screen.getByText('Descartar')).toBeInTheDocument();
    expect(screen.getByText('Guardar cambios')).toBeInTheDocument();
  });

  it('Guardar abre confirm modal con summary correcto', async () => {
    adminApi.getPlanPrices.mockResolvedValue(happyPlanPrices());

    renderPlanes();
    await waitFor(() => screen.getByLabelText('Precio del plan starter'));

    const starterInput = screen.getByLabelText('Precio del plan starter');
    fireEvent.change(starterInput, { target: { value: '49' } });
    fireEvent.click(screen.getByText('Guardar cambios'));

    // Modal aparece con título + diff visible.
    expect(screen.getByText('Confirmar cambio de precio')).toBeInTheDocument();
    // El "$39 → $49" se renderiza con strong wraps — buscamos los pedazos.
    expect(screen.getByText(/\$39/)).toBeInTheDocument();
    expect(screen.getByText(/\$49/)).toBeInTheDocument();
  });

  it('confirmar dispara PATCH con price_usd + reason', async () => {
    adminApi.getPlanPrices.mockResolvedValueOnce(happyPlanPrices());
    adminApi.updatePlanPrice.mockResolvedValue({
      plan: 'starter', price_usd: 49, notes: 'Plan inicial', noop: false,
    });
    // Después del PATCH, getPlanPrices se vuelve a llamar para refresh.
    adminApi.getPlanPrices.mockResolvedValueOnce(happyPlanPrices({
      plan_prices: [
        ...happyPlanPrices().plan_prices.filter((p) => p.plan !== 'starter'),
        { plan: 'starter', price_usd: 49, active: true, notes: 'Plan inicial', updated_at: '2026-06-22T11:00:00Z', updated_by: 1, updated_by_username: 'lucas.bruno' },
      ],
    }));

    renderPlanes();
    await waitFor(() => screen.getByLabelText('Precio del plan starter'));

    fireEvent.change(screen.getByLabelText('Precio del plan starter'), { target: { value: '49' } });
    fireEvent.click(screen.getByText('Guardar cambios'));

    // Tipear motivo en el modal.
    fireEvent.change(screen.getByLabelText('Motivo (opcional)'), {
      target: { value: 'ajuste Q3' },
    });
    fireEvent.click(screen.getByText('Confirmar y guardar'));

    await waitFor(() => {
      expect(adminApi.updatePlanPrice).toHaveBeenCalledWith('starter', {
        price_usd: 49,
        reason: 'ajuste Q3',
      });
    });

    // Banner de éxito visible.
    await waitFor(() => {
      expect(screen.getByText(/Starter actualizado correctamente/)).toBeInTheDocument();
    });
  });

  it('error del backend muestra banner en el modal SIN cerrarlo', async () => {
    adminApi.getPlanPrices.mockResolvedValue(happyPlanPrices());
    adminApi.updatePlanPrice.mockRejectedValue(
      Object.assign(new Error('Otro super-admin ya editó este plan, refrescá.'), { status: 409 })
    );

    renderPlanes();
    await waitFor(() => screen.getByLabelText('Precio del plan starter'));

    fireEvent.change(screen.getByLabelText('Precio del plan starter'), { target: { value: '49' } });
    fireEvent.click(screen.getByText('Guardar cambios'));
    fireEvent.click(screen.getByText('Confirmar y guardar'));

    // Modal sigue abierto y muestra el error.
    await waitFor(() => {
      expect(screen.getByText(/Otro super-admin/)).toBeInTheDocument();
    });
    expect(screen.getByText('Confirmar cambio de precio')).toBeInTheDocument();
  });

  it('Descartar tira los cambios y limpia los botones', async () => {
    adminApi.getPlanPrices.mockResolvedValue(happyPlanPrices());

    renderPlanes();
    await waitFor(() => screen.getByLabelText('Precio del plan starter'));

    fireEvent.change(screen.getByLabelText('Precio del plan starter'), { target: { value: '99' } });
    expect(screen.getByText('Descartar')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Descartar'));

    // Vuelven al valor original.
    await waitFor(() => {
      expect(screen.getByLabelText('Precio del plan starter').value).toBe('39');
    });
    expect(screen.queryByText('Descartar')).toBeNull();
    expect(screen.queryByText('Guardar cambios')).toBeNull();
  });

  it('falla GET inicial → banner de error en pantalla', async () => {
    adminApi.getPlanPrices.mockRejectedValue(new Error('Sin conexión con el servidor.'));

    renderPlanes();

    await waitFor(() => {
      expect(screen.getByText(/Sin conexión con el servidor/)).toBeInTheDocument();
    });
  });
});
