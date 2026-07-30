// Tests del CompraProveedorDetalleModal — vista + edición del detalle de
// una compra a proveedor.
//
// Fase A (2026-07-30): vista read-only con todos los items.
// Fase B (2026-07-30): modo edit — editar campos, agregar y remover items,
//   con sync a Inventario y guards de producto vendido.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import CompraProveedorDetalleModal from './CompraProveedorDetalleModal';
import { ToastProvider } from '../contexts/ToastContext';

// Mock del module api (updateMovimiento) — retorna una promesa configurable
// por test para verificar el body enviado.
vi.mock('../lib/api', () => ({
  proveedores: {
    updateMovimiento: vi.fn(),
  },
}));
import { proveedores as provApi } from '../lib/api';

function Wrapper({ children }) {
  return <ToastProvider>{children}</ToastProvider>;
}
const renderModal = (props) =>
  render(<CompraProveedorDetalleModal {...props} />, { wrapper: Wrapper });

function mkMov(overrides = {}) {
  return {
    id: 1,
    fecha: '2026-07-15',
    tipo: 'compra',
    monto: 14985,
    moneda: 'USD',
    monto_usd: 14985,
    caja_id: null,
    caja_nombre: null,
    notas: null,
    items: [
      { id: 10, producto: 'iPad Pro 11"', modelo: null, tamano: '256', color: 'Space Black', imei_serial: 'SHQWPFH7069', valor: 1175, verificado: true, notas: null },
      { id: 11, producto: '14 Pro', modelo: null, tamano: '256', color: 'Gold', imei_serial: '3519', valor: 3810, verificado: false, notas: null },
      { id: 12, producto: 'MacBook Neo', modelo: null, tamano: '512', color: 'Blush ESP', imei_serial: 'HPW0', valor: 10000, verificado: false, notas: null },
    ],
    ...overrides,
  };
}

const proveedor = { id: 5, nombre: 'Celnyx' };

beforeEach(() => {
  cleanup();
  provApi.updateMovimiento.mockReset();
});

// ─── Fase A: render + view mode ───────────────────────────────────────
describe('render condicional', () => {
  it('sin movimiento: no renderiza', () => {
    const { container } = renderModal({ movimiento: null, proveedor, onClose: vi.fn() });
    expect(container.querySelector('.modal')).toBeNull();
  });

  it('con movimiento: renderiza dialog con aria-labelledby', () => {
    const { container } = renderModal({ movimiento: mkMov(), proveedor, onClose: vi.fn() });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog.getAttribute('aria-labelledby')).toBe('compra-detalle-title');
  });
});

describe('header (view)', () => {
  it('muestra tipo, fecha (DD/MM/YY), monto USD, nombre proveedor', () => {
    const { container } = renderModal({ movimiento: mkMov(), proveedor, onClose: vi.fn() });
    const t = container.textContent;
    expect(t).toContain('Compra');
    expect(t).toContain('15/07/26');
    expect(t).toContain('USD 14.985,00');
    expect(t).toContain('Celnyx');
  });

  it('sin caja_id: "A crédito (CC)"', () => {
    const { container } = renderModal({
      movimiento: mkMov({ caja_id: null }), proveedor, onClose: vi.fn(),
    });
    expect(container.textContent).toContain('A crédito');
  });

  it('con caja_nombre: muestra la caja', () => {
    const { container } = renderModal({
      movimiento: mkMov({ caja_id: 7, caja_nombre: 'Efectivo USD' }),
      proveedor, onClose: vi.fn(),
    });
    expect(container.textContent).toContain('Efectivo USD');
  });

  it('tipo=devolucion: label "Devolución"', () => {
    const { container } = renderModal({
      movimiento: mkMov({ tipo: 'devolucion' }), proveedor, onClose: vi.fn(),
    });
    expect(container.textContent).toContain('Devolución');
  });
});

describe('items (view)', () => {
  it('renderiza TODOS los items — no solo el primero + N', () => {
    const { container } = renderModal({ movimiento: mkMov(), proveedor, onClose: vi.fn() });
    const t = container.textContent;
    expect(t).toContain('iPad Pro 11"');
    expect(t).toContain('14 Pro');
    expect(t).toContain('MacBook Neo');
    expect(t).toContain('SHQWPFH7069');
    expect(t).toContain('HPW0');
  });

  it('placeholder cuando items === 0', () => {
    const { container } = renderModal({
      movimiento: mkMov({ items: [] }), proveedor, onClose: vi.fn(),
    });
    expect(container.textContent).toContain('no tiene productos asociados');
  });

  it('tfoot con suma cuando >1 items', () => {
    const { container } = renderModal({ movimiento: mkMov(), proveedor, onClose: vi.fn() });
    const tfoot = container.querySelector('tfoot');
    expect(tfoot.textContent).toContain('3 items');
    expect(tfoot.textContent).toContain('14.985,00');
  });

  it('sin tfoot cuando items === 1', () => {
    const { container } = renderModal({
      movimiento: mkMov({ items: [{ id: 1, producto: 'Único', valor: 500 }] }),
      proveedor, onClose: vi.fn(),
    });
    expect(container.querySelector('tfoot')).toBeNull();
  });
});

describe('discrepancia (view)', () => {
  it('nota explicativa cuando suma items ≠ monto', () => {
    const { container } = renderModal({
      movimiento: mkMov({ monto: 14500 }), proveedor, onClose: vi.fn(),
    });
    expect(container.textContent).toContain('difiere');
    expect(container.textContent).toContain('descuentos');
  });

  it('sin nota cuando suma == monto', () => {
    const { container } = renderModal({ movimiento: mkMov(), proveedor, onClose: vi.fn() });
    expect(container.textContent).not.toContain('difiere');
  });
});

describe('acciones (view)', () => {
  it('botón X del header cierra', () => {
    const onClose = vi.fn();
    const { container } = renderModal({ movimiento: mkMov(), proveedor, onClose });
    fireEvent.click(container.querySelector('[aria-label="Cerrar"]'));
    expect(onClose).toHaveBeenCalled();
  });

  it('botón "Cerrar" del footer cierra', () => {
    const onClose = vi.fn();
    const { getByText } = renderModal({ movimiento: mkMov(), proveedor, onClose });
    fireEvent.click(getByText('Cerrar'));
    expect(onClose).toHaveBeenCalled();
  });
});

// ─── Fase B: modo edit ────────────────────────────────────────────────
describe('modo edit — activación', () => {
  it('tipo=compra: botón "Editar" visible y activo', () => {
    const { getByText } = renderModal({ movimiento: mkMov(), proveedor, onClose: vi.fn() });
    const btn = getByText('Editar');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('tipo=devolucion: sin botón "Editar" (backend rechaza)', () => {
    const { queryByText } = renderModal({
      movimiento: mkMov({ tipo: 'devolucion' }), proveedor, onClose: vi.fn(),
    });
    expect(queryByText('Editar')).toBeNull();
  });

  it('click "Editar" muestra form editable con inputs por item', () => {
    const { getByText, container } = renderModal({
      movimiento: mkMov(), proveedor, onClose: vi.fn(),
    });
    fireEvent.click(getByText('Editar'));
    // Debería haber inputs con los valores actuales
    const inputs = container.querySelectorAll('input[type="text"], input[type="number"]');
    expect(inputs.length).toBeGreaterThan(0);
    // Botón "Guardar cambios" reemplaza a "Cerrar"
    expect(getByText('Guardar cambios')).toBeInTheDocument();
    expect(getByText('Cancelar')).toBeInTheDocument();
  });
});

describe('modo edit — agregar y remover items', () => {
  it('botón "+ Agregar producto" agrega una fila vacía', () => {
    const { getByText, container } = renderModal({
      movimiento: mkMov({ items: [{ id: 1, producto: 'X', valor: 100 }] }),
      proveedor, onClose: vi.fn(),
    });
    fireEvent.click(getByText('Editar'));
    // 1 fila + tfoot
    let rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    fireEvent.click(getByText('+ Agregar producto'));
    rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
  });

  it('botón trash de una fila la remueve', () => {
    const { getByText, container, getAllByTitle } = renderModal({
      movimiento: mkMov({
        items: [
          { id: 1, producto: 'A', valor: 100 },
          { id: 2, producto: 'B', valor: 200 },
        ],
      }),
      proveedor, onClose: vi.fn(),
    });
    fireEvent.click(getByText('Editar'));
    const trashBtns = getAllByTitle('Eliminar item');
    expect(trashBtns.length).toBe(2);
    fireEvent.click(trashBtns[0]);
    // Post-remove: solo 1 fila
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
  });
});

describe('modo edit — guardar', () => {
  it('cancelar vuelve a view mode sin llamar API', () => {
    const { getByText, queryByText } = renderModal({
      movimiento: mkMov(), proveedor, onClose: vi.fn(),
    });
    fireEvent.click(getByText('Editar'));
    fireEvent.click(getByText('Cancelar'));
    // De vuelta en view: aparece "Editar" de nuevo
    expect(getByText('Editar')).toBeInTheDocument();
    expect(queryByText('Guardar cambios')).toBeNull();
    expect(provApi.updateMovimiento).not.toHaveBeenCalled();
  });

  it('click "Guardar cambios" envía payload con items diff-eados por id', async () => {
    provApi.updateMovimiento.mockResolvedValue({ id: 1, items: [], monto: 300 });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const { getByText, getAllByTitle } = renderModal({
      movimiento: mkMov({
        items: [
          { id: 10, producto: 'A', valor: 100 },
          { id: 11, producto: 'B', valor: 200 },
        ],
      }),
      proveedor, onClose, onSaved,
    });
    fireEvent.click(getByText('Editar'));
    // Elimino el primer item + agrego uno nuevo
    fireEvent.click(getAllByTitle('Eliminar item')[0]);
    fireEvent.click(getByText('+ Agregar producto'));
    fireEvent.click(getByText('Guardar cambios'));

    await waitFor(() => expect(provApi.updateMovimiento).toHaveBeenCalledTimes(1));
    const [movId, body] = provApi.updateMovimiento.mock.calls[0];
    expect(movId).toBe(1);
    // Body debe tener items: [item2 con id=11, item nuevo sin id]
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe(11); // item que quedó (B)
    expect(body.items[1].id).toBeUndefined(); // item nuevo
    // Callbacks post-success
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('backend 409 producto vendido: muestra error, no cierra', async () => {
    const err = new Error('Producto vendido');
    err.body = { productos_vendidos: ['iPhone Vendido'] };
    provApi.updateMovimiento.mockRejectedValue(err);
    const onClose = vi.fn();
    const { getByText, container, getAllByTitle } = renderModal({
      movimiento: mkMov({ items: [{ id: 1, producto: 'X', valor: 100 }] }),
      proveedor, onClose,
    });
    fireEvent.click(getByText('Editar'));
    fireEvent.click(getAllByTitle('Eliminar item')[0]);
    fireEvent.click(getByText('Guardar cambios'));

    await waitFor(() => expect(provApi.updateMovimiento).toHaveBeenCalled());
    // El modal NO se cerró
    expect(onClose).not.toHaveBeenCalled();
    // Aparece el mensaje de error en el modal
    await waitFor(() => {
      expect(container.textContent).toMatch(/Error/i);
    });
  });
});
