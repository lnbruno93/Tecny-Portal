import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  egresos: {
    list: vi.fn().mockResolvedValue({
      data: [
        { id: 1, fecha: '2026-05-10', concepto: 'Alquiler', categoria_nombre: 'Alquiler', caja_nombre: 'Caja USD', monto: '500', moneda: 'USD', monto_usd: '500', estado: 'pagado' },
        { id: 2, fecha: '2026-05-15', concepto: 'Sueldos', categoria_nombre: 'Sueldos', caja_nombre: null, monto: '300', moneda: 'USD', monto_usd: '300', estado: 'pendiente' },
      ],
      pagination: { page: 1, pages: 1, total: 2 },
    }),
    create: vi.fn(), update: vi.fn(), delete: vi.fn(),
    categorias: vi.fn().mockResolvedValue([{ id: 1, nombre: 'Alquiler' }]),
    recurrentes: vi.fn().mockResolvedValue([]),
    createCategoria: vi.fn(), deleteCategoria: vi.fn(),
    createRecurrente: vi.fn(), deleteRecurrente: vi.fn(), generar: vi.fn(),
  },
  cajas: { listCajas: vi.fn().mockResolvedValue([{ id: 9, nombre: 'Caja USD', moneda: 'USD' }]) },
}));

import EgresosPanel from './EgresosPanel';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';

describe('EgresosPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lista egresos del período con su estado y KPIs', async () => {
    render(<ToastProvider><ConfirmProvider><EgresosPanel /></ConfirmProvider></ToastProvider>);
    // Estado por fila (texto único, no aparece en filtros)
    expect(await screen.findByText('Pagado ✓')).toBeInTheDocument();
    expect(screen.getByText('Pendiente')).toBeInTheDocument();
    // Conceptos en la tabla (aparecen también en filtros de categoría → al menos uno)
    expect(screen.getAllByText('Sueldos').length).toBeGreaterThanOrEqual(1);
    // KPI
    expect(screen.getByText('Pagado · USD')).toBeInTheDocument();
  });
});
