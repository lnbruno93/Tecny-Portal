import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

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
      // F3-Fase2b: legacy buckets siguen presentes (Fase 2a aditivo).
      // Capital.jsx los usa como fallback si `inv_por_clase` no existe.
      inv_equipos_usd: '500', inv_equipos_ars: '0',
      inv_accesorios_usd: '0', inv_accesorios_ars: '80000',
      // Nuevo shape post-Fase 2a: 2 categorías del tenant + coherencia con
      // los totales legacy (500 USD + 80000 ARS).
      inv_por_clase: [
        { clase_id: 'aaaa', nombre: 'Celular Sellado', emoji: '📲', es_base: true, es_sin_categoria: false, slug_legacy: 'celular_sellado', count: 1, usd: 500, ars: 0 },
        { clase_id: 'bbbb', nombre: 'Accesorios/Varios', emoji: '🛍️', es_base: true, es_sin_categoria: false, slug_legacy: 'accesorios_varios', count: 3, usd: 0, ars: 80000 },
      ],
    }),
  },
  cuentas: {
    resumenGeneral: vi.fn().mockResolvedValue({ total_deuda: 1200, total_credito: 200, neto: 1000 }),
  },
  proveedores: {
    saldos: vi.fn().mockResolvedValue({ proveedores: [{ id: 1, nombre: 'Prov A', saldo_usd: '700' }], total_deuda_usd: 700 }),
  },
  // Saldos pendientes en tarjetas (lo que la financiera nos debe depositar) — suma al patrimonio.
  tarjetas: {
    saldosResumen: vi.fn().mockResolvedValue({ saldo_ars: 19850000, saldo_usd: 0 }),
  },
  // Saldos pendientes en cambios de divisa (USD que las financieras nos deben) — suma al patrimonio.
  cambios: {
    saldosResumen: vi.fn().mockResolvedValue({ saldo_usd: 400 }),
  },
}));

import Capital from './Capital';

describe('Pantalla 360 & Capital', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('pestaña Capital: muestra el patrimonio, su composición y las cajas', async () => {
    render(<MemoryRouter><Capital /></MemoryRouter>);
    expect(await screen.findByText('Patrimonio · ARS')).toBeInTheDocument();
    expect(screen.getByText('Patrimonio · USD')).toBeInTheDocument();
    expect(screen.getByText('Patrimonio · USDT')).toBeInTheDocument();
    // composición del patrimonio (una card por componente)
    expect(screen.getByText('Composición del patrimonio')).toBeInTheDocument();
    expect(screen.getByText('Inversiones recibidas')).toBeInTheDocument();
    expect(screen.getByText('Deudas de clientes a cobrar')).toBeInTheDocument();
    expect(screen.getByText('Deudas de clientes B2B a cobrar')).toBeInTheDocument();
    expect(screen.getByText('Stock valorizado')).toBeInTheDocument();
    expect(screen.getByText('Deudas a proveedores a pagar')).toBeInTheDocument();
    // Saldos pendientes en tarjetas y cambios — deben aparecer como líneas que SUMAN al patrimonio.
    expect(screen.getByText('Tarjetas a cobrar')).toBeInTheDocument();
    expect(screen.getByText('Cambios de divisa a cobrar')).toBeInTheDocument();
    // cada caja entra como fila en "Suman" dentro de la composición
    expect(screen.getByText('Caja Cripto')).toBeInTheDocument();
    expect(screen.getByText('Caja Pesos')).toBeInTheDocument();
    expect(screen.getByText('Caja USD')).toBeInTheDocument();
    // el ledger NO se muestra en la pestaña Capital
    expect(screen.queryByText('Venta X')).not.toBeInTheDocument();
  });

  it('pestaña Movimientos: muestra el ledger', async () => {
    render(<MemoryRouter><Capital /></MemoryRouter>);
    await screen.findByText('Patrimonio · ARS');
    await userEvent.click(screen.getByRole('button', { name: 'Movimientos' }));
    await waitFor(() => expect(screen.getByText('Venta X')).toBeInTheDocument());
  });
});
