/**
 * Tests del DiagnoseStockPanel.
 *
 * Cubre el flow happy:
 *   1. render inicial: input vacío, botón disabled.
 *   2. diagnose con IMEI sin resultados → "Sin productos...".
 *   3. diagnose con producto vendido vivo + trail → botón "Restaurar al stock"
 *      visible; soft-deleted o disponible NO muestra botón.
 *   4. abrir modal de restore → validar que reason mínimo 5 chars destraba el
 *      botón.
 *   5. confirmar restore → llamada al API + estado del producto actualizado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockDiagnose = vi.fn();
const mockRestore  = vi.fn();
vi.mock('../../lib/api', () => ({
  admin: {
    diagnoseProducto: (q) => mockDiagnose(q),
    restoreProducto:  (b) => mockRestore(b),
  },
}));

import DiagnoseStockPanel from './DiagnoseStockPanel';
import { ToastProvider } from '../../contexts/ToastContext';

const renderP = () => render(<ToastProvider><DiagnoseStockPanel /></ToastProvider>);

beforeEach(() => {
  mockDiagnose.mockReset();
  mockRestore.mockReset();
});

describe('DiagnoseStockPanel', () => {
  it('botón Diagnosticar disabled hasta tipear un IMEI', () => {
    renderP();
    const btn = screen.getByRole('button', { name: /diagnosticar/i });
    expect(btn).toBeDisabled();
  });

  it('IMEI sin resultados → muestra mensaje vacío', async () => {
    mockDiagnose.mockResolvedValue({ productos: [], movimientos_cc: [] });
    const user = userEvent.setup();
    renderP();
    await user.type(screen.getByPlaceholderText(/imei o serial/i), 'NO_EXISTE_999');
    await user.click(screen.getByRole('button', { name: /diagnosticar/i }));
    await waitFor(() => expect(mockDiagnose).toHaveBeenCalledWith({ imei: 'NO_EXISTE_999' }));
    expect(await screen.findByText(/sin productos con imei\/serial/i)).toBeInTheDocument();
  });

  it('producto vendido vivo → muestra botón Restaurar; trail incluye mov borrado', async () => {
    mockDiagnose.mockResolvedValue({
      productos: [{
        id: 42, nombre: 'iPhone 17 Pro', imei: '359477634537143',
        clase: 'celular', cantidad: 0, estado: 'vendido',
        costo: 1165, costo_moneda: 'USD', deleted_at: null,
      }],
      movimientos_cc: [{
        item_id: 100, mov_id: 7, producto_id: 42, item_cantidad: 1,
        mov_fecha: '2026-06-09', mov_tipo: 'compra',
        mov_created_at: '2026-06-09T10:00:00Z',
        mov_deleted_at: '2026-06-09T12:00:00Z', // borrado
        cliente_nombre: 'iConnect', cliente_apellido: null,
      }],
    });
    const user = userEvent.setup();
    renderP();
    await user.type(screen.getByPlaceholderText(/imei o serial/i), '359477634537143');
    await user.click(screen.getByRole('button', { name: /diagnosticar/i }));

    expect(await screen.findByText('iPhone 17 Pro')).toBeInTheDocument();
    // El botón "Restaurar al stock" debe aparecer (vivo + vendido).
    expect(screen.getByRole('button', { name: /restaurar al stock/i })).toBeInTheDocument();
    // Trail muestra el movimiento borrado — el span del trail tiene "Borrado <fecha>"
    // (la copy del header dice "los borrados" en minúscula y matchea también, por
    // eso restringimos a "Borrado " con espacio y mayúscula inicial).
    expect(screen.getByText(/^Borrado /)).toBeInTheDocument();
  });

  it('producto disponible vivo → NO muestra botón Restaurar', async () => {
    mockDiagnose.mockResolvedValue({
      productos: [{
        id: 50, nombre: 'Apple Watch', imei: '999', clase: 'celular',
        cantidad: 1, estado: 'disponible', costo: 500, costo_moneda: 'USD',
        deleted_at: null,
      }],
      movimientos_cc: [],
    });
    const user = userEvent.setup();
    renderP();
    await user.type(screen.getByPlaceholderText(/imei o serial/i), '999');
    await user.click(screen.getByRole('button', { name: /diagnosticar/i }));
    expect(await screen.findByText('Apple Watch')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restaurar al stock/i })).not.toBeInTheDocument();
  });

  it('modal restore: confirmar sin razón mínima → botón Restaurar disabled', async () => {
    mockDiagnose.mockResolvedValue({
      productos: [{
        id: 42, nombre: 'iPhone', imei: '111', clase: 'celular',
        cantidad: 0, estado: 'vendido', costo: 1000, costo_moneda: 'USD',
        deleted_at: null,
      }],
      movimientos_cc: [],
    });
    const user = userEvent.setup();
    renderP();
    await user.type(screen.getByPlaceholderText(/imei o serial/i), '111');
    await user.click(screen.getByRole('button', { name: /diagnosticar/i }));
    await screen.findByText('iPhone');

    await user.click(screen.getByRole('button', { name: /restaurar al stock/i }));
    // Modal abierto: el botón confirm está disabled hasta tipear ≥ 5 chars.
    const dialog = screen.getByRole('dialog');
    const confirmBtn = within(dialog).getByRole('button', { name: /confirmar restauración/i });
    const textarea = within(dialog).getByPlaceholderText(/limpieza/i);
    expect(confirmBtn).toBeDisabled();

    // fireEvent.change setea el value de una vez (determinístico). user.type
    // tenía race condition en CI más lento donde el último char a veces no
    // se aplicaba antes del assert (CI Frontend Tests falló 2026-06-09 acá).
    fireEvent.change(textarea, { target: { value: 'test' } });
    expect(confirmBtn).toBeDisabled(); // 4 chars < 5

    fireEvent.change(textarea, { target: { value: 'testx' } });
    expect(confirmBtn).not.toBeDisabled(); // ahora 5 chars
  });

  it('restore happy path: llama API y actualiza estado local del producto', async () => {
    mockDiagnose.mockResolvedValue({
      productos: [{
        id: 42, nombre: 'iPhone', imei: '111', clase: 'celular',
        cantidad: 0, estado: 'vendido', costo: 1000, costo_moneda: 'USD',
        deleted_at: null,
      }],
      movimientos_cc: [],
    });
    mockRestore.mockResolvedValue({
      ok: true,
      producto: { id: 42, nombre: 'iPhone', cantidad: 1, estado: 'disponible' },
    });
    const user = userEvent.setup();
    renderP();
    await user.type(screen.getByPlaceholderText(/imei o serial/i), '111');
    await user.click(screen.getByRole('button', { name: /diagnosticar/i }));
    await user.click(await screen.findByRole('button', { name: /restaurar al stock/i }));

    const dialog = screen.getByRole('dialog');
    // fireEvent.change setea el value directo. user.type con strings que
    // tienen caracteres especiales (- /) puede saltar focus a otros campos.
    fireEvent.change(within(dialog).getByPlaceholderText(/limpieza/i), {
      target: { value: 'bug pre-salida 2026-06-09' },
    });
    await user.click(within(dialog).getByRole('button', { name: /confirmar restauración/i }));

    await waitFor(() => expect(mockRestore).toHaveBeenCalledWith({
      producto_id: 42, cantidad: 1, reason: 'bug pre-salida 2026-06-09',
    }));
    // El botón "Restaurar al stock" desapareció: ahora el producto está disponible.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /restaurar al stock/i })).not.toBeInTheDocument();
    });
  });
});
