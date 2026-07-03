import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EditarVendedorModal from './EditarVendedorModal';

// Auditoría 2026-07-04 (#509) — modal focalizado para editar el "atendido por"
// del comprobante. Cubre el mount + los 3 caminos de UX que importan:
//   - open=false → no renderiza (evita side effects innecesarios)
//   - pre-carga el valor efectivo (override si existe, sino el vendedor derivado del item)
//   - submit envía el trimmed valor + cierra al éxito
//   - submit con string vacío envía null (borra el override → PDF vuelve al fallback)

function baseState(overrides = {}) {
  return {
    open: true,
    venta: { id: 42, vendedor_nombre: 'Lucas Original', items: [] },
    ...overrides,
  };
}

describe('EditarVendedorModal (#509)', () => {
  it('open=false: no renderiza', () => {
    const { container } = render(
      <EditarVendedorModal
        state={{ open: false, venta: null }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        vendedores={[]}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('pre-carga el vendedor_nombre override cuando existe', () => {
    render(
      <EditarVendedorModal
        state={baseState()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        vendedores={[]}
      />
    );
    const input = screen.getByRole('textbox');
    expect(input.value).toBe('Lucas Original');
  });

  it('sin override, cae al fallback derivado del vendedor_id del primer item', () => {
    const venta = {
      id: 99,
      vendedor_nombre: null,
      items: [{ vendedor_id: 5 }],
    };
    render(
      <EditarVendedorModal
        state={{ open: true, venta }}
        onClose={vi.fn()}
        onSave={vi.fn()}
        vendedores={[{ id: 5, nombre: 'Cata' }]}
      />
    );
    expect(screen.getByRole('textbox').value).toBe('Cata');
  });

  it('submit envía el trimmed valor + cierra al éxito', async () => {
    const onSave = vi.fn().mockResolvedValue();
    const onClose = vi.fn();
    render(
      <EditarVendedorModal
        state={baseState()}
        onClose={onClose}
        onSave={onSave}
        vendedores={[]}
      />
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '   Nuevo Vendedor   ' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(42, 'Nuevo Vendedor'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('submit con vacío envía null (borra el override → PDF cae al fallback)', async () => {
    const onSave = vi.fn().mockResolvedValue();
    render(
      <EditarVendedorModal
        state={baseState()}
        onClose={vi.fn()}
        onSave={onSave}
        vendedores={[]}
      />
    );
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(42, null));
  });

  it('cancelar cierra sin llamar a onSave', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    render(
      <EditarVendedorModal
        state={baseState()}
        onClose={onClose}
        onSave={onSave}
        vendedores={[]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
