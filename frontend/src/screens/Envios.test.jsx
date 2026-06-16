import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Smoke tests T-01 — sólo verificamos que la pantalla monta, carga sus
// APIs core y abre el modal principal sin romper. NO lógica de negocio.
vi.mock('../lib/api', () => {
  const paginated = { data: [], pagination: { page: 1, pages: 1, total: 0 } };
  return {
    envios: {
      list:   vi.fn().mockResolvedValue(paginated),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    cajas: {
      listMetodosPago: vi.fn().mockResolvedValue([]),
    },
    cuentas: {
      clientes: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, pages: 1, total: 0 } }),
    },
    inventario: {
      productos: vi.fn().mockResolvedValue(paginated),
    },
    ventas: {
      uploadComprobante: vi.fn().mockResolvedValue({}),
    },
    config: {
      get: vi.fn().mockResolvedValue({ pct_financiera: 0 }),
    },
    ocr: {
      extract: vi.fn().mockResolvedValue({ monto: null }),
    },
  };
});

import { envios as enviosApi, cajas as cajasApi, cuentas as cuentasApi } from '../lib/api';
import Envios from './Envios';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider, usePageActions } from '../contexts/PageActionsContext';

// "Nuevo envío" se registra vía PageActionsContext y lo dispara el Shell.
// Como no montamos el Shell, este botón expone la primaryAction registrada.
function ActionTrigger() {
  const { primaryAction } = usePageActions();
  return primaryAction ? <button onClick={primaryAction.onClick}>__abrir__</button> : null;
}

function renderEnvios() {
  return render(
    <MemoryRouter>
      <ToastProvider><ConfirmProvider><PageActionsProvider>
        <Envios />
        <ActionTrigger />
      </PageActionsProvider></ConfirmProvider></ToastProvider>
    </MemoryRouter>
  );
}

describe('Pantalla Envíos', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('monta sin crashear y carga lista + metodos pago + clientes CC', async () => {
    renderEnvios();
    await waitFor(() => expect(enviosApi.list).toHaveBeenCalled());
    await waitFor(() => expect(cajasApi.listMetodosPago).toHaveBeenCalled());
    await waitFor(() => expect(cuentasApi.clientes).toHaveBeenCalled());
  });

  it('abre modal "Nuevo envío" sin crashear', async () => {
    renderEnvios();
    await waitFor(() => expect(enviosApi.list).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('__abrir__'));
    // Campos clave del form: Cliente y Dirección son obligatorios → siempre renderizados.
    expect(await screen.findByText(/Cliente/)).toBeInTheDocument();
    expect(await screen.findByText(/Dirección/)).toBeInTheDocument();
  });

  it('con 1 envío en la lista, lo renderiza', async () => {
    enviosApi.list.mockResolvedValueOnce({
      data: [{
        id: 1, cliente: 'Juan', estado: 'Pendiente',
        fecha: '2026-06-11', direccion: 'San Martín 100',
        items: [], pagos: [],
      }],
      pagination: { page: 1, pages: 1, total: 1 },
    });
    renderEnvios();
    // "Juan" puede aparecer 2 veces (lista + panel de detalle del
    // primer envío auto-seleccionado) → findAllByText.
    const matches = await screen.findAllByText('Juan');
    expect(matches.length).toBeGreaterThan(0);
  });
});
