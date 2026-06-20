// Tests del listado Clientes — cubrimos los flows que tocan al backend:
//   1. Render con N rows + headers correctos
//   2. Cambio de filtro (Seg) dispara fetch con los params correctos
//   3. Búsqueda con debounce — dispara después de 300ms con search param
//   4. Empty state cuando no hay rows + botón clear limpia filtros

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../../lib/api.js', () => ({
  adminApi: {
    listTenants: vi.fn(),
    me: vi.fn(),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import { adminApi } from '../../lib/api.js';
import Clientes from '../Clientes.jsx';

function renderClientes() {
  return render(
    <BrowserRouter>
      <Clientes />
    </BrowserRouter>
  );
}

function fakeTenants(count = 3) {
  return Array.from({ length: count }).map((_, i) => ({
    id: i + 1,
    nombre: `Empresa ${i + 1}`,
    slug: `empresa-${i + 1}`,
    plan: i === 0 ? 'trial' : 'starter',
    custom_mrr_usd: null,
    suspended_at: null,
    suspended_reason: null,
    trial_until: null,
    created_at: '2026-05-01T00:00:00Z',
    notes: null,
    users_count: 3 + i,
    last_venta_at: i === 2 ? null : '2026-06-15T10:00:00Z',
    signups_30d: 0,
    mrr_usd: i === 0 ? 0 : 49,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockReset();
});

describe('Clientes', () => {
  it('renderiza tabla con N rows y headers correctos', async () => {
    adminApi.listTenants.mockResolvedValue(fakeTenants(3));

    renderClientes();

    // Headers (column titles)
    await waitFor(() => {
      expect(screen.getByText('Empresa')).toBeInTheDocument();
    });
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('MRR')).toBeInTheDocument();
    expect(screen.getByText('Usuarios')).toBeInTheDocument();
    expect(screen.getByText('Salud')).toBeInTheDocument();
    expect(screen.getByText('Estado')).toBeInTheDocument();
    expect(screen.getByText('Actividad')).toBeInTheDocument();

    // Rows
    expect(screen.getByText('Empresa 1')).toBeInTheDocument();
    expect(screen.getByText('Empresa 2')).toBeInTheDocument();
    expect(screen.getByText('Empresa 3')).toBeInTheDocument();

    // Listado count en el card title
    expect(screen.getByText(/listado · 3/i)).toBeInTheDocument();

    // El primer fetch fue sin filtros (mode='todas')
    expect(adminApi.listTenants).toHaveBeenCalledWith({});
  });

  it('cambio de filtro a Trial dispara listTenants con plan=trial', async () => {
    adminApi.listTenants.mockResolvedValue(fakeTenants(1));

    renderClientes();

    await waitFor(() => {
      expect(adminApi.listTenants).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('tab', { name: /trial/i }));

    await waitFor(() => {
      expect(adminApi.listTenants).toHaveBeenCalledWith({ plan: 'trial' });
    });
  });

  it('búsqueda con debounce dispara fetch después de 300ms con search param', async () => {
    vi.useFakeTimers();
    adminApi.listTenants.mockResolvedValue(fakeTenants(2));

    renderClientes();

    // El primer fetch (sin filtros) ya está en curso por useEffect mount.
    // Avanzamos timers y resolvemos para limpiar el efecto inicial.
    await vi.advanceTimersByTimeAsync(0);

    const input = screen.getByLabelText(/buscar tenant/i);
    fireEvent.change(input, { target: { value: 'aurora' } });

    // Inmediatamente: NO se debe haber disparado un nuevo fetch
    expect(adminApi.listTenants).toHaveBeenCalledTimes(1);

    // Avanzar 299ms: aún no debería dispararse
    await vi.advanceTimersByTimeAsync(299);
    expect(adminApi.listTenants).toHaveBeenCalledTimes(1);

    // Avanzar 1ms más (total 300ms): debe dispararse
    await vi.advanceTimersByTimeAsync(1);
    expect(adminApi.listTenants).toHaveBeenCalledTimes(2);
    expect(adminApi.listTenants).toHaveBeenLastCalledWith({ search: 'aurora' });

    vi.useRealTimers();
  });

  it('empty state con botón clear cuando los filtros no devuelven nada', async () => {
    // Primer fetch (sin filtros) devuelve algo, después al filtrar
    // devuelve []. Así podemos validar el botón "Limpiar filtros".
    adminApi.listTenants
      .mockResolvedValueOnce(fakeTenants(2))
      .mockResolvedValueOnce([]);

    renderClientes();

    await waitFor(() => {
      expect(screen.getByText('Empresa 1')).toBeInTheDocument();
    });

    // Click en Suspendidas → trigger un fetch que devuelve []
    fireEvent.click(screen.getByRole('tab', { name: /suspendidas/i }));

    await waitFor(() => {
      expect(screen.getByText(/sin resultados para los filtros actuales/i)).toBeInTheDocument();
    });

    // El botón "Limpiar filtros" aparece y reactiva el modo "Todas"
    // (próximo fetch devuelve la lista llena de nuevo).
    adminApi.listTenants.mockResolvedValueOnce(fakeTenants(2));
    fireEvent.click(screen.getByRole('button', { name: /limpiar filtros/i }));

    await waitFor(() => {
      expect(screen.getByText('Empresa 1')).toBeInTheDocument();
    });
  });
});
