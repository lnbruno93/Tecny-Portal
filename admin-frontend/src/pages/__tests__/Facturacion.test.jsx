// Tests de Facturación v2 — estado de cuenta real de tenants (task #131).
//
// Cubrimos los escenarios que dan valor real:
//   1. Render feliz: 4 KPIs (MRR / Al día / Vencidos / Trials) + tabla con
//      todos los estados posibles
//   2. Tabs filtran por estado (todos / al_dia / vencidos / trials / suspendidos)
//   3. Empty state cuando el backend devuelve clientes=[]
//   4. Error banner cuando el endpoint falla
//   5. Click en row navega a /clientes/:id
//   6. Trial muestra "Trial hasta {fecha}" en próximo cobro

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../../lib/api.js', () => ({
  adminApi: {
    getFacturacion: vi.fn(),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 1, username: 'lucas.bruno', is_super_admin: true },
  }),
  AuthProvider: ({ children }) => children,
}));

import { adminApi } from '../../lib/api.js';
import Facturacion from '../Facturacion.jsx';

function renderFacturacion() {
  return render(
    <BrowserRouter>
      <Facturacion />
    </BrowserRouter>
  );
}

// Fixture cubriendo los 6 estados posibles + KPIs coherentes.
function happyData() {
  return {
    kpis: {
      mrr_usd: 456,
      total_clientes: 6,
      al_dia_count: 2,
      al_dia_usd: 288,
      vencidos_count: 1,
      vencidos_usd: 89,
      trials_count: 2,
      trials_por_vencer_7d: 1,
      suspendidos_count: 1,
      sin_config_count: 0,
    },
    clientes: [
      {
        id: 10, tenant_id: 10,
        tenant_nombre: 'Vencida SA', plan: 'starter', plan_label: 'Starter',
        monto_usd: 89, fecha_referencia: '2026-06-15T00:00:00Z',
        estado: 'vencida', suspended_reason: null,
      },
      {
        id: 11, tenant_id: 11,
        tenant_nombre: 'Trial Vencido SRL', plan: 'trial', plan_label: 'Trial',
        monto_usd: 0, fecha_referencia: '2026-07-01T00:00:00Z',
        estado: 'trial_vencido', suspended_reason: null,
      },
      {
        id: 12, tenant_id: 12,
        tenant_nombre: 'Trial Vigente SA', plan: 'trial', plan_label: 'Trial',
        monto_usd: 0, fecha_referencia: '2026-07-20T00:00:00Z',
        estado: 'trial', suspended_reason: null,
      },
      {
        id: 13, tenant_id: 13,
        tenant_nombre: 'Cliente Al Dia', plan: 'pro', plan_label: 'Pro',
        monto_usd: 199, fecha_referencia: '2026-08-15T00:00:00Z',
        estado: 'al_dia', suspended_reason: null,
      },
      {
        id: 14, tenant_id: 14,
        tenant_nombre: 'Otro Al Dia', plan: 'starter', plan_label: 'Starter',
        monto_usd: 89, fecha_referencia: '2026-08-10T00:00:00Z',
        estado: 'al_dia', suspended_reason: null,
      },
      {
        id: 15, tenant_id: 15,
        tenant_nombre: 'Suspendida SA', plan: 'pro', plan_label: 'Pro',
        monto_usd: 199, fecha_referencia: null,
        estado: 'suspendida', suspended_reason: 'Falta de pago 60 días',
      },
    ],
  };
}

describe('Pantalla Facturación (admin) — v2 estado de cuenta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateMock.mockClear();
  });

  it('renderiza los 4 KPIs con la semántica nueva y la tabla', async () => {
    adminApi.getFacturacion.mockResolvedValue(happyData());
    renderFacturacion();

    expect(await screen.findByText('Facturación y cobros')).toBeInTheDocument();

    // Los 4 labels de KPI. Casi todos aparecen 2x (KPI + tab con mismo
    // nombre o estado en fila) → usamos getAllByText para todos.
    expect(screen.getByText('MRR')).toBeInTheDocument();
    expect(screen.getAllByText('Al día').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Vencidos').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Trials').length).toBeGreaterThanOrEqual(1);

    // MRR muestra $456.
    await waitFor(() => {
      expect(screen.getByText('$456')).toBeInTheDocument();
    });

    // "6 clientes total" del KPI MRR.
    expect(screen.getByText('6 clientes total')).toBeInTheDocument();

    // KPI Al día: count=2, monto=$288/mes.
    expect(screen.getByText('$288/mes')).toBeInTheDocument();

    // KPI Vencidos: $89 pendiente.
    expect(screen.getByText('$89 pendiente')).toBeInTheDocument();

    // KPI Trials: "1 vencen en 7d" warning.
    expect(screen.getByText('1 vencen en 7d')).toBeInTheDocument();

    // Filas de la tabla — algunos nombres representativos.
    expect(screen.getByText('Vencida SA')).toBeInTheDocument();
    expect(screen.getByText('Cliente Al Dia')).toBeInTheDocument();
    expect(screen.getByText('Suspendida SA')).toBeInTheDocument();

    // Badges de estado — verificamos que aparezcan los distintos labels.
    expect(screen.getByText('Vencida')).toBeInTheDocument();
    expect(screen.getByText('Trial vencido')).toBeInTheDocument();
    expect(screen.getByText('Suspendida')).toBeInTheDocument();
    // "Al día" aparece 2x (KPI label + estados en filas).
    expect(screen.getAllByText('Al día').length).toBeGreaterThanOrEqual(2);
    // "Trial" aparece en KPI y en fila.
    expect(screen.getAllByText('Trial').length).toBeGreaterThanOrEqual(1);
  });

  it('trial muestra "Trial hasta {fecha}" en próximo cobro', async () => {
    adminApi.getFacturacion.mockResolvedValue(happyData());
    renderFacturacion();

    await screen.findByText('Vencida SA');

    // Trial Vigente SA tiene fecha_referencia 2026-07-20 → celda muestra
    // "Trial hasta {fmtDate}". Regex flexible por locale/TZ (puede caer
    // en 19 o 20 según UTC vs America/Argentina).
    expect(screen.getByText(/Trial hasta.*jul.*2026/i)).toBeInTheDocument();
  });

  it('filtra por tab Vencidos (muestra vencida + sin_config)', async () => {
    adminApi.getFacturacion.mockResolvedValue(happyData());
    renderFacturacion();

    await screen.findByText('Vencida SA');

    fireEvent.click(screen.getByRole('tab', { name: 'Vencidos' }));

    // Solo Vencida SA (estado='vencida') aparece; los otros no.
    expect(screen.getByText('Vencida SA')).toBeInTheDocument();
    expect(screen.queryByText('Cliente Al Dia')).not.toBeInTheDocument();
    expect(screen.queryByText('Trial Vigente SA')).not.toBeInTheDocument();
    expect(screen.queryByText('Suspendida SA')).not.toBeInTheDocument();
  });

  it('filtra por tab Trials (muestra ambos: vigente + vencido)', async () => {
    adminApi.getFacturacion.mockResolvedValue(happyData());
    renderFacturacion();

    await screen.findByText('Vencida SA');

    fireEvent.click(screen.getByRole('tab', { name: 'Trials' }));

    expect(screen.getByText('Trial Vencido SRL')).toBeInTheDocument();
    expect(screen.getByText('Trial Vigente SA')).toBeInTheDocument();
    // Los que NO son trials no deben aparecer.
    expect(screen.queryByText('Vencida SA')).not.toBeInTheDocument();
    expect(screen.queryByText('Cliente Al Dia')).not.toBeInTheDocument();
  });

  it('empty state cuando no hay clientes', async () => {
    adminApi.getFacturacion.mockResolvedValue({
      kpis: {
        mrr_usd: 0, total_clientes: 0,
        al_dia_count: 0, al_dia_usd: 0,
        vencidos_count: 0, vencidos_usd: 0,
        trials_count: 0, trials_por_vencer_7d: 0,
        suspendidos_count: 0, sin_config_count: 0,
      },
      clientes: [],
    });
    renderFacturacion();

    await waitFor(() => {
      expect(screen.getByText('Sin clientes todavía.')).toBeInTheDocument();
    });
    // KPI Vencidos "sin vencidos" cuando count=0.
    expect(screen.getByText('sin vencidos')).toBeInTheDocument();
    // KPI Trials "sin urgencias" cuando trials_por_vencer_7d=0.
    expect(screen.getByText('sin urgencias')).toBeInTheDocument();
  });

  it('banner de error si el endpoint falla', async () => {
    adminApi.getFacturacion.mockRejectedValue(new Error('boom'));
    renderFacturacion();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/boom/);
  });

  it('click en fila navega a la ficha del tenant', async () => {
    adminApi.getFacturacion.mockResolvedValue(happyData());
    renderFacturacion();

    const cell = await screen.findByText('Vencida SA');
    fireEvent.click(cell.closest('tr'));

    expect(navigateMock).toHaveBeenCalledWith('/clientes/10');
  });
});
