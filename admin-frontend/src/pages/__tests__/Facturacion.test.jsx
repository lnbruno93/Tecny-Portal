// Tests de Facturación — dashboard SaaS billing del back-office (task #130).
//
// Cubrimos los escenarios que dan valor sin sobre-testear el mock:
//   1. Render feliz: 4 KPIs + tabla de facturas con badges de estado
//   2. Tabs filtran por estado (todas / pagadas / pendientes / fallidas)
//   3. Empty state cuando el endpoint devuelve facturas=[]
//   4. Error banner cuando el endpoint falla
//   5. Click en row navega a /clientes/:id (drill-down al tenant)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

// Fixture "feliz": 3 facturas cubriendo los 3 estados posibles, para poder
// probar filtros con al menos 1 row en cada tab.
function happyData() {
  return {
    kpis: {
      mrr_usd: 1051,
      mrr_delta_pct: 8.4,
      cobrado_mes_usd: 784,
      cobrado_count: 6,
      pendiente_usd: 89,
      pendiente_count: 1,
      fallidos_usd: 89,
      fallidos_count: 1,
      reintento_dias: 2,
    },
    facturas: [
      {
        id: 41, numero: 'INV-2041', tenant_id: 41,
        tenant_nombre: 'Mac Center', plan: 'pro', plan_label: 'Pro',
        monto_usd: 189, fecha: '2026-05-23T10:00:00Z',
        metodo: 'tarjeta', estado: 'pagada',
      },
      {
        id: 38, numero: 'INV-2038', tenant_id: 38,
        tenant_nombre: 'TecnoCelu', plan: 'starter', plan_label: 'Starter',
        monto_usd: 89, fecha: '2026-05-22T10:00:00Z',
        metodo: 'tarjeta', estado: 'fallida',
      },
      {
        id: 35, numero: 'INV-2035', tenant_id: 35,
        tenant_nombre: 'iFix Palermo', plan: 'starter', plan_label: 'Starter',
        monto_usd: 89, fecha: '2026-05-20T10:00:00Z',
        metodo: 'tarjeta', estado: 'pendiente',
      },
    ],
  };
}

describe('Pantalla Facturación (admin)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateMock.mockClear();
  });

  it('renderiza los 4 KPIs y la tabla con las facturas', async () => {
    adminApi.getFacturacion.mockResolvedValue(happyData());
    renderFacturacion();

    // Título de página.
    expect(await screen.findByText('Facturación y cobros')).toBeInTheDocument();

    // Los 4 labels de KPI (algunos textos como "Pendiente" también aparecen
    // como estado en filas de la tabla — usamos getAllByText y verificamos
    // que exista al menos uno).
    expect(screen.getByText('MRR')).toBeInTheDocument();
    expect(screen.getByText('Cobrado (mes)')).toBeInTheDocument();
    // "Pendiente" aparece 2x (KPI label + estado en fila iFix Palermo).
    expect(screen.getAllByText('Pendiente').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Fallidos')).toBeInTheDocument();

    // Valores esperados (MRR $1.051 y cobrado $784 vienen del fixture).
    await waitFor(() => {
      expect(screen.getByText('$1.051')).toBeInTheDocument();
    });
    expect(screen.getByText('$784')).toBeInTheDocument();

    // Delta chip del MRR: 8.4% con flecha up.
    expect(screen.getByText(/8\.4%/)).toBeInTheDocument();

    // Contador de pagos en cobrado.
    expect(screen.getByText('6 pagos')).toBeInTheDocument();
    // Reintento en 2 días para el KPI fallidos.
    expect(screen.getByText(/reintento en 2 d/)).toBeInTheDocument();

    // Filas de la tabla — 3 tenants.
    expect(screen.getByText('Mac Center')).toBeInTheDocument();
    expect(screen.getByText('TecnoCelu')).toBeInTheDocument();
    expect(screen.getByText('iFix Palermo')).toBeInTheDocument();

    // Número de factura (formato INV-XXXX).
    expect(screen.getByText('INV-2041')).toBeInTheDocument();
    // Estado con status dot: los 3 estados presentes.
    expect(screen.getByText('Pagada')).toBeInTheDocument();
    expect(screen.getByText('Fallida')).toBeInTheDocument();
  });

  it('filtra la tabla por tab (Fallidas muestra solo la de TecnoCelu)', async () => {
    adminApi.getFacturacion.mockResolvedValue(happyData());
    renderFacturacion();

    await screen.findByText('Mac Center');

    // Click en tab "Fallidas".
    fireEvent.click(screen.getByRole('tab', { name: 'Fallidas' }));

    // Solo TecnoCelu (estado='fallida') queda visible.
    expect(screen.getByText('TecnoCelu')).toBeInTheDocument();
    expect(screen.queryByText('Mac Center')).not.toBeInTheDocument();
    expect(screen.queryByText('iFix Palermo')).not.toBeInTheDocument();
  });

  it('muestra empty state cuando no hay facturas', async () => {
    adminApi.getFacturacion.mockResolvedValue({
      kpis: {
        mrr_usd: 0, mrr_delta_pct: 0,
        cobrado_mes_usd: 0, cobrado_count: 0,
        pendiente_usd: 0, pendiente_count: 0,
        fallidos_usd: 0, fallidos_count: 0,
        reintento_dias: 2,
      },
      facturas: [],
    });
    renderFacturacion();

    await waitFor(() => {
      expect(screen.getByText('Sin facturas todavía.')).toBeInTheDocument();
    });
    // KPIs de fallidos "sin fallidos" en vez de reintento.
    expect(screen.getByText('sin fallidos')).toBeInTheDocument();
  });

  it('muestra banner de error si el endpoint falla', async () => {
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

    const cell = await screen.findByText('Mac Center');
    fireEvent.click(cell.closest('tr'));

    expect(navigateMock).toHaveBeenCalledWith('/clientes/41');
  });
});
