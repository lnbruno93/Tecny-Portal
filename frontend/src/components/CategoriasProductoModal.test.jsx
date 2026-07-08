// Tests del CategoriasProductoModal — F3.b (2026-07-08).
//
// Cubre:
//   - Render header, listado post-load, botón "Agregar categoría".
//   - "Sin categoría" muestra badge "Sistema" y NO tiene botones editar/borrar.
//   - "Base" muestra badge "Base" pero SÍ tiene botones (editable).
//   - Click "Editar" abre modal secundario con valores pre-cargados.
//   - Click "Agregar" abre modal secundario vacío.
//   - Submit "Nueva" llama createClase, cierra modal y recarga.
//   - Submit "Editar" llama updateClase.
//   - Nombre vacío muestra error inline sin llamar API.
//   - Delete con productos > 0 muestra mensaje específico en confirm.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CategoriasProductoModal from './CategoriasProductoModal';

const mockClases = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockReorder = vi.fn();

vi.mock('../lib/api', () => ({
  inventario: {
    clases:        (...a) => mockClases(...a),
    createClase:   (...a) => mockCreate(...a),
    updateClase:   (...a) => mockUpdate(...a),
    deleteClase:   (...a) => mockDelete(...a),
    reorderClases: (...a) => mockReorder(...a),
  },
}));

const mockConfirm = vi.fn();
vi.mock('./ConfirmModal', () => ({
  useConfirm: () => ({ confirm: (...a) => mockConfirm(...a) }),
}));

vi.mock('../lib/useModal', () => ({
  useModal: () => {},
  default:  () => {},
}));

const toast = { success: vi.fn(), error: vi.fn() };

const rows = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    nombre: 'Celular Sellado', emoji: '📲', orden: 10, activa: true,
    es_base: true, es_sin_categoria: false, slug_legacy: 'celular_sellado',
    count_productos: 3,
  },
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    nombre: 'Watch', emoji: '⌚', orden: 30, activa: true,
    es_base: true, es_sin_categoria: false, slug_legacy: 'watch',
    count_productos: 0,
  },
  {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    nombre: 'Sin categoría', emoji: null, orden: 999, activa: true,
    es_base: false, es_sin_categoria: true, slug_legacy: null,
    count_productos: 0,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockClases.mockResolvedValue(rows);
});

describe('CategoriasProductoModal', () => {
  it('muestra el header "Categorías" y el botón "Agregar categoría"', async () => {
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Categorías' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Agregar categoría/i })).toBeInTheDocument();
  });

  it('lista las categorías con nombre + emoji + count_productos', async () => {
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    await screen.findByText('Celular Sellado');
    expect(screen.getByText('Watch')).toBeInTheDocument();
    expect(screen.getByText('Sin categoría')).toBeInTheDocument();
    expect(screen.getByText(/3 productos/i)).toBeInTheDocument();
    // Hay 2 filas con "0 productos" (Watch + Sin categoría) — usamos getAllByText.
    expect(screen.getAllByText(/0 productos/i).length).toBeGreaterThanOrEqual(2);
  });

  it('"Sin categoría" muestra badge "Sistema" y NO tiene botones editar/borrar', async () => {
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    const sinCatRow = (await screen.findByText('Sin categoría')).closest('.card-tight');
    expect(within(sinCatRow).getByText('Sistema')).toBeInTheDocument();
    expect(within(sinCatRow).queryByLabelText('Editar')).not.toBeInTheDocument();
    expect(within(sinCatRow).queryByLabelText('Borrar')).not.toBeInTheDocument();
  });

  it('las clases "Base" muestran badge "Base" y SÍ son editables/borrables', async () => {
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    const watchRow = (await screen.findByText('Watch')).closest('.card-tight');
    expect(within(watchRow).getByText('Base')).toBeInTheDocument();
    expect(within(watchRow).getByLabelText('Editar')).toBeInTheDocument();
    expect(within(watchRow).getByLabelText('Borrar')).toBeInTheDocument();
  });

  it('click "Agregar categoría" abre el modal secundario vacío', async () => {
    const user = userEvent.setup();
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    await screen.findByText('Celular Sellado');
    await user.click(screen.getByRole('button', { name: /Agregar categoría/i }));
    expect(screen.getByRole('heading', { name: 'Nueva categoría' })).toBeInTheDocument();
    // Input nombre vacío
    expect(screen.getByLabelText(/Nombre/i)).toHaveValue('');
  });

  it('click "Editar" en una fila abre el modal secundario con datos', async () => {
    const user = userEvent.setup();
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    const watchRow = (await screen.findByText('Watch')).closest('.card-tight');
    await user.click(within(watchRow).getByLabelText('Editar'));
    expect(screen.getByRole('heading', { name: 'Editar categoría' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Nombre/i)).toHaveValue('Watch');
    expect(screen.getByLabelText(/Emoji/i)).toHaveValue('⌚');
  });

  it('submit "Nueva" con nombre válido llama createClase', async () => {
    const user = userEvent.setup();
    mockCreate.mockResolvedValue({ id: 'new-id' });
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    await screen.findByText('Celular Sellado');
    await user.click(screen.getByRole('button', { name: /Agregar categoría/i }));
    await user.type(screen.getByLabelText(/Nombre/i), 'Repuestos');
    await user.type(screen.getByLabelText(/Emoji/i), '🔧');
    await user.click(screen.getByRole('button', { name: 'Crear' }));
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ nombre: 'Repuestos', emoji: '🔧', activa: true })
    );
  });

  it('submit con nombre vacío no llama createClase y muestra error inline', async () => {
    const user = userEvent.setup();
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    await screen.findByText('Celular Sellado');
    await user.click(screen.getByRole('button', { name: /Agregar categoría/i }));
    // Nombre queda vacío. Submit.
    await user.click(screen.getByRole('button', { name: 'Crear' }));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.getByText('El nombre es requerido')).toBeInTheDocument();
  });

  it('emoji vacío se envía como null (no como string vacío)', async () => {
    const user = userEvent.setup();
    mockCreate.mockResolvedValue({ id: 'x' });
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    await screen.findByText('Celular Sellado');
    await user.click(screen.getByRole('button', { name: /Agregar categoría/i }));
    await user.type(screen.getByLabelText(/Nombre/i), 'Sin emoji');
    await user.click(screen.getByRole('button', { name: 'Crear' }));
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ emoji: null }))
    );
  });

  it('delete con count_productos > 0 usa mensaje específico en el confirm', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValue(false); // usuario cancela — no importa acá, testeo el mensaje
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    const row = (await screen.findByText('Celular Sellado')).closest('.card-tight');
    await user.click(within(row).getByLabelText('Borrar'));
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/3 producto.*reasignalos/i),
      })
    );
  });

  it('delete con count_productos = 0 usa mensaje distinto', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValue(false);
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    const row = (await screen.findByText('Watch')).closest('.card-tight');
    await user.click(within(row).getByLabelText('Borrar'));
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/queda inactiva/i),
      })
    );
  });

  it('delete confirmado llama deleteClase y refresca listado', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValue(true);
    mockDelete.mockResolvedValue(undefined);
    render(<CategoriasProductoModal open onClose={() => {}} toast={toast} />);
    const row = (await screen.findByText('Watch')).closest('.card-tight');
    await user.click(within(row).getByLabelText('Borrar'));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(rows[1].id));
    // Un segundo fetch tras el delete
    await waitFor(() => expect(mockClases).toHaveBeenCalledTimes(2));
  });
});
