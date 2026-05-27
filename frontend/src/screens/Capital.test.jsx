import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', () => ({
  cajas: {
    listCajas: vi.fn().mockResolvedValue([
      { id: 1, nombre: 'Caja Pesos', moneda: 'ARS', saldo_actual: '150000', activo: true, es_financiera: false, es_tarjeta: false },
      { id: 2, nombre: 'Caja USD', moneda: 'USD', saldo_actual: '900', activo: true, es_financiera: false, es_tarjeta: false },
      { id: 3, nombre: 'Caja Cripto', moneda: 'USDT', saldo_actual: '250', activo: true, es_financiera: false, es_tarjeta: false },
    ]),
    ledger: vi.fn().mockResolvedValue({
      data: [
        { id: 9, fecha: '2026-05-10', caja_nombre: 'Caja Pesos', moneda: 'ARS', origen: 'venta', tipo: 'ingreso', concepto: 'Venta X', monto: '150000', monto_usd: '0' },
      ],
      pagination: { page: 1, pages: 1, total: 1 },
      totales: { ingresos_usd: 900, egresos_usd: 0, neto_usd: 900, count: 1 },
    }),
    resumen: vi.fn().mockResolvedValue({
      deudas: [{ contacto_id: 1, saldo_ars: '50000', saldo_usd: '100', movimientos: 2 }],
      inversiones: [{ contacto_id: 2, total_invertido: '300000', movimientos: 1, ultima_tasa: '5%' }],
    }),
  },
  inventario: {
    metricas: vi.fn().mockResolvedValue({
      en_tecnico_usd: '0', en_tecnico_ars: '0',
      inv_equipos_usd: '500', inv_equipos_ars: '0',
      inv_accesorios_usd: '0', inv_accesorios_ars: '80000',
    }),
  },
  cuentas: {
    resumenGeneral: vi.fn().mockResolvedValue({ total_deuda: 1200, total_credito: 200, neto: 1000 }),
  },
  proveedores: {
    saldos: vi.fn().mockResolvedValue({ proveedores: [{ id: 1, nombre: 'Prov A', saldo_usd: '700' }], total_deuda_usd: 700 }),
  },
}));

import Capital from './Capital';

describe('Pantalla 360 & Capital', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('pestaña Capital: muestra el patrimonio, su composición y las cajas', async () => {
    render(<Capital />);
    expect(await screen.findByText('Patrimonio · ARS')).toBeInTheDocument();
    expect(screen.getByText('Patrimonio · USD')).toBeInTheDocument();
    expect(screen.getByText('Patrimonio · USDT')).toBeInTheDocument();
    // composición del patrimonio (categorías agregadas)
    expect(screen.getByText('Composición del patrimonio')).toBeInTheDocument();
    expect(screen.getByText('Cajas (todas)')).toBeInTheDocument();
    expect(screen.getByText('Stock / Inventario')).toBeInTheDocument();
    expect(screen.getByText('Deudas de clientes a cobrar')).toBeInTheDocument();
    expect(screen.getByText('Deudas de clientes B2B a cobrar')).toBeInTheDocument();
    expect(screen.getByText('Inversiones (a devolver)')).toBeInTheDocument();
    expect(screen.getByText('Deudas a proveedores (a pagar)')).toBeInTheDocument();
    // detalle por caja en la tabla "Estado de cada caja"
    expect(screen.getAllByText('Caja Cripto').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Caja Pesos').length).toBeGreaterThanOrEqual(1);
    // el ledger NO se muestra en la pestaña Capital
    expect(screen.queryByText('Venta X')).not.toBeInTheDocument();
  });

  it('pestaña Movimientos: muestra el ledger', async () => {
    render(<Capital />);
    await screen.findByText('Patrimonio · ARS');
    await userEvent.click(screen.getByRole('button', { name: 'Movimientos' }));
    await waitFor(() => expect(screen.getByText('Venta X')).toBeInTheDocument());
  });
});
