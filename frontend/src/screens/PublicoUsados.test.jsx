// Test de la pantalla pública del share link (2026-07-11).
// Cubre: loading, error (404, 410), render con datos, buscar, filtro precio,
// toggle vista cards/lista, empty state.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../lib/api', () => ({
  publico: {
    usados: vi.fn(),
  },
}));

import { publico } from '../lib/api';
import PublicoUsados from './PublicoUsados';

function renderPublico(token = 'tokenValido12345') {
  return render(
    <MemoryRouter initialEntries={[`/publico/usados/${token}`]}>
      <Routes>
        <Route path="/publico/usados/:token" element={<PublicoUsados />} />
      </Routes>
    </MemoryRouter>
  );
}

const equiposMock = [
  {
    id: 1, nombre: 'iPhone 17 Pro Max', gb: '512', color: 'Blue', bateria: 100,
    precio_venta: 1420, precio_moneda: 'USD',
    clase_nombre: 'Celular Usado', clase_emoji: '♻️',
    created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  },
  {
    id: 2, nombre: 'iPhone 15 Pro Max', gb: '256', color: 'Natural', bateria: 87,
    precio_venta: 640, precio_moneda: 'USD',
    clase_nombre: 'Celular Usado', clase_emoji: '♻️',
    created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
  },
  {
    id: 3, nombre: 'iPhone 13 Pro', gb: '128', color: 'Sierra Blue', bateria: 79,
    precio_venta: 380, precio_moneda: 'USD',
    clase_nombre: 'Celular Usado', clase_emoji: '♻️',
    created_at: new Date(Date.now() - 10 * 86400000).toISOString(),
  },
];

const responseOK = {
  tenant: { nombre: 'Tek Haus', pais: 'AR' },
  config: {
    whatsapp: '+54 9 11 1234-5678',
    mensaje_extra: null,
    mostrar_bateria: true,
    mostrar_precio: true,
  },
  equipos: equiposMock,
  count: 3,
  actualizado_en: new Date().toISOString(),
};

describe('PublicoUsados — pantalla pública del share link', () => {
  beforeEach(() => vi.clearAllMocks());

  it('render inicial muestra spinner de loading', () => {
    publico.usados.mockImplementation(() => new Promise(() => {})); // never resolves
    renderPublico();
    expect(screen.getByText(/Cargando listado/i)).toBeInTheDocument();
  });

  it('carga OK → muestra header con nombre del tenant + hero + equipos', async () => {
    publico.usados.mockResolvedValue(responseOK);
    renderPublico();
    expect(await screen.findByText('Tek Haus')).toBeInTheDocument();
    expect(screen.getByText('Usados disponibles')).toBeInTheDocument();
    expect(screen.getByText('3 equipos')).toBeInTheDocument();
    expect(screen.getByText('iPhone 17 Pro Max')).toBeInTheDocument();
    expect(screen.getByText('iPhone 15 Pro Max')).toBeInTheDocument();
    expect(screen.getByText('iPhone 13 Pro')).toBeInTheDocument();
  });

  it('agrupa por línea automáticamente (17, 15, 13)', async () => {
    publico.usados.mockResolvedValue(responseOK);
    renderPublico();
    await screen.findByText('iPhone 17 Pro Max');
    // Headers de grupo.
    expect(screen.getByText(/Línea 17 & Variables/i)).toBeInTheDocument();
    expect(screen.getByText(/Línea 15 & Variables/i)).toBeInTheDocument();
    expect(screen.getByText(/Línea 13 & Variables/i)).toBeInTheDocument();
  });

  it('buscar filtra equipos (busca en nombre + gb + color + bateria)', async () => {
    publico.usados.mockResolvedValue(responseOK);
    renderPublico();
    await screen.findByText('iPhone 17 Pro Max');
    const input = screen.getByPlaceholderText(/Buscar por modelo/i);
    fireEvent.change(input, { target: { value: '17' } });
    // Solo el 17 queda visible.
    await waitFor(() => {
      expect(screen.getByText('iPhone 17 Pro Max')).toBeInTheDocument();
      expect(screen.queryByText('iPhone 15 Pro Max')).not.toBeInTheDocument();
      expect(screen.queryByText('iPhone 13 Pro')).not.toBeInTheDocument();
    });
  });

  it('filtro precio min/max reduce el listado', async () => {
    publico.usados.mockResolvedValue(responseOK);
    renderPublico();
    await screen.findByText('iPhone 17 Pro Max');
    const minInput = screen.getByLabelText(/Precio mínimo/i);
    fireEvent.change(minInput, { target: { value: '500' } });
    await waitFor(() => {
      // 1.420 y 640 pasan; 380 queda fuera.
      expect(screen.getByText('iPhone 17 Pro Max')).toBeInTheDocument();
      expect(screen.getByText('iPhone 15 Pro Max')).toBeInTheDocument();
      expect(screen.queryByText('iPhone 13 Pro')).not.toBeInTheDocument();
    });
  });

  it('chip preset "USD 500 – 800" filtra el rango', async () => {
    publico.usados.mockResolvedValue(responseOK);
    renderPublico();
    await screen.findByText('iPhone 17 Pro Max');
    fireEvent.click(screen.getByRole('button', { name: /USD 500 – 800/ }));
    await waitFor(() => {
      // Solo el 640 (que está en 500-800) queda.
      expect(screen.queryByText('iPhone 17 Pro Max')).not.toBeInTheDocument();
      expect(screen.getByText('iPhone 15 Pro Max')).toBeInTheDocument();
      expect(screen.queryByText('iPhone 13 Pro')).not.toBeInTheDocument();
    });
  });

  it('empty state cuando el filtro no matchea nada', async () => {
    publico.usados.mockResolvedValue(responseOK);
    renderPublico();
    await screen.findByText('iPhone 17 Pro Max');
    fireEvent.change(screen.getByPlaceholderText(/Buscar por modelo/i), { target: { value: 'samsung' } });
    await waitFor(() => {
      expect(screen.getByText(/Sin resultados/i)).toBeInTheDocument();
    });
  });

  it('error 404 → mensaje "Listado no encontrado"', async () => {
    const err = new Error('not_found');
    err.status = 404;
    err.code = 'not_found';
    publico.usados.mockRejectedValue(err);
    renderPublico();
    expect(await screen.findByText(/Listado no encontrado/i)).toBeInTheDocument();
  });

  it('error 410 (link_inactivo) → mensaje "ya no está disponible"', async () => {
    const err = new Error('link_inactivo');
    err.status = 410;
    err.code = 'link_inactivo';
    publico.usados.mockRejectedValue(err);
    renderPublico();
    expect(await screen.findByText(/ya no está disponible/i)).toBeInTheDocument();
  });

  it('mostrar_precio=false → oculta price + filtro precio + chips', async () => {
    publico.usados.mockResolvedValue({
      ...responseOK,
      config: { ...responseOK.config, mostrar_precio: false },
      equipos: equiposMock.map(e => ({ ...e, precio_venta: null })),
    });
    renderPublico();
    await screen.findByText('iPhone 17 Pro Max');
    // Los inputs de precio NO deben estar visibles.
    expect(screen.queryByLabelText(/Precio mínimo/i)).not.toBeInTheDocument();
    // El chip preset tampoco.
    expect(screen.queryByRole('button', { name: /USD 500 – 800/ })).not.toBeInTheDocument();
    // "Consultar por WhatsApp" en su lugar (o similar).
    expect(screen.getAllByText(/Consultar por WhatsApp/i).length).toBeGreaterThan(0);
  });

  it('toggle Lista cambia el layout (agrega class view-list al contenedor)', async () => {
    publico.usados.mockResolvedValue(responseOK);
    const { container } = renderPublico();
    await screen.findByText('iPhone 17 Pro Max');
    // Antes: no tiene view-list.
    expect(container.querySelector('.pub.view-list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Lista/ }));
    await waitFor(() => {
      expect(container.querySelector('.pub.view-list')).not.toBeNull();
    });
  });
});
