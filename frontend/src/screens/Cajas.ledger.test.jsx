import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', () => ({
  cajas: {
    listCajas:        vi.fn().mockResolvedValue([]),
    ledger:           vi.fn().mockResolvedValue({
      data: [], pagination: { pages: 1, page: 1, total: 0 },
      totales: { ingresos_usd: 0, egresos_usd: 0, neto_usd: 0, count: 0 },
    }),
    cajaMovimientos:  vi.fn().mockResolvedValue({ data: [], pagination: {} }),
    deudas:           vi.fn().mockResolvedValue([]),
    inversiones:      vi.fn().mockResolvedValue([]),
    createCaja: vi.fn(), updateCaja: vi.fn(), deleteCaja: vi.fn(),
    createCajaAjuste: vi.fn(), deleteCajaMov: vi.fn(),
    createDeuda: vi.fn(), deleteDeuda: vi.fn(),
    createInversion: vi.fn(), deleteInversion: vi.fn(),
  },
  contactos: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
  tarjetas: { entidades: vi.fn().mockResolvedValue([]), entidad: vi.fn().mockResolvedValue({ planes: [] }) },
}));

import { cajas as cajasApi } from '../lib/api';
import Cajas from './Cajas';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

function renderCajas() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <PageActionsProvider>
          <Cajas />
        </PageActionsProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe('Cajas — pestaña Historial Movimientos (ledger)', () => {
  beforeEach(() => { cajasApi.ledger.mockClear(); });

  it('al abrir la pestaña carga el ledger global y muestra los totales', async () => {
    renderCajas();
    await userEvent.click(await screen.findByRole('button', { name: /historial movimientos/i }));

    await waitFor(() => expect(cajasApi.ledger).toHaveBeenCalled());
    // Totales en USD visibles
    expect(screen.getByText(/ingresos · usd/i)).toBeInTheDocument();
    expect(screen.getByText(/egresos · usd/i)).toBeInTheDocument();
    expect(screen.getByText(/neto · usd/i)).toBeInTheDocument();
    // Estado vacío de la tabla
    expect(screen.getByText(/sin movimientos para los filtros/i)).toBeInTheDocument();
  });
});
