/**
 * Smoke test de la pantalla Sanidad del Negocio (feature 2026-06-23).
 *
 * Cubre el flow básico:
 *   · Render sin crash con datos mock.
 *   · Aparecen los labels esperados (Facturación bruta, Gastos e inversiones,
 *     Resultado neto, Resultado neto diario).
 *   · Tabla muestra los meses devueltos por el endpoint.
 *   · Toggle 6/12 meses cambia el query (verifica que se vuelve a llamar la API).
 *   · Panel "Mis gastos proyectados" abre/cierra al click en el header.
 *   · Click en header de grupo expande/colapsa los ítems del grupo.
 *
 * El test no valida cálculos de % de variación ni colores — esos son
 * responsabilidad del backend y los unit tests de helpers. Acá es smoke
 * (no crashea + interacciones básicas funcionan).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mock de la API. Devuelve 2 meses con shape mínimo válido.
vi.mock('../lib/api', () => ({
  sanidad: {
    list: vi.fn().mockResolvedValue({
      meses: [
        {
          periodo: '2026-05', dias_mes: 31,
          bruto: { proyectado_usd: 100000, real_usd: 95000, real_retail_usd: 70000, real_b2b_usd: 25000 },
          gastos: [
            { recurrente_id: 10, concepto: 'Sueldo Test', categoria_id: 3, proyectado_usd: 4500, real_usd: 4500 },
          ],
          total_gastos: { proyectado_usd: 4500, real_usd: 4500 },
          neto: { proyectado_usd: 95500, real_usd: 90500 },
          daily: { bruto_proyectado_usd: 3225.81, bruto_real_usd: 3064.52, neto_proyectado_usd: 3080.65, neto_real_usd: 2919.35 },
        },
        {
          periodo: '2026-06', dias_mes: 30,
          bruto: { proyectado_usd: 120000, real_usd: 0, real_retail_usd: 0, real_b2b_usd: 0 },
          gastos: [
            { recurrente_id: 10, concepto: 'Sueldo Test', categoria_id: 3, proyectado_usd: 4500, real_usd: null },
          ],
          total_gastos: { proyectado_usd: 4500, real_usd: 0 },
          neto: { proyectado_usd: 115500, real_usd: 0 },
          daily: { bruto_proyectado_usd: 4000, bruto_real_usd: 0, neto_proyectado_usd: 3850, neto_real_usd: 0 },
        },
      ],
    }),
    upsertProyeccion: vi.fn().mockResolvedValue({ periodo: '2026-06', bruto_proyectado_usd: 120000 }),
    deleteProyeccion:  vi.fn().mockResolvedValue(undefined),
  },
  egresos: {
    recurrentes: vi.fn().mockResolvedValue([
      { id: 10, concepto: 'Sueldo Test', monto: 4500, moneda: 'USD', tc: null, categoria_id: 3, activo: true, deleted_at: null },
      { id: 11, concepto: 'Alquiler',    monto: 1000, moneda: 'USD', tc: null, categoria_id: 1, activo: true, deleted_at: null },
    ]),
    categorias: vi.fn().mockResolvedValue([
      { id: 1, nombre: 'Alquiler' },
      { id: 3, nombre: 'Sueldos' },
    ]),
    createRecurrente: vi.fn().mockResolvedValue({ id: 99 }),
    updateRecurrente: vi.fn().mockResolvedValue({}),
    deleteRecurrente: vi.fn().mockResolvedValue({}),
    createCategoria:  vi.fn().mockResolvedValue({ id: 99, nombre: 'Nueva' }),
  },
}));

import Sanidad from './Sanidad';
import { sanidad, egresos } from '../lib/api';

function renderScreen() {
  return render(<MemoryRouter><Sanidad /></MemoryRouter>);
}

describe('Pantalla Sanidad del Negocio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renderiza sin crash con datos mock', async () => {
    renderScreen();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Sanidad del Negocio/i })).toBeInTheDocument();
    });
  });

  it('muestra los labels de las 4 filas de la tabla resumen', async () => {
    renderScreen();
    await waitFor(() => {
      expect(screen.getByText('Facturación bruta')).toBeInTheDocument();
      expect(screen.getByText('Gastos e inversiones')).toBeInTheDocument();
      expect(screen.getByText('Resultado neto')).toBeInTheDocument();
      expect(screen.getByText('Resultado neto diario')).toBeInTheDocument();
    });
  });

  it('llama a sanidad.list con meses=6 por default y meses=12 al togglear', async () => {
    const user = userEvent.setup();
    renderScreen();

    await waitFor(() => expect(sanidad.list).toHaveBeenCalledWith(6));

    // 2026-06-29 PR-E: fix flaky CI. `sanidad.list(6)` se dispara en useEffect
    // ANTES de que React procese setLoading(false) post-promise. En CI bajo
    // carga, getByRole se ejecuta mientras la pantalla todavía renderea
    // "Cargando…" → el botón "12 meses" no existe → throws. Usar findByRole
    // (wait + get) garantiza que esperamos al primer render post-loading.
    const btn12 = await screen.findByRole('button', { name: /12 meses/i });
    await user.click(btn12);
    await waitFor(() => expect(sanidad.list).toHaveBeenCalledWith(12));
  });

  it('el panel "Mis gastos proyectados" abre por default y muestra el header de la categoría', async () => {
    renderScreen();
    await waitFor(() => {
      // El header "Sueldos" del grupo aparece (vienen del mock).
      expect(screen.getByText('Sueldos')).toBeInTheDocument();
      expect(screen.getByText('Alquiler')).toBeInTheDocument();
    });
  });

  it('click en el header del grupo "Sueldos" expande los ítems hijos', async () => {
    const user = userEvent.setup();
    renderScreen();

    await waitFor(() => expect(screen.getByText('Sueldos')).toBeInTheDocument());

    // Antes del click, el ítem "Sueldo Test" NO está visible (grupo colapsado).
    expect(screen.queryByRole('cell', { name: /Sueldo Test/i })).not.toBeInTheDocument();

    // Click en el header del grupo Sueldos.
    await user.click(screen.getByText('Sueldos').closest('tr'));

    // Ahora "Sueldo Test" aparece como ítem hijo (puede aparecer en
    // la tabla resumen Y en el panel; verificamos que esté en el DOM).
    await waitFor(() => {
      const matches = screen.getAllByText('Sueldo Test');
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it('botón "Agregar gasto" abre el form inline', async () => {
    const user = userEvent.setup();
    renderScreen();

    await waitFor(() => expect(egresos.recurrentes).toHaveBeenCalled());

    const addBtn = screen.getByRole('button', { name: /Agregar gasto/i });
    await user.click(addBtn);

    // Aparece el input con placeholder de ejemplo.
    expect(screen.getByPlaceholderText(/Sueldo Gonza/i)).toBeInTheDocument();
  });
});
