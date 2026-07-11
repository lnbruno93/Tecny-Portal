// Test unitario del content del tab "Equipos usados" (2026-07-11).
//
// Cubre:
//   1. Render inicial + carga de datos vía inventario.usados() mock.
//   2. Distinción visual origen 'canje' vs 'manual'.
//   3. Filtro "Solo canjes" (click al toggle → refetch con params correctos).
//   4. Empty state cuando no hay resultados.
//   5. Callback onCountChange se dispara con el total del pagination.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/api', () => ({
  inventario: {
    usados: vi.fn(),
  },
}));

import { inventario as inventarioApi } from '../lib/api';
import EquiposUsadosContent from './EquiposUsadosContent';
import { ToastProvider } from '../contexts/ToastContext';

function renderContent(props = {}) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <EquiposUsadosContent {...props} />
      </ToastProvider>
    </MemoryRouter>
  );
}

const paginatedEmpty = { data: [], pagination: { page: 1, limit: 50, total: 0, pages: 1 } };

describe('EquiposUsadosContent — tab Equipos usados en Inventario', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inventarioApi.usados.mockResolvedValue(paginatedEmpty);
  });

  it('carga datos al montar (llama al endpoint una vez con params base)', async () => {
    renderContent();
    await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
    // Params base: page=1, limit=50 (sin buscar / solo_canjes / estado).
    expect(inventarioApi.usados).toHaveBeenCalledWith(expect.objectContaining({
      page: 1, limit: 50,
    }));
  });

  it('empty state cuando no hay resultados y no hay filtros', async () => {
    renderContent();
    expect(
      await screen.findByText(/Todavía no ingresaron equipos usados/i)
    ).toBeInTheDocument();
  });

  it('renderea producto que vino por CANJE con badge del order_id + cliente', async () => {
    inventarioApi.usados.mockResolvedValue({
      data: [{
        id: 1, nombre: 'iPhone 13 Pro',
        condicion: 'usado', estado: 'disponible',
        gb: '256', color: 'Sierra Blue', bateria: 87, imei: '356443874343434',
        costo: 620, costo_moneda: 'USD', precio_venta: 950, precio_moneda: 'USD',
        cantidad: 1, created_at: '2026-07-05T10:00:00Z',
        clase_nombre: 'Celular Usado', clase_emoji: '♻️',
        origen: 'canje',
        canje_origen: {
          canje_id: 42, venta_id: 100,
          venta_order_id: 'ORD-425c03e5',
          venta_fecha: '2026-07-05',
          cliente_nombre: 'Martín Rodríguez',
          cliente_telefono: '+54 9 11 4567-8901',
        },
      }],
      pagination: { page: 1, limit: 50, total: 1, pages: 1 },
    });

    renderContent();
    // Badge del order_id (link a Ventas con buscar).
    expect(await screen.findByText('ORD-425c03e5')).toBeInTheDocument();
    // Cliente que lo entregó.
    expect(screen.getByText('Martín Rodríguez')).toBeInTheDocument();
    // Batería con color.
    expect(screen.getByText('87%')).toBeInTheDocument();
    // Link al detalle de la venta origen — verifica href correcto.
    const link = screen.getByTitle('Abrir venta ORD-425c03e5');
    expect(link.getAttribute('href')).toContain('/ventas?buscar=ORD-425c03e5');
  });

  it('renderea producto manual con badge "Manual" y sin cliente', async () => {
    inventarioApi.usados.mockResolvedValue({
      data: [{
        id: 2, nombre: 'iPhone 14 256 Deep Purple',
        condicion: 'usado', estado: 'disponible',
        gb: '256', color: 'Deep Purple', bateria: 91, imei: '358900112233456',
        costo: 720, costo_moneda: 'USD', precio_venta: 1100, precio_moneda: 'USD',
        cantidad: 1, created_at: '2026-06-30T10:00:00Z',
        clase_nombre: 'Celular Usado', clase_emoji: '♻️',
        origen: 'manual',
        canje_origen: null,
      }],
      pagination: { page: 1, limit: 50, total: 1, pages: 1 },
    });

    renderContent();
    expect(await screen.findByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('iPhone 14 256 Deep Purple')).toBeInTheDocument();
    // No debe haber link al detalle de venta (no vino por canje).
    expect(screen.queryByTitle(/Abrir venta/i)).not.toBeInTheDocument();
  });

  it('toggle "Solo canjes" refetch con solo_canjes=true en params', async () => {
    renderContent();
    await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
    inventarioApi.usados.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Solo canjes/i }));
    await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
    // Verificamos que el nuevo call incluye solo_canjes=true.
    const lastCall = inventarioApi.usados.mock.calls[inventarioApi.usados.mock.calls.length - 1];
    expect(lastCall[0]).toMatchObject({ solo_canjes: 'true' });
  });

  it('dispara onCountChange con el total del pagination al cargar', async () => {
    inventarioApi.usados.mockResolvedValue({
      data: [{ id: 1, nombre: 'X', condicion: 'usado', estado: 'disponible', origen: 'manual', canje_origen: null }],
      pagination: { page: 1, limit: 50, total: 14, pages: 1 },
    });
    const onCountChange = vi.fn();
    renderContent({ onCountChange });
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(14));
  });
});
