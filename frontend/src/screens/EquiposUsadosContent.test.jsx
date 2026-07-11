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
    // 2026-07-11: ShareLinkPanel (renderea dentro de EquiposUsadosContent)
    // llama a shareLink.get() al montar. Mockeamos con defaults para que
    // el componente monte sin errores y el panel arranque colapsado.
    shareLink: {
      get: vi.fn().mockResolvedValue({
        id: 1, token: 'testtoken123456', activo: true,
        whatsapp: null, mensaje_extra: null,
        mostrar_bateria: true, mostrar_precio: true,
        stats: { vistas_ult_mes: 0, unicos_hoy: 0, ultimo_acceso: null },
      }),
      update: vi.fn(),
      rotate: vi.fn(),
    },
  },
}));

import { inventario as inventarioApi } from '../lib/api';
import EquiposUsadosContent from './EquiposUsadosContent';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';

function renderContent(props = {}) {
  return render(
    <MemoryRouter>
      <ConfirmProvider>
      <ToastProvider>
        <EquiposUsadosContent {...props} />
      </ToastProvider>
      </ConfirmProvider>
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

  // 2026-07-11: filtro origen refactor de bool toggle a Seg de 3 estados.
  it('Seg "Canjes" refetch con solo_canjes=true en params', async () => {
    renderContent();
    await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
    inventarioApi.usados.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Canjes' }));
    await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
    const lastCall = inventarioApi.usados.mock.calls[inventarioApi.usados.mock.calls.length - 1];
    expect(lastCall[0]).toMatchObject({ solo_canjes: 'true' });
    expect(lastCall[0].solo_manual).toBeUndefined();
  });

  it('Seg "Carga manual" refetch con solo_manual=true en params', async () => {
    renderContent();
    await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
    inventarioApi.usados.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Carga manual' }));
    await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
    const lastCall = inventarioApi.usados.mock.calls[inventarioApi.usados.mock.calls.length - 1];
    expect(lastCall[0]).toMatchObject({ solo_manual: 'true' });
    expect(lastCall[0].solo_canjes).toBeUndefined();
  });

  it('Seg "Todos" no envía filtros solo_canjes ni solo_manual', async () => {
    renderContent();
    await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
    // Click Canjes primero, luego volver a Todos → debe limpiar el filtro.
    fireEvent.click(screen.getByRole('button', { name: 'Canjes' }));
    await waitFor(() => {
      const call = inventarioApi.usados.mock.calls[inventarioApi.usados.mock.calls.length - 1];
      expect(call[0].solo_canjes).toBe('true');
    });
    inventarioApi.usados.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
    const lastCall = inventarioApi.usados.mock.calls[inventarioApi.usados.mock.calls.length - 1];
    expect(lastCall[0].solo_canjes).toBeUndefined();
    expect(lastCall[0].solo_manual).toBeUndefined();
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

  // 2026-07-11 (Lucas): copy del listado formateado para WhatsApp de venta.
  // Solo estado='disponible' con precio_venta > 0. Formato:
  // "Nombre | Color | GBGB | Bat% — USD Precio"
  describe('Copiar listado', () => {
    let writeTextSpy;
    beforeEach(() => {
      writeTextSpy = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextSpy },
        writable: true,
        configurable: true,
      });
    });

    it('copia solo los disponibles con precio, con formato correcto', async () => {
      inventarioApi.usados.mockResolvedValue({
        data: [
          {
            id: 1, nombre: 'iPh 17 Pro Max', gb: '512', color: 'Blue',
            bateria: 100, precio_venta: 1420, precio_moneda: 'USD',
            condicion: 'usado', estado: 'disponible',
            origen: 'manual', canje_origen: null,
          },
          {
            id: 2, nombre: 'iPh 17', gb: '256', color: 'Black',
            bateria: 100, precio_venta: 840, precio_moneda: 'USD',
            condicion: 'usado', estado: 'disponible',
            origen: 'canje', canje_origen: { venta_order_id: 'ORD-1', cliente_nombre: 'X' },
          },
          // Fila filtrada: vendido → no se copia aunque tenga precio.
          {
            id: 3, nombre: 'iPh Ya Vendido', gb: '128', color: 'Rojo',
            bateria: 90, precio_venta: 500, precio_moneda: 'USD',
            condicion: 'usado', estado: 'vendido',
            origen: 'manual', canje_origen: null,
          },
          // Fila filtrada: disponible pero sin precio → no se copia.
          {
            id: 4, nombre: 'iPh Sin Precio', gb: '128', color: 'Azul',
            bateria: 90, precio_venta: 0, precio_moneda: 'USD',
            condicion: 'usado', estado: 'disponible',
            origen: 'manual', canje_origen: null,
          },
        ],
        pagination: { page: 1, limit: 50, total: 4, pages: 1 },
      });

      renderContent();
      await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
      fireEvent.click(await screen.findByRole('button', { name: /Copiar listado/i }));

      await waitFor(() => expect(writeTextSpy).toHaveBeenCalledTimes(1));
      const texto = writeTextSpy.mock.calls[0][0];
      // 2 líneas: los 2 disponibles con precio. Excluye vendido y sin precio.
      const lineas = texto.split('\n');
      expect(lineas).toHaveLength(2);
      expect(lineas[0]).toBe('iPh 17 Pro Max | Blue | 512GB | 100% — USD 1.420');
      expect(lineas[1]).toBe('iPh 17 | Black | 256GB | 100% — USD 840');
    });

    it('salta campos vacíos (color/gb/bateria) en lugar de dejar "| |"', async () => {
      inventarioApi.usados.mockResolvedValue({
        data: [{
          id: 1, nombre: 'iPh sin datos completos',
          gb: null, color: null, bateria: null,
          precio_venta: 500, precio_moneda: 'USD',
          condicion: 'usado', estado: 'disponible',
          origen: 'manual', canje_origen: null,
        }],
        pagination: { page: 1, limit: 50, total: 1, pages: 1 },
      });
      renderContent();
      await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
      fireEvent.click(await screen.findByRole('button', { name: /Copiar listado/i }));

      await waitFor(() => expect(writeTextSpy).toHaveBeenCalled());
      expect(writeTextSpy.mock.calls[0][0]).toBe('iPh sin datos completos — USD 500');
    });

    it('sin disponibles con precio → toast error, no llama writeText', async () => {
      inventarioApi.usados.mockResolvedValue({
        data: [{
          id: 1, nombre: 'Vendido', gb: '128', color: 'X',
          bateria: 90, precio_venta: 500, precio_moneda: 'USD',
          condicion: 'usado', estado: 'vendido',
          origen: 'manual', canje_origen: null,
        }],
        pagination: { page: 1, limit: 50, total: 1, pages: 1 },
      });
      renderContent();
      await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
      fireEvent.click(await screen.findByRole('button', { name: /Copiar listado/i }));

      // No llama writeText — no había nada que copiar.
      await waitFor(() => expect(inventarioApi.usados).toHaveBeenCalled());
      expect(writeTextSpy).not.toHaveBeenCalled();
    });
  });
});
