// Tests del Resumen — pantalla principal del admin.
// Cubrimos los 4 escenarios que tienen valor para detectar regresiones:
//   1. Render básico con todos los KPIs y data feliz
//   2. Nudge de "precios pendientes" cuando los plan_prices están en 0
//   3. Activity feed deriva textos legibles por tipo de action
//   4. Click en row de top tenants navega a /clientes/:id

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

// Mock del adminApi ANTES del import de los módulos que lo usan.
// vi.mock se hoist-ea al tope; el factory se evalúa lazy.
vi.mock('../../lib/api.js', () => ({
  adminApi: {
    getMetrics: vi.fn(),
    getMetricsHistory: vi.fn(),
    getRecentActions: vi.fn(),
    listTenants: vi.fn(),
    me: vi.fn(),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

// Mock de useNavigate — verificamos la llamada en el test de click.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

// Mock de useAuth para devolver un user con username, sin tener que
// montar el flujo real de /me (más simple y aislado).
vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: { id: 1, username: 'lucas.bruno', is_super_admin: true },
  }),
  AuthProvider: ({ children }) => children,
}));

import { adminApi } from '../../lib/api.js';
import Resumen from '../Resumen.jsx';

function renderResumen() {
  return render(
    <BrowserRouter>
      <Resumen />
    </BrowserRouter>
  );
}

// Fixtures de los 4 endpoints. Default "feliz": data realista pero
// pequeña, con precios > 0 para no disparar el nudge salvo donde
// el test lo necesita.
function happyMetrics(overrides = {}) {
  return {
    mrr_total_usd: 1051,
    tenants_active: 12,
    tenants_trial: 2,
    tenants_suspended: 1,
    signups_7d: 3,
    signups_30d: 5,
    churn_30d: 1,
    conversion_trial_paid_30d: 23.5,
    plan_prices_usd: { trial: 0, starter: 49, pro: 99, enterprise: 0 },
    tenants_by_plan: [
      { plan: 'pro', count: 3, mrr_usd: 297 },
      { plan: 'starter', count: 8, mrr_usd: 392 },
      { plan: 'trial', count: 2, mrr_usd: 0 },
      { plan: 'enterprise', count: 0, mrr_usd: 0 },
    ],
    ...overrides,
  };
}

function happyHistory() {
  // 90 días con valores chicos. El chart debe renderizar 90 columnas.
  // mrr_usd: serie creciente de $500 a $1050 (#451) — el sparkbar pinta
  // los últimos 30 días en la KPI MRR.
  const items = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    items.push({
      date: d.toISOString().slice(0, 10),
      signups: i % 7 === 0 ? 1 : 0,
      suspensions: i % 15 === 0 ? 1 : 0,
      // MRR crece 5/día → de $500 a $945 a lo largo de los 90 días.
      mrr_usd: 500 + (89 - i) * 5,
    });
  }
  return { history: items };
}

function happyActions() {
  return {
    recent_actions: [
      {
        id: '9',
        tenant_id: 12, tenant_nombre: 'Aurora Mobile', tenant_slug: 'aurora-mobile',
        action: 'suspend',
        reason: 'test seed B.1 — más reciente',
        created_at: new Date(Date.now() - 60000).toISOString(),
        super_admin_username: 'lucas',
      },
      {
        id: '8',
        tenant_id: 5, tenant_nombre: 'Boreal SaaS', tenant_slug: 'boreal',
        action: 'reactivate',
        reason: null,
        created_at: new Date(Date.now() - 3600000).toISOString(),
        super_admin_username: 'lucas',
      },
      {
        id: '7',
        tenant_id: 8, tenant_nombre: 'Cumbre Tech', tenant_slug: 'cumbre',
        action: 'trial_extend',
        reason: '7 días',
        created_at: new Date(Date.now() - 86400000).toISOString(),
        super_admin_username: 'lucas',
      },
    ],
  };
}

function happyTenants() {
  return [
    {
      id: 12, nombre: 'Aurora Mobile', slug: 'aurora-mobile', plan: 'pro',
      custom_mrr_usd: null, suspended_at: null, suspended_reason: null,
      trial_until: null, created_at: '2026-05-10T00:00:00Z', notes: null,
      users_count: 7, last_venta_at: '2026-06-19T14:22:01.123Z',
      signups_30d: 2, mrr_usd: 99,
    },
    {
      id: 5, nombre: 'Boreal SaaS', slug: 'boreal', plan: 'starter',
      custom_mrr_usd: null, suspended_at: null, suspended_reason: null,
      trial_until: null, created_at: '2026-04-01T00:00:00Z', notes: null,
      users_count: 5, last_venta_at: '2026-06-15T10:00:00Z',
      signups_30d: 0, mrr_usd: 49,
    },
    {
      id: 8, nombre: 'Cumbre Tech', slug: 'cumbre', plan: 'starter',
      custom_mrr_usd: null, suspended_at: null, suspended_reason: null,
      trial_until: null, created_at: '2026-03-01T00:00:00Z', notes: null,
      users_count: 3, last_venta_at: null,
      signups_30d: 0, mrr_usd: 49,
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Resetear el navigate mock cada test
  navigateMock.mockReset();
});

describe('Resumen', () => {
  it('renderiza saludo, KPIs y secciones con data real', async () => {
    adminApi.getMetrics.mockResolvedValue(happyMetrics());
    adminApi.getMetricsHistory.mockResolvedValue(happyHistory());
    adminApi.getRecentActions.mockResolvedValue(happyActions());
    adminApi.listTenants.mockResolvedValue(happyTenants());

    renderResumen();

    // Saludo deriva "Lucas" de "lucas.bruno"
    expect(screen.getByText(/hola, lucas/i)).toBeInTheDocument();

    // Esperamos a que la promesa resuelva y se renderice el subtítulo
    await waitFor(() => {
      expect(screen.getByText(/12 empresas suscriptas/i)).toBeInTheDocument();
    });

    // Los 6 KPIs por label
    expect(screen.getByText('MRR')).toBeInTheDocument();
    expect(screen.getByText('Clientes activos')).toBeInTheDocument();
    expect(screen.getByText('ARPA')).toBeInTheDocument();
    expect(screen.getByText('Churn (30d)')).toBeInTheDocument();
    expect(screen.getByText('Nuevos (mes)')).toBeInTheDocument();
    expect(screen.getByText('Trials activos')).toBeInTheDocument();

    // Card "Distribución por plan" se renderiza con totales reales
    expect(screen.getByText('Distribución por plan')).toBeInTheDocument();
    expect(screen.getByText(/MRR total/i)).toBeInTheDocument();
  });

  it('muestra el nudge "precios pendientes" si todos los plan_prices son 0', async () => {
    adminApi.getMetrics.mockResolvedValue(happyMetrics({
      plan_prices_usd: { trial: 0, starter: 0, pro: 0, enterprise: 0 },
    }));
    adminApi.getMetricsHistory.mockResolvedValue(happyHistory());
    adminApi.getRecentActions.mockResolvedValue(happyActions());
    adminApi.listTenants.mockResolvedValue(happyTenants());

    renderResumen();

    await waitFor(() => {
      expect(screen.getByText(/precios pendientes de configurar/i)).toBeInTheDocument();
    });
  });

  it('activity feed deriva textos legibles según action', async () => {
    adminApi.getMetrics.mockResolvedValue(happyMetrics());
    adminApi.getMetricsHistory.mockResolvedValue(happyHistory());
    adminApi.getRecentActions.mockResolvedValue(happyActions());
    adminApi.listTenants.mockResolvedValue(happyTenants());

    renderResumen();

    // Esperar al render del feed y verificar verbos derivados
    await waitFor(() => {
      expect(screen.getByText(/lucas suspendió aurora mobile/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/lucas reactivó boreal saas/i)).toBeInTheDocument();
    expect(screen.getByText(/lucas extendió trial de cumbre tech/i)).toBeInTheDocument();
  });

  it('renderiza sparkbar de MRR (#451) cuando hay history con mrr_usd', async () => {
    adminApi.getMetrics.mockResolvedValue(happyMetrics());
    adminApi.getMetricsHistory.mockResolvedValue(happyHistory());
    adminApi.getRecentActions.mockResolvedValue(happyActions());
    adminApi.listTenants.mockResolvedValue(happyTenants());

    renderResumen();

    // El sparkbar tiene role="img" con aria-label específico.
    const spark = await screen.findByRole('img', { name: /MRR últimos \d+ días/i });
    expect(spark).toBeInTheDocument();
    // 30 barras (slice de los últimos 30 días del fixture de 90).
    expect(spark.querySelectorAll('i').length).toBe(30);
  });

  it('NO renderiza sparkbar de MRR si precios están pendientes (#451)', async () => {
    adminApi.getMetrics.mockResolvedValue(happyMetrics({
      plan_prices_usd: { trial: 0, starter: 0, pro: 0, enterprise: 0 },
    }));
    adminApi.getMetricsHistory.mockResolvedValue(happyHistory());
    adminApi.getRecentActions.mockResolvedValue(happyActions());
    adminApi.listTenants.mockResolvedValue(happyTenants());

    renderResumen();

    // El nudge "precios pendientes" gana — el sparkbar no se monta.
    await waitFor(() => {
      expect(screen.getByText(/precios pendientes de configurar/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('img', { name: /MRR últimos/i })).not.toBeInTheDocument();
  });

  it('click en row de "Top clientes" navega a /clientes/:id', async () => {
    adminApi.getMetrics.mockResolvedValue(happyMetrics());
    adminApi.getMetricsHistory.mockResolvedValue(happyHistory());
    adminApi.getRecentActions.mockResolvedValue(happyActions());
    adminApi.listTenants.mockResolvedValue(happyTenants());

    renderResumen();

    // Esperar a que aparezca el top tenant (Aurora tiene 7 users — mayor)
    await waitFor(() => {
      // Aurora aparece en activity feed Y en top tenants. Buscamos
      // dentro de la tabla específicamente.
      const topCard = screen.getByText(/top clientes por usuarios/i).closest('section');
      expect(within(topCard).getByText('Aurora Mobile')).toBeInTheDocument();
    });

    const topCard = screen.getByText(/top clientes por usuarios/i).closest('section');
    const row = within(topCard).getByText('Aurora Mobile').closest('tr');
    fireEvent.click(row);

    expect(navigateMock).toHaveBeenCalledWith('/clientes/12');
  });
});
