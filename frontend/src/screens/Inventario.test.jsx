import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// PR-X3 Red B2B: mockeamos useAuth para poder controlar si el user tiene cap
// `cross_tenant.write` (gate del tab "Pendientes Red B2B").
const mockUser = { value: null }; // mutable handle — los tests reasignan .value
vi.mock('../contexts/AuthContext', async (orig) => {
  const actual = await orig();
  return { ...actual, useAuth: () => ({ user: mockUser.value, loading: false }) };
});

// Smoke tests T-02 — verificamos monte + carga de catálogos + apertura modal.
vi.mock('../lib/api', () => {
  const paginated = { data: [], pagination: { page: 1, pages: 1, total: 0 } };
  return {
    inventario: {
      productos:        vi.fn().mockResolvedValue(paginated),
      metricas:         vi.fn().mockResolvedValue({ total: 0 }),
      categorias:       vi.fn().mockResolvedValue([]),
      depositos:        vi.fn().mockResolvedValue([]),
      proveedoresList:  vi.fn().mockResolvedValue([]),
      createProducto:   vi.fn(),
      updateProducto:   vi.fn(),
      deleteProducto:   vi.fn(),
      bulkProductos:    vi.fn(),
      bulkCategorias:   vi.fn(),
      bulkDeleteDisponibles: vi.fn(),
      createCategoria:  vi.fn(),
      deleteCategoria:  vi.fn(),
      createDeposito:   vi.fn(),
      deleteDeposito:   vi.fn(),
    },
    proveedores: {
      list: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, pages: 1, total: 0 } }),
    },
    cajas: { listMetodosPago: vi.fn().mockResolvedValue([]) },
    redB2b: {
      productosPendingReview: {
        list:       vi.fn().mockResolvedValue({ pendientes: [] }),
        confirmNew: vi.fn(),
        mergeInto:  vi.fn(),
      },
    },
  };
});

import { inventario as inventarioApi, redB2b } from '../lib/api';
import Inventario from './Inventario';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider, usePageActions } from '../contexts/PageActionsContext';

function ActionTrigger() {
  const { primaryAction } = usePageActions();
  return primaryAction ? <button onClick={primaryAction.onClick}>__abrir__</button> : null;
}

function renderInventario(initialEntries = ['/inventario']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ToastProvider><ConfirmProvider><PageActionsProvider>
        <Inventario />
        <ActionTrigger />
        <LocationProbe />
      </PageActionsProvider></ConfirmProvider></ToastProvider>
    </MemoryRouter>
  );
}

// 2026-06-30 F-08: probe de URL para tests de persistencia de filtros.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}{loc.search}</div>;
}

describe('Pantalla Inventario', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock state. Por defecto sin user (tests preexistentes
    // no esperan el tab Red B2B).
    mockUser.value = null;
    redB2b.productosPendingReview.list.mockResolvedValue({ pendientes: [] });
  });

  it('monta sin crashear y carga catálogos + grilla', async () => {
    renderInventario();
    await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
    await waitFor(() => expect(inventarioApi.categorias).toHaveBeenCalled());
    await waitFor(() => expect(inventarioApi.depositos).toHaveBeenCalled());
  });

  it('con 1 producto, lo renderiza en la grilla', async () => {
    inventarioApi.productos.mockResolvedValueOnce({
      data: [{
        id: 1, nombre: 'iPhone 13 test', clase: 'celular', estado: 'disponible',
        costo: 0, precio_venta: 0, costo_moneda: 'USD', precio_moneda: 'USD',
        cantidad: 1, gb: null, color: null, bateria: null, imei: null,
        tipo_carga: 'unitario', categoria_id: null, deposito_id: null,
        proveedor: null, observaciones: null, condicion: 'nuevo', oculto: false,
        categoria_nombre: null, deposito_nombre: null,
      }],
      pagination: { page: 1, pages: 1, total: 1 },
    });
    renderInventario();
    expect(await screen.findByText('iPhone 13 test')).toBeInTheDocument();
  });

  it('abre modal "Agregar producto" sin crashear', async () => {
    renderInventario();
    await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('__abrir__'));
    // El header del modal es "Agregar producto" cuando editId=null.
    expect(await screen.findByRole('heading', { name: 'Agregar producto' })).toBeInTheDocument();
    // El campo Nombre es obligatorio → siempre renderizado.
    expect(await screen.findByText(/Nombre/)).toBeInTheDocument();
  });

  // ─── PR-X3 Red B2B — tab "Pendientes Red B2B" en Inventario ───────────────
  // El tab se gate-keepea por la cap `cross_tenant.write`. Sin cap → tab
  // oculto (UX no se contamina para usuarios que no usan Red B2B). Con cap
  // → tab visible y clickeable, contenido delegado a RedB2BPendingReviewContent.

  it('PR-X3: NO muestra tab "Pendientes Red B2B" sin cap cross_tenant.write', async () => {
    mockUser.value = { id: 1, caps: ['inventario.ver'] }; // sin cap red B2B
    renderInventario();
    await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
    expect(screen.queryByRole('tab', { name: /Pendientes Red B2B/i })).not.toBeInTheDocument();
  });

  it('PR-X3: muestra tab "Pendientes Red B2B" CON cap cross_tenant.write', async () => {
    mockUser.value = { id: 1, caps: ['inventario.ver', 'cross_tenant.write'] };
    renderInventario();
    expect(await screen.findByRole('tab', { name: /Pendientes Red B2B/i })).toBeInTheDocument();
  });

  it('PR-X3: click en tab "Pendientes Red B2B" renderea el contenido del feature', async () => {
    mockUser.value = { id: 1, caps: ['cross_tenant.write'] };
    redB2b.productosPendingReview.list.mockResolvedValue({
      pendientes: [{
        id: 50,
        nombre: 'iPhone X Cross-Tenant Pending',
        stock: 3,
        partner: { id: 7, nombre: 'PartnerSeller', slug: 'partner-seller' },
        created_at: '2026-06-25T10:00:00Z',
      }],
    });
    renderInventario();
    const pendingTab = await screen.findByRole('tab', { name: /Pendientes Red B2B/i });
    fireEvent.click(pendingTab);
    // Verificamos que el contenido del tab se renderea: el nombre del producto
    // mockeado debe aparecer (viene de RedB2BPendingReviewContent).
    expect(await screen.findByText('iPhone X Cross-Tenant Pending')).toBeInTheDocument();
  });

  // ─── Multi-país F3 — dropdowns moneda gated por tenant.pais ───────────────
  // El form de alta de producto tiene dropdowns para "Moneda costo" y "Moneda
  // venta". Para tenant AR, las opciones son USD + ARS. Para tenant UY, USD +
  // UYU (sin ARS). El default precio_moneda es USD para ambos (Inventario
  // negocia en USD por convención del portal — el cliente paga en local).

  it('F3 multi-país: tenant UY abre form alta y los dropdowns muestran UYU en vez de ARS', async () => {
    mockUser.value = { id: 1, caps: [], tenant: { pais: 'UY', moneda_local: 'UYU' } };
    renderInventario();
    await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('__abrir__'));
    await screen.findByRole('heading', { name: 'Agregar producto' });
    // El form tiene 2 selects con valor inicial 'USD' (defaults del form).
    // Buscamos todos los <option> que pertenezcan a un select con value USD/UYU.
    // Validación robusta: existe al menos un option UYU en el modal.
    const opts = Array.from(document.querySelectorAll('select option'));
    const monedas = opts.map(o => o.value).filter(v => v === 'UYU' || v === 'ARS');
    expect(monedas).toContain('UYU');
    expect(monedas).not.toContain('ARS');
  });

  it('F3 multi-país: tenant AR abre form alta y los dropdowns muestran ARS', async () => {
    mockUser.value = { id: 1, caps: [], tenant: { pais: 'AR', moneda_local: 'ARS' } };
    renderInventario();
    await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('__abrir__'));
    await screen.findByRole('heading', { name: 'Agregar producto' });
    const opts = Array.from(document.querySelectorAll('select option'));
    const monedas = opts.map(o => o.value).filter(v => v === 'UYU' || v === 'ARS');
    expect(monedas).toContain('ARS');
    expect(monedas).not.toContain('UYU');
  });

  // ─── Auditoría 2026-06-30 F-08: filtros persisten en URL ─────────────────
  describe('F-08 — filtros persisten en URL', () => {
    it('cambiar tab clase ("Celulares") agrega ?clase=celular', async () => {
      renderInventario();
      await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
      fireEvent.click(screen.getByText('Celulares'));
      await waitFor(() => {
        expect(screen.getByTestId('location').textContent).toMatch(/[?&]clase=celular/);
      });
    });

    it('tipear en buscador agrega ?q=...', async () => {
      renderInventario();
      await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
      const input = screen.getByPlaceholderText(/Buscar nombre, IMEI/i);
      fireEvent.change(input, { target: { value: 'samsung' } });
      await waitFor(() => {
        expect(screen.getByTestId('location').textContent).toMatch(/[?&]q=samsung/);
      });
    });

    it('default (clase=todos + vista=no_vendidos + sin q) NO escribe params', async () => {
      renderInventario();
      await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
      const text = screen.getByTestId('location').textContent;
      expect(text).not.toMatch(/[?&]clase=/);
      expect(text).not.toMatch(/[?&]vista=/);
      expect(text).not.toMatch(/[?&]q=/);
    });

    it('re-mount con ?clase=celular activa el tab correcto', async () => {
      renderInventario(['/inventario?clase=celular']);
      await waitFor(() => expect(inventarioApi.productos).toHaveBeenCalled());
      // El tab "Celulares" debe estar activo (className 'on').
      const tabCel = screen.getByText('Celulares');
      expect(tabCel.className).toMatch(/on/);
      // El backend recibió clase=celular en los params.
      expect(inventarioApi.productos).toHaveBeenCalledWith(
        expect.objectContaining({ clase: 'celular' })
      );
    });
  });

  // ─── Auditoría 2026-06-30 F-26: catOptions/provOptions no se reconstruyen
  // por fila ─────────────────────────────────────────────────────────────
  // Antes el .map(p => { const catOptions = categorias.map(...) }) ejecutaba
  // categorias.map() N veces por render (1 por producto). Con useMemo se
  // ejecuta 1 vez por cambio real de categorias. Test indirecto: render con
  // 50 productos + spy en Array.prototype.map → contar invocaciones sobre
  // el array de categorias específico.
  describe('F-26 — catOptions/provOptions memoizados', () => {
    it('grilla con 50 productos renderea sin recomputar options por fila', async () => {
      // Setear 2 categorias y 50 productos.
      const cats = [{ id: 1, nombre: 'iPhone' }, { id: 2, nombre: 'Samsung' }];
      inventarioApi.categorias.mockResolvedValueOnce(cats);
      const productos50 = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1, nombre: `Prod ${i + 1}`, clase: 'celular', estado: 'disponible',
        costo: 0, precio_venta: 0, costo_moneda: 'USD', precio_moneda: 'USD',
        cantidad: 1, gb: null, color: null, bateria: null, imei: null,
        tipo_carga: 'unitario', categoria_id: 1, deposito_id: null,
        proveedor: null, observaciones: null, condicion: 'nuevo', oculto: false,
        categoria_nombre: 'iPhone', deposito_nombre: null,
      }));
      inventarioApi.productos.mockResolvedValueOnce({
        data: productos50,
        pagination: { page: 1, pages: 1, total: 50 },
      });

      // Spy en .map del array de categorias específico — registramos cuántas
      // veces se llama después de que el provider montó. Ejecutado vía spy
      // sobre `Array.prototype.map` cabe — pero filtramos al subject `cats`
      // para evitar contar map() de OTROS arrays.
      let mapCalls = 0;
      const origMap = Array.prototype.map;
      // eslint-disable-next-line no-extend-native
      Array.prototype.map = function patchedMap(...args) {
        if (this === cats) mapCalls++;
        return origMap.apply(this, args);
      };

      try {
        renderInventario();
        // Esperar hasta que la grilla tenga las 50 filas renderizadas.
        await waitFor(() => {
          expect(screen.getByText('Prod 50')).toBeInTheDocument();
        });
        // Antes del fix F-26: 50+ llamadas (1 por fila). Con useMemo: típicamente
        // 1–4 (mount + algunos re-renders del provider). Margen de seguridad: < 10.
        expect(mapCalls).toBeLessThan(10);
      } finally {
        // eslint-disable-next-line no-extend-native
        Array.prototype.map = origMap;
      }
    });
  });
});
