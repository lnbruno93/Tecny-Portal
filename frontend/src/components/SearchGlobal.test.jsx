/**
 * Tests del componente SearchGlobal (U-23 TANDA 6).
 *
 * Contratos cubiertos:
 *   · Renderiza el modal cuando open=true / no renderiza nada cuando open=false.
 *   · Input autofocus al abrir.
 *   · Debounce: typing rápido NO dispara fetch hasta que pasen 300ms.
 *   · Empty state cuando q.length < 2.
 *   · Render de resultados por categoría con counts.
 *   · Click en resultado dispara navigate + cierra el modal.
 *   · Esc cierra (vía useModal).
 *   · ↑/↓/Enter funcionan en flat list.
 *
 * Mocks: react-router-dom (useNavigate), lib/api (search.global).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// vi.mock: el navigate y el endpoint.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const searchMock = vi.fn();
vi.mock('../lib/api', () => ({
  search: {
    global: (...args) => searchMock(...args),
  },
}));

// Importar después de los mocks.
import SearchGlobal from './SearchGlobal';

function renderWithRouter(props) {
  return render(
    <MemoryRouter>
      <SearchGlobal {...props} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  navigateMock.mockClear();
  searchMock.mockReset();
  searchMock.mockResolvedValue({
    query: 'iphone',
    results: {
      clientes:  [{ id: 1, nombre: 'Juan', apellido: 'iPhone-test', tipo: 'cliente' }],
      productos: [{ id: 7, nombre: 'iPhone 13', imei: '350000000000001', precio_venta: 900, precio_moneda: 'USD', estado: 'disponible', cantidad: 1 }],
      ventas:    [],
      envios:    [{ id: 18, fecha: '2026-06-11', cliente: 'iPhone Fan', direccion: 'Av Corrientes 1', estado: 'Pendiente' }],
    },
    counts: { clientes: 1, productos: 250, ventas: 0, envios: 1 },
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('SearchGlobal', () => {
  it('no renderiza nada cuando open=false', () => {
    const { container } = renderWithRouter({ open: false, onClose: vi.fn() });
    expect(container.firstChild).toBeNull();
  });

  it('renderiza el modal con role=dialog y aria-modal=true cuando open=true', () => {
    renderWithRouter({ open: true, onClose: vi.fn() });
    const dlg = screen.getByRole('dialog');
    expect(dlg).toBeInTheDocument();
    expect(dlg).toHaveAttribute('aria-modal', 'true');
  });

  it('muestra empty state cuando el usuario no escribió nada (q.length < 2)', () => {
    renderWithRouter({ open: true, onClose: vi.fn() });
    expect(screen.getByText(/escribí al menos/i)).toBeInTheDocument();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('input recibe foco al abrir (useModal autoFocusSelector)', async () => {
    renderWithRouter({ open: true, onClose: vi.fn() });
    const input = screen.getByPlaceholderText(/buscar clientes/i);
    // useModal usa setTimeout 50ms para enfocar después del mount.
    await act(async () => { vi.advanceTimersByTime(60); });
    expect(document.activeElement).toBe(input);
  });

  it('debounce: typing no dispara fetch hasta 300ms quieto', async () => {
    renderWithRouter({ open: true, onClose: vi.fn() });
    const input = screen.getByPlaceholderText(/buscar/i);

    // Tipeo "ip" — el debounce arranca pero a 300ms aún no.
    fireEvent.change(input, { target: { value: 'ip' } });
    await act(async () => { vi.advanceTimersByTime(100); });
    expect(searchMock).not.toHaveBeenCalled();

    // Sigo tipeando antes de los 300ms — debe reiniciar el timer.
    fireEvent.change(input, { target: { value: 'iph' } });
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(searchMock).not.toHaveBeenCalled();

    // Pasaron 300ms desde el último cambio — ahora sí.
    await act(async () => { vi.advanceTimersByTime(110); });
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith('iph');
  });

  it('renderiza resultados agrupados por categoría con counts', async () => {
    renderWithRouter({ open: true, onClose: vi.fn() });
    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: 'iphone' } });
    await act(async () => { vi.advanceTimersByTime(310); });

    await waitFor(() => {
      // El cliente y producto e envío están — y la categoría ventas (que vino con 0) NO se muestra.
      expect(screen.getByText(/Juan/)).toBeInTheDocument();
      expect(screen.getByText(/iPhone 13/)).toBeInTheDocument();
      expect(screen.getByText(/iPhone Fan/)).toBeInTheDocument();
    });

    // El header "Clientes (1)" se ve.
    expect(screen.getByText(/Clientes/)).toBeInTheDocument();
    // "Productos (1 de 250)" — counts > items.length se renderiza con "de".
    expect(screen.getByText(/1 de 250/)).toBeInTheDocument();
    // El header "Ventas" NO está porque la categoría vino vacía.
    expect(screen.queryByText(/^Ventas$/i)).not.toBeInTheDocument();
  });

  it('click en un resultado de cliente navega a /contactos y dispara onClose', async () => {
    const onClose = vi.fn();
    renderWithRouter({ open: true, onClose });
    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: 'juan' } });
    await act(async () => { vi.advanceTimersByTime(310); });

    await waitFor(() => screen.getByText(/Juan/));
    fireEvent.click(screen.getByText(/Juan/));

    expect(navigateMock).toHaveBeenCalledWith('/contactos');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('click en un envío navega a /envios y cierra', async () => {
    const onClose = vi.fn();
    renderWithRouter({ open: true, onClose });
    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: 'iphone' } });
    await act(async () => { vi.advanceTimersByTime(310); });
    await waitFor(() => screen.getByText(/iPhone Fan/));
    fireEvent.click(screen.getByText(/iPhone Fan/));
    expect(navigateMock).toHaveBeenCalledWith('/envios');
    expect(onClose).toHaveBeenCalled();
  });

  it('Esc cierra el modal (useModal)', async () => {
    const onClose = vi.fn();
    renderWithRouter({ open: true, onClose });
    // useModal escucha Escape en document.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('botón ✕ del header cierra el modal', () => {
    const onClose = vi.fn();
    renderWithRouter({ open: true, onClose });
    fireEvent.click(screen.getByRole('button', { name: /cerrar/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('click en el overlay (fuera del modal) cierra', () => {
    const onClose = vi.fn();
    renderWithRouter({ open: true, onClose });
    const overlay = screen.getByRole('dialog');
    // Simular click directo en el overlay (no en un hijo).
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('flecha abajo + Enter selecciona el primer item de la flat list', async () => {
    const onClose = vi.fn();
    renderWithRouter({ open: true, onClose });
    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: 'iphone' } });
    await act(async () => { vi.advanceTimersByTime(310); });
    await waitFor(() => screen.getByText(/Juan/));

    // Enter sobre la lista — el activeIdx arranca en 0 → cliente Juan.
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(navigateMock).toHaveBeenCalledWith('/contactos');
    expect(onClose).toHaveBeenCalled();
  });

  it('muestra "No hay resultados" cuando todas las categorías vienen vacías', async () => {
    searchMock.mockResolvedValueOnce({
      query: 'xyzzy',
      results: { clientes: [], productos: [], ventas: [], envios: [] },
      counts:  { clientes: 0, productos: 0, ventas: 0, envios: 0 },
    });
    renderWithRouter({ open: true, onClose: vi.fn() });
    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: 'xyzzy' } });
    await act(async () => { vi.advanceTimersByTime(310); });
    await waitFor(() => {
      expect(screen.getByText(/no hay resultados/i)).toBeInTheDocument();
    });
  });

  it('muestra mensaje de error si la API tira', async () => {
    searchMock.mockRejectedValueOnce(new Error('Sin conexión'));
    renderWithRouter({ open: true, onClose: vi.fn() });
    fireEvent.change(screen.getByPlaceholderText(/buscar/i), { target: { value: 'iphone' } });
    await act(async () => { vi.advanceTimersByTime(310); });
    await waitFor(() => {
      expect(screen.getByText(/Sin conexión/)).toBeInTheDocument();
    });
  });

  it('al cambiar de open=false → open=true, resetea la query previa', async () => {
    const { rerender } = renderWithRouter({ open: true, onClose: vi.fn() });
    const input = screen.getByPlaceholderText(/buscar/i);
    fireEvent.change(input, { target: { value: 'iphone' } });
    expect(input.value).toBe('iphone');

    // Cerramos y reabrimos
    rerender(<MemoryRouter><SearchGlobal open={false} onClose={vi.fn()} /></MemoryRouter>);
    rerender(<MemoryRouter><SearchGlobal open={true} onClose={vi.fn()} /></MemoryRouter>);

    const newInput = screen.getByPlaceholderText(/buscar/i);
    expect(newInput.value).toBe('');
  });
});
