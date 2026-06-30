// Tests smoke de accesibilidad (follow-up T-19 audit 2026-06-22).
//
// Usa vitest-axe (port de jest-axe a vitest) para correr axe-core sobre
// cada screen renderizada y validar 0 violations. Catch regresiones
// futuras: si un dev olvida `<label htmlFor>` en un input nuevo, este
// test rompe antes del PR.
//
// Foco: smoke tests por screen. NO valida cada interacción — eso queda
// para tests manuales con NVDA/VoiceOver o herramientas automatizadas
// más pesadas (Playwright + axe). Acá solo "el render inicial no tiene
// violations graves".
//
// axe-core viene configurado con reglas WCAG 2.1 AA por default. Algunas
// reglas (color-contrast) NO corren en jsdom porque requieren layout
// real — eso lo cubrimos con review manual + Lighthouse en CI futuro.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'vitest-axe';

// Mock global del context Auth y API — replicado del patrón de los
// otros tests para mantener consistencia.
const mockAuth = {
  loading: false,
  isAuthenticated: true,
  user: { id: 1, username: 'lucas.bruno', is_super_admin: true },
};
vi.mock('../contexts/AuthContext.jsx', () => ({
  useAuth: () => mockAuth,
  AuthProvider: ({ children }) => children,
}));

vi.mock('../lib/api.js', () => ({
  adminApi: {
    me: vi.fn().mockResolvedValue({ is_super_admin: true, user_id: 1, username: 'lucas' }),
    getMetrics: vi.fn().mockResolvedValue({
      mrr_total_usd: 1500,
      tenants_active: 12,
      signups_30d: 3,
      signups_7d: 1,
      churn_30d: 0,
      tenants_trial: 4,
      conversion_trial_paid_30d: 25,
      plan_prices_usd: { starter: 39, pro: 189, enterprise: 0 },
      tenants_by_plan: [
        { plan: 'starter', count: 8, mrr_usd: 312 },
        { plan: 'pro', count: 4, mrr_usd: 756 },
      ],
    }),
    getMetricsHistory: vi.fn().mockResolvedValue({ history: [] }),
    getRecentActions: vi.fn().mockResolvedValue({ recent_actions: [] }),
    listTenants: vi.fn().mockResolvedValue([
      { id: 1, nombre: 'Acme', slug: 'acme', plan: 'pro', users_count: 5, mrr_usd: 189 },
    ]),
    getTenant: vi.fn().mockResolvedValue({
      id: 1, nombre: 'Acme', slug: 'acme', plan: 'pro', trial_until: null,
      suspended_at: null, custom_mrr_usd: null, notes: '', users_count: 5,
      created_at: '2026-01-01T00:00:00Z', recent_admin_actions: [],
    }),
    getActivity: vi.fn().mockResolvedValue({ items: [] }),
    getPlanPrices: vi.fn().mockResolvedValue({
      plan_prices: [
        { plan: 'trial', price_usd: 0, active: true, notes: '', updated_at: null, updated_by_username: null },
        { plan: 'starter', price_usd: 39, active: true, notes: '', updated_at: '2026-06-22T10:00:00Z', updated_by_username: 'lucas' },
        { plan: 'pro', price_usd: 189, active: true, notes: '', updated_at: '2026-06-22T10:00:00Z', updated_by_username: 'lucas' },
        { plan: 'enterprise', price_usd: null, active: true, notes: '', updated_at: null, updated_by_username: null },
      ],
    }),
    // Multi-país F4 (#470): mock para el smoke test de a11y de TcDefaults.
    getTcDefaultsPais: vi.fn().mockResolvedValue({
      tc_defaults: [
        { pais: 'AR', par: 'ARS/USD', valor: 1400, updated_at: '2026-06-29T10:00:00Z', updated_by: 1, updated_by_username: 'lucas' },
        { pais: 'UY', par: 'UYU/USD', valor: 40, updated_at: null, updated_by: null, updated_by_username: null },
      ],
    }),
  },
  getToken: vi.fn(() => 'tok-x'),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  abortAllInFlight: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

import Login from '../pages/Login.jsx';
import Resumen from '../pages/Resumen.jsx';
import Clientes from '../pages/Clientes.jsx';
import Planes from '../pages/Planes.jsx';
import TcDefaults from '../pages/TcDefaults.jsx';

beforeEach(() => {
  vi.clearAllMocks();
});

// Helper común: render dentro de un MemoryRouter, esperar al primer
// settle de promises, correr axe.
async function runA11y(ui) {
  const { container } = render(<MemoryRouter>{ui}</MemoryRouter>);
  // Esperar a que los efectos iniciales completen — sin esto algunos
  // skeletons todavía están en pantalla y dan falsos negativos.
  await waitFor(() => {
    // Truco: cualquier text node (incluido empty) significa que el
    // primer paint ya ocurrió.
    expect(container.textContent).not.toBe('');
  });
  const results = await axe(container);
  return results;
}

describe('a11y smoke tests', () => {
  it('Login no tiene violations a11y', async () => {
    const results = await runA11y(<Login />);
    expect(results).toHaveNoViolations();
  });

  it('Resumen no tiene violations a11y', async () => {
    const results = await runA11y(<Resumen />);
    expect(results).toHaveNoViolations();
  });

  it('Clientes no tiene violations a11y', async () => {
    const results = await runA11y(<Clientes />);
    expect(results).toHaveNoViolations();
  });

  it('Planes no tiene violations a11y', async () => {
    const results = await runA11y(<Planes />);
    expect(results).toHaveNoViolations();
  });

  it('TcDefaults no tiene violations a11y', async () => {
    const results = await runA11y(<TcDefaults />);
    expect(results).toHaveNoViolations();
  });
});
