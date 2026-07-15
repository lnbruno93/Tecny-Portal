import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../lib/api', () => {
  const paginated = { data: [], pagination: { page: 1, pages: 1, total: 0 } };
  return {
    ventas: {
      dashboard: vi.fn().mockResolvedValue({
        ingresos: [], metodos_pago: [], diferencias: { sobrepagos: 0, faltantes: 0, neto: 0 },
        costos_usd: 0, egresos_usd: 0, ganancia_neta_usd: 0, inversion_canjes_usd: 0,
        margen_pct: 0, ticket_promedio_usd: 0, ventas_count: 0,
        unidades: { celulares: 0, accesorios: 0 },
        por_etiqueta: [], por_horario: [], top_productos: [], top_vendedores: [],
      }),
      list: vi.fn().mockResolvedValue(paginated),
      rapidas: vi.fn().mockResolvedValue(paginated),
      etiquetas: vi.fn().mockResolvedValue([]),
      metodosPago: vi.fn().mockResolvedValue([{ id: 1, nombre: 'Efectivo', moneda: 'ARS', es_financiera: false }]),
      garantias: vi.fn().mockResolvedValue([]),
      create: vi.fn(), update: vi.fn(), delete: vi.fn(),
      comprobantes: vi.fn(), getComprobante: vi.fn(), uploadComprobante: vi.fn(),
      createEtiqueta: vi.fn(), deleteEtiqueta: vi.fn(),
      createGarantia: vi.fn(), updateGarantia: vi.fn(), deleteGarantia: vi.fn(),
      createEgreso: vi.fn(), createRapida: vi.fn(), deleteRapida: vi.fn(), updateRapida: vi.fn(),
    },
    inventario: {
      productos: vi.fn().mockResolvedValue(paginated),
      // 2026-07-11: el picker del canje ahora consume `clases_producto`
      // (categoría real F3, con emoji + editable por tenant) en vez de
      // `categorias` (Colecciones legacy). El mock ahora refleja el shape
      // real de /api/inventario/clases: incluye emoji, activa, es_sin_categoria.
      clases: vi.fn().mockResolvedValue([
        { id: '11111111-1111-1111-1111-111111111111', nombre: 'Celular Sellado', emoji: '📱', activa: true, es_sin_categoria: false, slug_legacy: 'celular_sellado' },
        { id: '22222222-2222-2222-2222-222222222222', nombre: 'Celular Usado', emoji: '♻️', activa: true, es_sin_categoria: false, slug_legacy: 'celular_usado' },
      ]),
      // categorias sigue mockeado por si otras vistas lo usan (Colecciones
      // legacy en Inventario, etc.). Post-#554 Ventas ya no lo consume.
      categorias: vi.fn().mockResolvedValue([]),
    },
    vendedores: { list: vi.fn().mockResolvedValue([]) },
    cuentas: { clientes: vi.fn().mockResolvedValue(paginated) },
    contactos: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
    // Tema C en-vivo: pct_financiera para el preview de ganancia real.
    config: { get: vi.fn().mockResolvedValue({ pct_financiera: 5 }) },
    envios: { list: vi.fn().mockResolvedValue(paginated) },
    ocr: { extract: vi.fn().mockResolvedValue({ monto: null }) },
  };
});

import { ventas as ventasApi, cuentas as cuentasApi } from '../lib/api';
import Ventas from './Ventas';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { PageActionsProvider, usePageActions } from '../contexts/PageActionsContext';

// La acción "Nueva venta" se registra vía contexto (la dispara el botón del Shell).
// Como el test no monta el Shell, exponemos un botón que dispara esa acción.
function ActionTrigger() {
  const { primaryAction } = usePageActions();
  return primaryAction ? <button onClick={primaryAction.onClick}>__abrir__</button> : null;
}

function renderVentas(initialEntries = ['/ventas']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ToastProvider><ConfirmProvider><PageActionsProvider>
        <Ventas />
        <ActionTrigger />
        <LocationProbe />
      </PageActionsProvider></ConfirmProvider></ToastProvider>
    </MemoryRouter>
  );
}

// 2026-06-30 F-07: probe que espía la URL actual. Lo renderean los tests de
// persistencia para asertar que setPeriodoRange/setEstadoFilter/setSearch
// escriben los query params correctos.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}{loc.search}</div>;
}

describe('Pantalla Ventas', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('monta sin crashear y carga el dashboard + lista', async () => {
    renderVentas();
    await waitFor(() => expect(ventasApi.dashboard).toHaveBeenCalled());
    await waitFor(() => expect(ventasApi.list).toHaveBeenCalled());
  });

  it('abre "Nueva venta" sin crashear con clientes B2B paginados', async () => {
    // El endpoint de clientes B2B está paginado → { data, pagination }.
    cuentasApi.clientes.mockResolvedValueOnce({
      data: [{ id: 7, nombre: 'Mayorista', apellido: 'SA' }],
      pagination: { page: 1, pages: 1, total: 1 },
    });
    renderVentas();
    await waitFor(() => expect(cuentasApi.clientes).toHaveBeenCalled());
    fireEvent.click(await screen.findByText('__abrir__'));
    // El selector de cliente CC debe renderizar la opción (clientesCC tratado como array).
    expect(await screen.findByText('Mayorista SA')).toBeInTheDocument();
  });

  it('canje: arranca sin equipos, agregar muestra los 9 campos', async () => {
    renderVentas();
    fireEvent.click(await screen.findByText('__abrir__'));
    // Estado inicial: ningún canje cargado.
    expect(await screen.findByText(/Sin equipos en canje/)).toBeInTheDocument();
    // Click "+ Agregar equipo" → aparece bloque con los inputs.
    fireEvent.click(screen.getByText(/Agregar equipo/));
    expect(await screen.findByText('Equipo 1')).toBeInTheDocument();
    // Verificar que aparecen los inputs clave (descripción + IMEI + valor toma + % batería + categoría).
    expect(screen.getByPlaceholderText(/iPhone 13 Pro/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('35...')).toBeInTheDocument();
    expect(screen.getByText('Valor toma (USD)')).toBeInTheDocument();
    expect(screen.getByText('% Batería')).toBeInTheDocument();
    // 2026-07-11: label renombrado de "Categoría Inventario" (Colecciones legacy)
    // a "Categoría" (clases_producto real F3).
    expect(screen.getByText('Categoría')).toBeInTheDocument();
    // "A inventario" arranca tildado (default = true para canjes nuevos).
    const aInvCheckbox = screen.getByLabelText('A inventario');
    expect(aInvCheckbox.checked).toBe(true);
  });

  it('canje: agregar 2 equipos y quitar uno deja 1 equipo', async () => {
    renderVentas();
    fireEvent.click(await screen.findByText('__abrir__'));
    const btnAgregar = screen.getByText(/Agregar equipo/);
    fireEvent.click(btnAgregar);
    fireEvent.click(btnAgregar);
    await screen.findByText('Equipo 2');
    // Quitar el primero (botón "X" con aria-label="Quitar equipo")
    const quitarBtns = screen.getAllByLabelText('Quitar equipo');
    expect(quitarBtns).toHaveLength(2);
    fireEvent.click(quitarBtns[0]);
    // Después de quitar, queda 1 botón Quitar.
    await waitFor(() => {
      expect(screen.getAllByLabelText('Quitar equipo')).toHaveLength(1);
    });
  });

  // Auditoría 2026-06-30 F-13/14: regresión clásica del key={index}. Cuando se
  // quita un ítem del medio, React reutiliza el DOM y el draft del input
  // "salta" al ítem siguiente. Con _id estable, cada input conserva su valor.
  it('cart: quitar item 0 NO afecta los valores cargados en items posteriores', async () => {
    renderVentas();
    fireEvent.click(await screen.findByText('__abrir__'));
    // Agregar 3 ítems manuales.
    const btnManual = screen.getByText(/Ítem manual/);
    fireEvent.click(btnManual);
    fireEvent.click(btnManual);
    fireEvent.click(btnManual);
    let rows = await screen.findAllByTestId('venta-item-row');
    expect(rows).toHaveLength(3);
    // Tipear texto distintivo en el input de descripción del item 1 (índice 1)
    // y el item 2 (índice 2). Cada fila tiene 4 inputs (descripcion/cant/precio/moneda).
    const desc1 = rows[1].querySelector('input[placeholder="Producto"]');
    const desc2 = rows[2].querySelector('input[placeholder="Producto"]');
    fireEvent.change(desc1, { target: { value: 'ITEM-MEDIO' } });
    fireEvent.change(desc2, { target: { value: 'ITEM-ULTIMO' } });
    expect(desc1.value).toBe('ITEM-MEDIO');
    expect(desc2.value).toBe('ITEM-ULTIMO');
    // Quitar el primero (la X del item 0).
    const xBtn0 = rows[0].querySelector('button');
    fireEvent.click(xBtn0);
    // Tras quitar, quedan 2 filas. La fila 0 (antes 1) debe seguir mostrando
    // 'ITEM-MEDIO' y la fila 1 (antes 2) debe seguir mostrando 'ITEM-ULTIMO'.
    rows = await screen.findAllByTestId('venta-item-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('input[placeholder="Producto"]').value).toBe('ITEM-MEDIO');
    expect(rows[1].querySelector('input[placeholder="Producto"]').value).toBe('ITEM-ULTIMO');
  });

  // Auditoría 2026-06-30 F-10: Esc cierra el modal "Nueva venta" (useModal aplicado).
  it('modal Nueva venta: Esc cierra el modal', async () => {
    renderVentas();
    fireEvent.click(await screen.findByText('__abrir__'));
    // El modal está montado: detectable por el botón "Ítem manual" (solo
    // existe dentro del modal). "Nueva venta" aparece en el sidebar Y el
    // header del modal — usamos "Ítem manual" para discriminar.
    expect(await screen.findByText(/Ítem manual/)).toBeInTheDocument();
    // Disparar Esc en el document — useModal escucha en document.
    fireEvent.keyDown(document, { key: 'Escape' });
    // Tras Esc, el botón "Ítem manual" desaparece (el modal se desmonta).
    await waitFor(() => {
      expect(screen.queryByText(/Ítem manual/)).not.toBeInTheDocument();
    });
  });

  // ─── Auditoría 2026-06-30 F-07: filtros persisten en URL ─────────────────
  // Reglas: cambiar un filtro escribe el param, defaults NO se escriben,
  // re-mount con un query lee el filtro correcto.
  describe('F-07 — filtros persisten en URL', () => {
    it('click en "Este mes" agrega ?periodo=mes a la URL', async () => {
      renderVentas();
      await waitFor(() => expect(ventasApi.list).toHaveBeenCalled());
      // Click el segmento "Este mes".
      fireEvent.click(screen.getByText('Este mes'));
      await waitFor(() => {
        expect(screen.getByTestId('location').textContent).toMatch(/[?&]periodo=mes/);
      });
    });

    it('cambiar estado a "Acreditados" agrega ?estado=acreditado', async () => {
      renderVentas();
      await waitFor(() => expect(ventasApi.list).toHaveBeenCalled());
      fireEvent.click(screen.getByText('Acreditados'));
      await waitFor(() => {
        expect(screen.getByTestId('location').textContent).toMatch(/[?&]estado=acreditado/);
      });
    });

    it('tipear en el buscador agrega ?q=...', async () => {
      renderVentas();
      await waitFor(() => expect(ventasApi.list).toHaveBeenCalled());
      const input = screen.getByPlaceholderText(/Order ID/i);
      fireEvent.change(input, { target: { value: 'iphone' } });
      await waitFor(() => {
        expect(screen.getByTestId('location').textContent).toMatch(/[?&]q=iphone/);
      });
    });

    it('default ("Hoy" + sin estado + sin q) NO escribe params en la URL', async () => {
      renderVentas();
      await waitFor(() => expect(ventasApi.list).toHaveBeenCalled());
      // Mount inicial — la URL no debería tener periodo/estado/q.
      const text = screen.getByTestId('location').textContent;
      expect(text).not.toMatch(/[?&]periodo=/);
      expect(text).not.toMatch(/[?&]estado=/);
      expect(text).not.toMatch(/[?&]q=/);
    });

    it('re-mount con ?periodo=mes lee el filtro correcto del URL', async () => {
      renderVentas(['/ventas?periodo=mes']);
      await waitFor(() => expect(ventasApi.list).toHaveBeenCalled());
      // El segmento "Este mes" debe estar activo (className 'on').
      const segMes = screen.getByText('Este mes');
      expect(segMes.className).toMatch(/on/);
    });
  });

  // task #134 (2026-07-15): deep-link desde Cmd+K.
  // Cuando el usuario clickea un resultado de "Ventas" en la búsqueda global,
  // navegamos a /ventas?open=<id> y Ventas.jsx auto-abre el modal de edición.
  describe('Deep-link ?open=<id> (Cmd+K)', () => {
    it('llama a ventas.list con { id } cuando llega ?open=42', async () => {
      renderVentas(['/ventas?open=42']);
      // Además del list del dashboard normal (que puede o no correr según
      // filtros), esperamos una llamada con { id: '42', limit: 1 }.
      await waitFor(() => {
        const calls = ventasApi.list.mock.calls;
        const found = calls.some((args) => {
          const p = args[0] || {};
          return String(p.id) === '42' && Number(p.limit) === 1;
        });
        expect(found).toBe(true);
      });
    });

    it('abre el modal en modo edición cuando la venta se encuentra', async () => {
      // Fixture mínimo de venta retail (mismo shape que devuelve /api/ventas).
      const ventaFixture = {
        id: 42, order_id: 'ORD-26-abc123', fecha: '2026-07-01', hora: '10:00',
        cliente_nombre: 'Cliente Test', cliente_id: null, cliente_cc_id: null,
        etiqueta_id: null, garantia_id: null, tc_venta: null,
        estado: 'acreditado', notas: '', origen: 'retail',
        items: [], canjes: [], pagos: [], comprobantes: [],
      };
      ventasApi.list.mockImplementation((params) => {
        if (params && String(params.id) === '42') {
          return Promise.resolve({ data: [ventaFixture], pagination: { page: 1, pages: 1, total: 1 } });
        }
        return Promise.resolve({ data: [], pagination: { page: 1, pages: 1, total: 0 } });
      });
      renderVentas(['/ventas?open=42']);
      // El modal de edición muestra el título "Editar venta".
      expect(await screen.findByText('Editar venta')).toBeInTheDocument();
    });

    it('limpia ?open del URL después de intentar abrir', async () => {
      renderVentas(['/ventas?open=42']);
      await waitFor(() => {
        // La URL post-effect no debería contener ?open=
        const text = screen.getByTestId('location').textContent;
        expect(text).not.toMatch(/[?&]open=/);
      });
    });
  });
});
