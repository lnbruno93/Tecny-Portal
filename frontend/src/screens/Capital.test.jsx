import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  cajas: {
    listCajas: vi.fn().mockResolvedValue([
      { id: 1, nombre: 'Caja Pesos', moneda: 'ARS', saldo_actual: '150000', activo: true, es_financiera: false, es_tarjeta: false },
      { id: 2, nombre: 'Caja USD', moneda: 'USD', saldo_actual: '900', activo: true, es_financiera: false, es_tarjeta: false },
    ]),
    ledger: vi.fn().mockResolvedValue({
      data: [
        { id: 9, fecha: '2026-05-10', caja_nombre: 'Caja Pesos', moneda: 'ARS', origen: 'venta', tipo: 'ingreso', concepto: 'Venta X', monto: '150000', monto_usd: '0' },
      ],
      pagination: { page: 1, pages: 1, total: 1 },
      totales: { ingresos_usd: 900, egresos_usd: 0, neto_usd: 900, count: 1 },
    }),
  },
}));

import Capital from './Capital';

describe('Pantalla 360 & Capital', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('muestra capital por moneda, las cajas y los movimientos', async () => {
    render(<Capital />);
    expect(await screen.findByText('Capital · ARS')).toBeInTheDocument();
    expect(screen.getByText('Capital · USD')).toBeInTheDocument();
    // cajas (aparece en la tabla y en el filtro de caja)
    expect(screen.getAllByText('Caja Pesos').length).toBeGreaterThanOrEqual(1);
    // movimiento del ledger
    await waitFor(() => expect(screen.getByText('Venta X')).toBeInTheDocument());
  });
});
