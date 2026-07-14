import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  cambios: {
    entidades: vi.fn().mockResolvedValue([
      { id: 1, nombre: 'El Dorado', activo: true, saldo_usd: '400', entregado_usd: '1000', recibido_usd: '600', movimientos: 2 },
    ]),
    entidad: vi.fn().mockResolvedValue({
      id: 1, nombre: 'El Dorado', activo: true,
      resumen: { saldo_usd: '400', entregado_usd: '1000', recibido_usd: '600', movimientos: 2 },
    }),
    movimientos: vi.fn().mockResolvedValue({
      data: [
        { id: 5, fecha: '2026-05-01', tipo: 'entrega_ars', monto_ars: '1000000', tc: '1000', monto_usd: '1000', caja_nombre: 'Caja Pesos', comentarios: null },
      ],
      pagination: { page: 1, pages: 1, total: 1 },
    }),
    createEntidad: vi.fn(), updateEntidad: vi.fn(), deleteEntidad: vi.fn(),
    createMovimiento: vi.fn(), deleteMovimiento: vi.fn(),
  },
  cajas: { listCajas: vi.fn().mockResolvedValue([{ id: 9, nombre: 'Caja Pesos', moneda: 'ARS' }, { id: 10, nombre: 'Caja USD', moneda: 'USD' }]) },
}));

// UYU follow-up audit 2026-07-06: mock de useAuth para inyectar tenant.pais.
// El default sin mock (undefined → 'AR') cubre el escenario legacy AR; los
// tests UY re-mockean el módulo con `mockUser.value` mutable (mismo pattern
// que Ventas.test.jsx, Financiera.test.jsx).
const mockUser = { value: { tenant: { pais: 'AR', moneda_local: 'ARS' } } };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser.value }),
}));

import Cambios from './Cambios';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider } from '../contexts/PageActionsContext';

const wrap = (ui) => (
  <ToastProvider>
    <ConfirmProvider>
      <PageActionsProvider>{ui}</PageActionsProvider>
    </ConfirmProvider>
  </ToastProvider>
);

describe('Pantalla Cambios de Divisa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.value = { tenant: { pais: 'AR', moneda_local: 'ARS' } };
  });

  it('lista financieras y muestra el saldo del detalle', async () => {
    render(wrap(<Cambios />));
    expect(await screen.findByText('El Dorado')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Te deben · USD')).toBeInTheDocument());
    expect(screen.getByText('Recibido · USD')).toBeInTheDocument();
  });

  // UYU follow-up audit 2026-07-06 + UX B 2026-07-14: tenants AR mantienen
  // labels ARS. El subtítulo ahora menciona ambas direcciones.
  it('AR: subtítulo menciona ARS, columna header "$ ARS", segmented controls presentes', async () => {
    render(wrap(<Cambios />));
    // Subtítulo actualizado: ahora incluye ambas direcciones ("entregás ARS y
    // te devuelven USD, o entregás USD y te devuelven ARS").
    expect(await screen.findByText(/entregás ARS y te devuelven USD/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('$ ARS')).toBeInTheDocument());
    // UX B: ahora hay 2 segmented controls (dirección + operación) en vez de
    // un dropdown. Los botones dicen "↑ Entregás ARS → USD" y "Entrega".
    expect(screen.getByRole('button', { name: /Entregás ARS → USD/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Entregás USD → ARS/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Entrega$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Recibo$/ })).toBeInTheDocument();
    // Badge del histórico: fila con tipo='entrega_ars' → labelTipo devuelve
    // "Entrega ARS → USD" con el nuevo formato.
    expect(screen.getAllByText(/Entrega ARS/).length).toBeGreaterThanOrEqual(1);
  });

  it('UY: subtítulo dice "entregás UYU", columna header "$ UYU", segmented UYU', async () => {
    mockUser.value = { tenant: { pais: 'UY', moneda_local: 'UYU' } };
    render(wrap(<Cambios />));
    expect(await screen.findByText(/entregás UYU y te devuelven USD/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('$ UYU')).toBeInTheDocument());
    // Segmented con labels UYU.
    expect(screen.getByRole('button', { name: /Entregás UYU → USD/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Entregás USD → UYU/ })).toBeInTheDocument();
  });
});
