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

  // Auditoría 2026-06-30 F-13/14: quitar un item de pago del medio NO debe
  // pisar el draft del input del item siguiente. Con key={index} React reusa
  // el DOM y los inputs no controlados pierden su valor; con _id estable,
  // cada fila se desmonta limpia.
  it('items: quitar pago del medio NO afecta el monto cargado en el pago siguiente', async () => {
    renderEnvios();
    await waitFor(() => expect(enviosApi.list).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('__abrir__'));
    // Esperar a que el modal esté abierto — el form muestra "Dirección".
    await screen.findByText(/Dirección/);
    // Agregar 3 pagos via botón "Agregar método". Hay varios botones con icono +,
    // así que buscamos por el texto "Agregar método" del span/contenido.
    const allButtons = screen.getAllByRole('button');
    const btnPago = allButtons.find(b => /Agregar método/.test(b.textContent));
    expect(btnPago).toBeTruthy();
    fireEvent.click(btnPago);
    fireEvent.click(btnPago);
    fireEvent.click(btnPago);
    // Buscamos los inputs de monto de pago — data-testid="envio-pago-monto".
    let pagos = await screen.findAllByTestId('envio-pago-monto');
    expect(pagos).toHaveLength(3);
    // Tipear valores distintivos en el pago 1 y 2.
    fireEvent.change(pagos[1], { target: { value: '111' } });
    fireEvent.change(pagos[2], { target: { value: '222' } });
    expect(pagos[1].value).toBe('111');
    expect(pagos[2].value).toBe('222');
    // Quitar el pago 0 — el botón X está como sibling en la grilla del pago.
    // Buscamos el contenedor grid del pago 0 y su botón.
    const row0 = pagos[0].closest('div[style*="grid"]');
    const xBtn0 = row0.querySelector('button');
    fireEvent.click(xBtn0);
    // Tras quitar, quedan 2 pagos. El pago 0 (antes 1) debe mostrar '111'.
    pagos = await screen.findAllByTestId('envio-pago-monto');
    expect(pagos).toHaveLength(2);
    expect(pagos[0].value).toBe('111');
    expect(pagos[1].value).toBe('222');
  });

  // Auditoría 2026-06-30 F-10: Esc cierra el modal "Nuevo envío" (useModal).
  it('modal Nuevo envío: Esc cierra el modal', async () => {
    renderEnvios();
    await waitFor(() => expect(enviosApi.list).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('__abrir__'));
    // El modal está montado: vemos el header "Cliente" y "Dirección".
    expect(await screen.findByText(/Cliente/)).toBeInTheDocument();
    // Disparar Esc.
    fireEvent.keyDown(document, { key: 'Escape' });
    // Tras Esc, los campos del modal desaparecen. Buscamos un input distintivo:
    // el botón "Agregar producto" solo existe dentro del modal.
    await waitFor(() => {
      expect(screen.queryByText(/Agregar producto/)).not.toBeInTheDocument();
    });
  });
});
