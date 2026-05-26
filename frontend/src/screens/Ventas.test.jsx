import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/api', () => {
  const paginated = { data: [], pagination: { page: 1, pages: 1, total: 0 } };
  return {
    ventas: {
      dashboard: vi.fn().mockResolvedValue({
        ingresos: [], metodos_pago: [], diferencias: { sobrepagos: 0, faltantes: 0, neto: 0 },
        costos_usd: 0, egresos_usd: 0, ganancia_neta_usd: 0, inversion_canjes_usd: 0,
        margen_pct: 0, ticket_promedio_usd: 0, ventas_count: 0,
        unidades: { celulares: 0, accesorios: 0 },
        por_etiqueta: [], por_horario: [], top_productos: [], top_vendedores: [],
      }),
      list: vi.fn().mockResolvedValue(paginated),
      rapidas: vi.fn().mockResolvedValue(paginated),
      etiquetas: vi.fn().mockResolvedValue([]),
      metodosPago: vi.fn().mockResolvedValue([{ id: 1, nombre: 'Efectivo', moneda: 'ARS', es_financiera: false }]),
      garantias: vi.fn().mockResolvedValue([]),
      create: vi.fn(), update: vi.fn(), delete: vi.fn(),
      comprobantes: vi.fn(), getComprobante: vi.fn(), uploadComprobante: vi.fn(),
      createEtiqueta: vi.fn(), deleteEtiqueta: vi.fn(),
      createGarantia: vi.fn(), updateGarantia: vi.fn(), deleteGarantia: vi.fn(),
      createEgreso: vi.fn(), createRapida: vi.fn(), deleteRapida: vi.fn(), updateRapida: vi.fn(),
    },
    inventario: { productos: vi.fn().mockResolvedValue(paginated) },
    vendedores: { list: vi.fn().mockResolvedValue([]) },
    cuentas: { clientes: vi.fn().mockResolvedValue(paginated) },
    contactos: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
  };
});

import { ventas as ventasApi } from '../lib/api';
import Ventas from './Ventas';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

describe('Pantalla Ventas', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('monta sin crashear y carga el dashboard + lista', async () => {
    render(
      <MemoryRouter>
        <ToastProvider><ConfirmProvider><PageActionsProvider>
          <Ventas />
        </PageActionsProvider></ConfirmProvider></ToastProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(ventasApi.dashboard).toHaveBeenCalled());
    await waitFor(() => expect(ventasApi.list).toHaveBeenCalled());
  });
});
