import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CommandPalette from './CommandPalette';

// 2026-07-13: Mock del hook `useMonedasTenant` (usa TenantContext).
vi.mock('../lib/useMonedasTenant', () => ({
  useMonedasTenant: () => ({ monedaLocal: 'ARS' }),
}));

// Mock del api client — controlamos qué devuelve el search backend.
vi.mock('../lib/api', () => ({
  search: {
    query: vi.fn(),
  },
}));

import { search as searchApi } from '../lib/api';

function renderPalette(props = {}) {
  return render(
    <MemoryRouter>
      <CommandPalette open={true} onClose={() => {}} {...props} />
    </MemoryRouter>
  );
}

describe('CommandPalette', () => {
  beforeEach(() => {
    searchApi.query.mockReset();
  });

  it('no renderiza nada cuando open=false', () => {
    render(
      <MemoryRouter>
        <CommandPalette open={false} onClose={() => {}} />
      </MemoryRouter>
    );
    expect(screen.queryByPlaceholderText(/buscar pantallas/i)).toBeNull();
  });

  it('abre con placeholder que menciona múltiples tipos', () => {
    renderPalette();
    const input = screen.getByPlaceholderText(/buscar pantallas.*productos.*ventas.*clientes/i);
    expect(input).toBeInTheDocument();
  });

  it('muestra sección "Navegación" con todas las pantallas por defecto', () => {
    renderPalette();
    expect(screen.getByText('Navegación')).toBeInTheDocument();
    // Pantallas core visibles.
    expect(screen.getByText('Ventas')).toBeInTheDocument();
    expect(screen.getByText('Inventario')).toBeInTheDocument();
  });

  it('filtra comandos locales al tipear (sin API llamada aún)', () => {
    renderPalette();
    const input = screen.getByPlaceholderText(/buscar/i);
    fireEvent.change(input, { target: { value: 'ventas' } });
    expect(screen.getByText('Ventas')).toBeInTheDocument();
    // Cotizador ya no matchea (label + desc no contienen 'ventas' — bueno,
    // "Alta de ventas + dashboard" sí. Escogemos algo que NO matchee:
    expect(screen.queryByText('Historial')).toBeNull();
  });

  it('NO llama la API si el query tiene menos de 2 chars', async () => {
    renderPalette();
    const input = screen.getByPlaceholderText(/buscar/i);
    fireEvent.change(input, { target: { value: 'a' } });
    // Esperar el debounce (180ms) + buffer.
    await new Promise(r => setTimeout(r, 250));
    expect(searchApi.query).not.toHaveBeenCalled();
  });

  it('llama la API con debounce cuando el query tiene >= 2 chars', async () => {
    searchApi.query.mockResolvedValue({
      q: 'iph', total: 1,
      results: {
        productos: [{ id: 1, label: 'iPhone 15', sublabel: 'IMEI 123', url: '/inventario?buscar=iPhone' }],
        ventas: [], contactos: [], envios: [], cajas: [], egresos: [],
      },
    });
    renderPalette();
    const input = screen.getByPlaceholderText(/buscar/i);
    fireEvent.change(input, { target: { value: 'iph' } });
    // Esperar debounce.
    await waitFor(() => {
      expect(searchApi.query).toHaveBeenCalledWith('iph');
    }, { timeout: 500 });
    // Los resultados API se renderizan en la sección "Productos".
    await waitFor(() => {
      expect(screen.getByText('Productos')).toBeInTheDocument();
      expect(screen.getByText('iPhone 15')).toBeInTheDocument();
    });
  });

  it('renderiza categorías solo cuando tienen resultados', async () => {
    searchApi.query.mockResolvedValue({
      q: 'juan', total: 1,
      results: {
        productos: [],
        ventas: [], contactos: [{ id: 5, label: 'Juan Pérez', sublabel: 'juan@x.com', url: '/contactos' }],
        envios: [], cajas: [], egresos: [],
      },
    });
    renderPalette();
    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: 'juan' } });
    await waitFor(() => {
      expect(screen.getByText('Contactos')).toBeInTheDocument();
      expect(screen.getByText('Juan Pérez')).toBeInTheDocument();
      // Productos (vacía) NO debe aparecer como header.
      expect(screen.queryByText('Productos')).toBeNull();
    });
  });

  it('degrada silencioso si la API falla — sigue mostrando navegación', async () => {
    searchApi.query.mockRejectedValue(new Error('network down'));
    renderPalette();
    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: 'venta' } });
    // Esperar el debounce + fallo silent.
    await new Promise(r => setTimeout(r, 300));
    // La navegación local sigue visible con "venta" filtrando.
    expect(screen.getByText('Navegación')).toBeInTheDocument();
    expect(screen.getByText('Ventas')).toBeInTheDocument();
  });
});
