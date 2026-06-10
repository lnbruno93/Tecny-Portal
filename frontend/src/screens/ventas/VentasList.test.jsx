// Tests del componente VentasList — tabla presentacional de ventas.
//
// Es un componente "tonto" (sin state propio) — los tests verifican que:
//   · Renderiza columnas correctas y todas las filas de `lista`.
//   · Las acciones (estado select, edit, comprobante, eliminar) invocan
//     los handlers correctos con la venta correspondiente.
//   · Botón de ver comprobantes aparece solo si comprobantes_count > 0.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import VentasList from './VentasList';

const VENTAS_DEMO = [
  {
    id: 1,
    order_id: 'V-001',
    estado: 'acreditado',
    fecha: '2026-06-01',
    hora: '14:30:00',
    cliente_nombre: 'Cliente A',
    etiqueta_nombre: null,
    items: [{ descripcion: 'iPhone 15 Pro', cantidad: 1 }],
    pagos: [{ metodo_nombre: 'USD Efectivo', moneda: 'USD', monto: 1000 }],
    canjes: [],
    ganancia_usd: 150,
    total_usd: 1000,
    comprobantes_count: 0,
  },
  {
    id: 2,
    order_id: 'V-002',
    estado: 'pendiente',
    fecha: '2026-06-02',
    hora: null,
    cliente_nombre: 'Cliente B',
    etiqueta_nombre: 'VIP',
    items: [
      { descripcion: 'Funda', cantidad: 2 },
      { descripcion: 'Cargador', cantidad: 1 },
    ],
    pagos: [{ metodo_nombre: 'Transfer', moneda: 'ARS', monto: 50000 }],
    canjes: [{ descripcion: 'iPhone 13 viejo' }],
    ganancia_usd: 20,
    total_usd: 50,
    comprobantes_count: 3,
  },
];

function renderList(overrides = {}) {
  const props = {
    lista: VENTAS_DEMO,
    estadoBadge: (estado) => <span className="badge" data-testid={`badge-${estado}`}>{estado}</span>,
    changeEstado: vi.fn(),
    openEdit: vi.fn(),
    comprobantePDF: vi.fn(),
    openComprob: vi.fn(),
    deleteVenta: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<VentasList {...props} />) };
}

beforeEach(() => { cleanup(); });

describe('VentasList — render', () => {
  it('renderiza una fila por venta', () => {
    const { container } = renderList();
    const filas = container.querySelectorAll('tbody tr');
    expect(filas.length).toBe(2);
  });

  it('renderiza el order_id y cliente_nombre de cada venta', () => {
    const { container } = renderList();
    expect(container.textContent).toContain('V-001');
    expect(container.textContent).toContain('V-002');
    expect(container.textContent).toContain('Cliente A');
    expect(container.textContent).toContain('Cliente B');
  });

  it('renderiza items con cantidad > 1 con "×N"', () => {
    const { container } = renderList();
    expect(container.textContent).toContain('Funda ×2');
    expect(container.textContent).toContain('Cargador');
    expect(container.textContent).not.toContain('iPhone 15 Pro ×1'); // cantidad 1 no muestra ×N
  });

  it('renderiza canjes con flecha ↺', () => {
    const { container } = renderList();
    expect(container.textContent).toContain('↺ iPhone 13 viejo');
  });

  it('badge de etiqueta solo si la venta la tiene', () => {
    const { container } = renderList();
    expect(container.textContent).toContain('VIP');
    // La venta 1 no tiene etiqueta — esperamos un solo badge VIP.
    const vip = container.textContent.match(/VIP/g);
    expect(vip.length).toBe(1);
  });

  it('renderiza estado vía estadoBadge() (callback)', () => {
    const { getByTestId } = renderList();
    expect(getByTestId('badge-acreditado')).toBeTruthy();
    expect(getByTestId('badge-pendiente')).toBeTruthy();
  });

  it('fallback "—" cuando cliente_nombre es null', () => {
    const ventaSinCliente = { ...VENTAS_DEMO[0], cliente_nombre: null };
    const { container } = renderList({ lista: [ventaSinCliente] });
    expect(container.textContent).toContain('—');
  });
});

describe('VentasList — acciones', () => {
  it('cambio de estado en select llama changeEstado(venta, nuevoEstado)', () => {
    // 2026-06-10: changeEstado ahora recibe la fila completa (no solo el id)
    // para que el padre pueda discriminar entre retail y B2B y llamar al
    // endpoint correcto.
    const { container, props } = renderList();
    const select = container.querySelectorAll('select')[0];
    fireEvent.change(select, { target: { value: 'cancelado' } });
    expect(props.changeEstado).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      'cancelado'
    );
  });

  it('click en Editar llama openEdit con la venta completa', () => {
    const { container, props } = renderList();
    const editBtn = container.querySelector('button[title="Editar venta"]');
    fireEvent.click(editBtn);
    expect(props.openEdit).toHaveBeenCalledWith(VENTAS_DEMO[0]);
  });

  it('click en comprobante PDF llama comprobantePDF con la venta', () => {
    const { container, props } = renderList();
    const btn = container.querySelector('button[title*="Comprobante"]');
    fireEvent.click(btn);
    expect(props.comprobantePDF).toHaveBeenCalledWith(VENTAS_DEMO[0]);
  });

  it('click en eliminar llama deleteVenta con la venta', () => {
    const { container, props } = renderList();
    const trashBtns = container.querySelectorAll('button[title="Eliminar"]');
    fireEvent.click(trashBtns[0]);
    expect(props.deleteVenta).toHaveBeenCalledWith(VENTAS_DEMO[0]);
  });

  it('botón "ver comprobantes adjuntos" solo aparece si comprobantes_count > 0', () => {
    const { container } = renderList();
    // Solo la venta 2 tiene comprobantes_count=3 → 1 botón con title "Comprobantes adjuntos".
    const adjuntosBtns = container.querySelectorAll('button[title="Comprobantes adjuntos"]');
    expect(adjuntosBtns.length).toBe(1);
  });

  it('click en ver comprobantes adjuntos llama openComprob con el id', () => {
    const { container, props } = renderList();
    const btn = container.querySelector('button[title="Comprobantes adjuntos"]');
    fireEvent.click(btn);
    expect(props.openComprob).toHaveBeenCalledWith(2); // id de la venta 2
  });
});
