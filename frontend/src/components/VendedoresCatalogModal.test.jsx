/**
 * Smoke tests del VendedoresCatalogModal (2026-07-01).
 *
 * Cubre:
 *   - Render del header + input + botón agregar cuando abre.
 *   - Fetch de vendedores al abrir y render de la lista.
 *   - Empty state cuando el catálogo está vacío.
 *   - Agregar vendedor invoca vendsApi.create y dispara onChange con la
 *     lista actualizada.
 *   - Eliminar (con confirm=true) invoca vendsApi.delete y dispara onChange.
 *   - Cuando open=false no renderiza nada.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockList   = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();

vi.mock('../lib/api', () => ({
  vendedores: {
    list:   (...args) => mockList(...args),
    create: (...args) => mockCreate(...args),
    delete: (...args) => mockDelete(...args),
  },
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({
    toast: {
      success: vi.fn(),
      error:   vi.fn(),
      info:    vi.fn(),
    },
  }),
}));

// confirm() por default retorna true (usuario aceptó) — los tests que
// prueben el flow "cancelar delete" pueden overridear con mockConfirm.
const mockConfirm = vi.fn();
vi.mock('./ConfirmModal', () => ({
  useConfirm: () => mockConfirm,
}));

// Bypass useModal (Esc/scroll-lock/focus-trap — no aporta al smoke test).
vi.mock('../lib/useModal', () => ({
  useModal: () => {},
}));

import VendedoresCatalogModal from './VendedoresCatalogModal';

describe('VendedoresCatalogModal', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockCreate.mockReset();
    mockDelete.mockReset();
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
  });

  it('no renderiza nada cuando open=false', () => {
    mockList.mockResolvedValue([]);
    const { container } = render(
      <VendedoresCatalogModal open={false} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
    // El fetch NO se dispara si el modal no se abre.
    expect(mockList).not.toHaveBeenCalled();
  });

  it('renderiza header + input y muestra la lista al abrir', async () => {
    mockList.mockResolvedValue([
      { id: 1, nombre: 'Ana Perez' },
      { id: 2, nombre: 'Juan Gomez' },
    ]);

    render(<VendedoresCatalogModal open={true} onClose={() => {}} />);

    expect(screen.getByRole('heading', { name: /equipo de ventas/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/nombre del nuevo vendedor/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Ana Perez')).toBeInTheDocument();
      expect(screen.getByText('Juan Gomez')).toBeInTheDocument();
    });
  });

  it('muestra empty state cuando no hay vendedores', async () => {
    mockList.mockResolvedValue([]);

    render(<VendedoresCatalogModal open={true} onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/sin vendedores registrados/i)).toBeInTheDocument();
    });
  });

  it('agregar vendedor: llama create + notifica onChange con la nueva lista', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ id: 42, nombre: 'Nuevo Vendedor' });
    const onChange = vi.fn();

    render(
      <VendedoresCatalogModal open={true} onClose={() => {}} onChange={onChange} />,
    );

    // Esperar al fetch inicial.
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    const input = screen.getByPlaceholderText(/nombre del nuevo vendedor/i);
    await user.type(input, 'Nuevo Vendedor');
    await user.click(screen.getByRole('button', { name: /agregar/i }));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ nombre: 'Nuevo Vendedor' });
    });
    expect(onChange).toHaveBeenCalledWith([{ id: 42, nombre: 'Nuevo Vendedor' }]);
  });

  it('eliminar vendedor: confirm=true → llama delete + onChange con lista sin el eliminado', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue([
      { id: 1, nombre: 'Ana Perez' },
      { id: 2, nombre: 'Juan Gomez' },
    ]);
    mockDelete.mockResolvedValue({});
    const onChange = vi.fn();

    render(
      <VendedoresCatalogModal open={true} onClose={() => {}} onChange={onChange} />,
    );

    await waitFor(() => expect(screen.getByText('Ana Perez')).toBeInTheDocument());

    // Buscar el botón de eliminar por aria-label — cada fila tiene el suyo.
    const deleteBtn = screen.getByRole('button', { name: /eliminar ana perez/i });
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalledWith(1);
    });
    expect(onChange).toHaveBeenCalledWith([{ id: 2, nombre: 'Juan Gomez' }]);
  });

  it('eliminar vendedor: confirm=false → NO llama delete', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue([{ id: 1, nombre: 'Ana Perez' }]);
    mockConfirm.mockResolvedValue(false); // el usuario cancela

    render(<VendedoresCatalogModal open={true} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('Ana Perez')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /eliminar ana perez/i }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
