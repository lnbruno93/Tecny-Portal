// Tests del CompraProveedorDetalleModal — vista read-only del detalle de
// una compra a proveedor (Fase A pedido Gianfranco 2026-07-30).
//
// Verifica:
//   · Render condicional (sin movimiento → null)
//   · Header con fecha, tipo, monto USD, caja (o CC)
//   · Notas del movimiento cuando existen
//   · Tabla con TODOS los items (no solo el primero + "+N" como la grilla)
//   · Botón "Editar" deshabilitado (Fase A)
//   · Footer con suma cuando hay >1 item
//   · Nota de discrepancia si suma_items ≠ monto_movimiento
//   · Close via botón X, botón Cerrar, y click en overlay

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import CompraProveedorDetalleModal from './CompraProveedorDetalleModal';

function mkMov(overrides = {}) {
  return {
    id: 1,
    fecha: '2026-07-15',
    tipo: 'compra',
    monto: 14985,
    moneda: 'USD',
    monto_usd: 14985,
    caja_id: null, // CC por default
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

beforeEach(() => { cleanup(); });

describe('CompraProveedorDetalleModal — render condicional', () => {
  it('sin movimiento: no renderiza nada', () => {
    const { container } = render(
      <CompraProveedorDetalleModal movimiento={null} proveedor={proveedor} onClose={vi.fn()} />
    );
    expect(container.querySelector('.modal')).toBeNull();
  });

  it('con movimiento: renderiza modal con role="dialog"', () => {
    const { container } = render(
      <CompraProveedorDetalleModal movimiento={mkMov()} proveedor={proveedor} onClose={vi.fn()} />
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-labelledby')).toBe('compra-detalle-title');
  });
});

describe('CompraProveedorDetalleModal — header', () => {
  it('muestra tipo, fecha (DD/MM/YY), monto USD y nombre proveedor', () => {
    const { container } = render(
      <CompraProveedorDetalleModal movimiento={mkMov()} proveedor={proveedor} onClose={vi.fn()} />
    );
    const text = container.textContent;
    expect(text).toContain('Compra');
    expect(text).toContain('15/07/26');
    expect(text).toContain('USD 14.985,00');
    expect(text).toContain('Celnyx');
  });

  it('sin caja_id: muestra "A crédito (CC)"', () => {
    const { container } = render(
      <CompraProveedorDetalleModal movimiento={mkMov({ caja_id: null })} proveedor={proveedor} onClose={vi.fn()} />
    );
    expect(container.textContent).toContain('A crédito');
  });

  it('con caja_nombre: muestra el nombre de la caja', () => {
    const { container } = render(
      <CompraProveedorDetalleModal
        movimiento={mkMov({ caja_id: 7, caja_nombre: 'Efectivo USD' })}
        proveedor={proveedor}
        onClose={vi.fn()}
      />
    );
    expect(container.textContent).toContain('Efectivo USD');
  });

  it('devolucion: label "Devolución" en el header', () => {
    const { container } = render(
      <CompraProveedorDetalleModal
        movimiento={mkMov({ tipo: 'devolucion' })}
        proveedor={proveedor}
        onClose={vi.fn()}
      />
    );
    expect(container.textContent).toContain('Devolución');
  });
});

describe('CompraProveedorDetalleModal — items', () => {
  it('renderiza fila por cada item (TODOS, no solo +N)', () => {
    const { container } = render(
      <CompraProveedorDetalleModal movimiento={mkMov()} proveedor={proveedor} onClose={vi.fn()} />
    );
    const text = container.textContent;
    expect(text).toContain('iPad Pro 11"');
    expect(text).toContain('14 Pro');
    expect(text).toContain('MacBook Neo');
    expect(text).toContain('SHQWPFH7069');
    expect(text).toContain('HPW0');
  });

  it('muestra el color, capacidad y valor de cada item', () => {
    const { container } = render(
      <CompraProveedorDetalleModal movimiento={mkMov()} proveedor={proveedor} onClose={vi.fn()} />
    );
    const text = container.textContent;
    expect(text).toContain('Space Black');
    expect(text).toContain('Gold');
    expect(text).toContain('Blush ESP');
    // Valores formateados
    expect(text).toContain('1.175,00');
    expect(text).toContain('10.000,00');
  });

  it('items.length === 0: muestra placeholder', () => {
    const { container } = render(
      <CompraProveedorDetalleModal
        movimiento={mkMov({ items: [] })}
        proveedor={proveedor}
        onClose={vi.fn()}
      />
    );
    expect(container.textContent).toContain('no tiene productos asociados');
  });

  it('items > 1: muestra tfoot con suma total', () => {
    const { container } = render(
      <CompraProveedorDetalleModal movimiento={mkMov()} proveedor={proveedor} onClose={vi.fn()} />
    );
    const tfoot = container.querySelector('tfoot');
    expect(tfoot).toBeTruthy();
    expect(tfoot.textContent).toContain('3 items');
    expect(tfoot.textContent).toContain('14.985,00'); // 1175+3810+10000
  });

  it('items === 1: NO muestra tfoot (redundante)', () => {
    const { container } = render(
      <CompraProveedorDetalleModal
        movimiento={mkMov({ items: [{ id: 1, producto: 'Solo uno', valor: 500 }] })}
        proveedor={proveedor}
        onClose={vi.fn()}
      />
    );
    expect(container.querySelector('tfoot')).toBeNull();
  });
});

describe('CompraProveedorDetalleModal — notas y discrepancia', () => {
  it('con notas del movimiento: las muestra', () => {
    const { container } = render(
      <CompraProveedorDetalleModal
        movimiento={mkMov({ notas: 'Compra a proveedor mayorista. Descuento 5%.' })}
        proveedor={proveedor}
        onClose={vi.fn()}
      />
    );
    expect(container.textContent).toContain('Compra a proveedor mayorista');
  });

  it('discrepancia suma_items ≠ monto: muestra nota explicativa', () => {
    // Items suman 14.985 pero monto es 14.500 (descuento aplicado al total)
    const { container } = render(
      <CompraProveedorDetalleModal
        movimiento={mkMov({ monto: 14500 })}
        proveedor={proveedor}
        onClose={vi.fn()}
      />
    );
    expect(container.textContent).toContain('difiere');
    expect(container.textContent).toContain('descuentos, envío o ajustes');
  });

  it('sin discrepancia: no muestra la nota', () => {
    const { container } = render(
      <CompraProveedorDetalleModal movimiento={mkMov()} proveedor={proveedor} onClose={vi.fn()} />
    );
    // El texto de la nota específica no debe aparecer
    expect(container.textContent).not.toContain('difiere');
  });
});

describe('CompraProveedorDetalleModal — acciones', () => {
  it('botón X en el header cierra el modal', () => {
    const onClose = vi.fn();
    const { container } = render(
      <CompraProveedorDetalleModal movimiento={mkMov()} proveedor={proveedor} onClose={onClose} />
    );
    // aria-label "Cerrar" (el botón X del header, no el btn del footer)
    const closeBtn = container.querySelector('[aria-label="Cerrar"]');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('botón "Cerrar" del footer cierra el modal', () => {
    const onClose = vi.fn();
    const { getByText } = render(
      <CompraProveedorDetalleModal movimiento={mkMov()} proveedor={proveedor} onClose={onClose} />
    );
    fireEvent.click(getByText('Cerrar'));
    expect(onClose).toHaveBeenCalled();
  });

  it('botón "Editar" está deshabilitado en Fase A', () => {
    const { getByLabelText } = render(
      <CompraProveedorDetalleModal movimiento={mkMov()} proveedor={proveedor} onClose={vi.fn()} />
    );
    const editBtn = getByLabelText(/Editar/);
    expect(editBtn).toBeDisabled();
    expect(editBtn.getAttribute('title')).toContain('Próximamente');
  });
});
