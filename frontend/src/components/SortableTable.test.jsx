import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SortableTable from './SortableTable';

const SAMPLE = [
  { id: 1, nombre: 'Charlie', stock: 5 },
  { id: 2, nombre: 'Alpha',   stock: 12 },
  { id: 3, nombre: 'Bravo',   stock: 1 },
];

const COLS = [
  { key: 'nombre', label: 'Nombre', sortable: true },
  { key: 'stock',  label: 'Stock',  sortable: true },
];

function getRowOrder() {
  // Devuelve el orden actual de la columna `nombre` leyendo el DOM.
  return Array.from(document.querySelectorAll('tbody tr td:first-child'))
    .map(td => td.textContent);
}

describe('SortableTable', () => {
  it('sin sort renderiza el orden original', () => {
    render(<SortableTable columns={COLS} data={SAMPLE} />);
    expect(getRowOrder()).toEqual(['Charlie', 'Alpha', 'Bravo']);
    // aria-sort='none' en headers sin sort activo.
    const headers = screen.getAllByRole('columnheader');
    headers.forEach(h => expect(h.getAttribute('aria-sort')).toBe('none'));
  });

  it('click en header de string ordena asc (lexicográfico es-AR)', () => {
    render(<SortableTable columns={COLS} data={SAMPLE} />);
    fireEvent.click(screen.getByText('Nombre'));
    expect(getRowOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(screen.getByText('Nombre').closest('th').getAttribute('aria-sort'))
      .toBe('ascending');
  });

  it('click en header numérico ordena ascendente por número', () => {
    render(<SortableTable columns={COLS} data={SAMPLE} />);
    fireEvent.click(screen.getByText('Stock'));
    expect(getRowOrder()).toEqual(['Bravo', 'Charlie', 'Alpha']); // 1, 5, 12
  });

  it('ciclo de 3 estados: asc → desc → none', () => {
    render(<SortableTable columns={COLS} data={SAMPLE} />);
    const stockHeader = screen.getByText('Stock');
    // asc
    fireEvent.click(stockHeader);
    expect(getRowOrder()).toEqual(['Bravo', 'Charlie', 'Alpha']);
    expect(stockHeader.closest('th').getAttribute('aria-sort')).toBe('ascending');
    // desc
    fireEvent.click(stockHeader);
    expect(getRowOrder()).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(stockHeader.closest('th').getAttribute('aria-sort')).toBe('descending');
    // none — vuelve al orden original
    fireEvent.click(stockHeader);
    expect(getRowOrder()).toEqual(['Charlie', 'Alpha', 'Bravo']);
    expect(stockHeader.closest('th').getAttribute('aria-sort')).toBe('none');
  });

  it('sorter custom por columna sobreescribe el default', () => {
    const cols = [
      { key: 'nombre', label: 'Nombre', sortable: true },
      // Sorter custom: ordenar por longitud del nombre.
      { key: 'nombre_len', label: 'Length', sortable: true,
        sorter: (a, b) => a.nombre.length - b.nombre.length,
        render: (row) => row.nombre.length },
    ];
    render(<SortableTable columns={cols} data={SAMPLE} />);
    fireEvent.click(screen.getByText('Length'));
    // Alpha=5, Bravo=5, Charlie=7 → orden estable de los empates por sort no-garantizado,
    // pero Charlie debe ser último.
    const order = getRowOrder();
    expect(order[order.length - 1]).toBe('Charlie');
  });

  it('render custom se aplica por celda', () => {
    const cols = [
      { key: 'nombre', label: 'Nombre' },
      { key: 'stock', label: 'Stock',
        render: (row) => <strong data-testid="strong-stock">x{row.stock}</strong> },
    ];
    render(<SortableTable columns={cols} data={SAMPLE} />);
    const cells = screen.getAllByTestId('strong-stock');
    expect(cells.map(c => c.textContent)).toEqual(['x5', 'x12', 'x1']);
  });

  it('columnas no-sortable no responden al click y no muestran aria-sort', () => {
    const cols = [
      { key: 'nombre', label: 'Nombre' }, // sin sortable
      { key: 'stock', label: 'Stock', sortable: true },
    ];
    render(<SortableTable columns={cols} data={SAMPLE} />);
    const nombreHeader = screen.getByText('Nombre').closest('th');
    expect(nombreHeader.getAttribute('aria-sort')).toBeNull();
    fireEvent.click(nombreHeader);
    // El orden NO debe cambiar.
    expect(getRowOrder()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('initialSort aplica orden desde el primer render', () => {
    render(
      <SortableTable
        columns={COLS}
        data={SAMPLE}
        initialSort={{ key: 'stock', dir: 'desc' }}
      />
    );
    expect(getRowOrder()).toEqual(['Alpha', 'Charlie', 'Bravo']); // 12, 5, 1
  });
});

// ── Auditoría 2026-06-30 E-04 — paginación cliente ───────────────────────
describe('SortableTable — paginación cliente (E-04)', () => {
  // Genera N filas con nombres "Item N" (estables, fáciles de leer).
  function makeRows(n) {
    return Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      nombre: `Item ${String(i + 1).padStart(4, '0')}`,
      stock: i + 1,
    }));
  }

  it('sin pageSize renderiza todas las filas (default Infinity)', () => {
    const rows = makeRows(50);
    render(<SortableTable columns={COLS} data={rows} />);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
    // Sin paginar = sin nav.
    expect(document.querySelector('.sortable-table-pager')).toBeNull();
  });

  it('pageSize=200 sobre 5000 filas renderiza solo 200 + nav visible', () => {
    const rows = makeRows(5000);
    render(<SortableTable columns={COLS} data={rows} pageSize={200} />);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(200);
    const nav = document.querySelector('.sortable-table-pager');
    expect(nav).not.toBeNull();
    // 5000 / 200 = 25 páginas.
    expect(nav.textContent).toContain('Página 1 de 25');
  });

  it('click en Next » avanza una página y muestra filas distintas', () => {
    const rows = makeRows(5000);
    render(<SortableTable columns={COLS} data={rows} pageSize={200} />);

    const firstRowPage1 = document.querySelector('tbody tr td:first-child').textContent;
    expect(firstRowPage1).toBe('Item 0001');

    fireEvent.click(screen.getByLabelText('Página siguiente'));

    const firstRowPage2 = document.querySelector('tbody tr td:first-child').textContent;
    expect(firstRowPage2).toBe('Item 0201');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(200);
    expect(document.querySelector('.sortable-table-pager').textContent)
      .toContain('Página 2 de 25');
  });

  it('« Prev está disabled en página 1 y se habilita después de avanzar', () => {
    const rows = makeRows(5000);
    render(<SortableTable columns={COLS} data={rows} pageSize={200} />);

    const prev = screen.getByLabelText('Página anterior');
    expect(prev.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Página siguiente'));
    expect(prev.disabled).toBe(false);

    fireEvent.click(prev);
    expect(document.querySelector('tbody tr td:first-child').textContent).toBe('Item 0001');
  });

  it('Next » está disabled en la última página', () => {
    const rows = makeRows(450); // 3 páginas de 200, 200, 50
    render(<SortableTable columns={COLS} data={rows} pageSize={200} />);

    const next = screen.getByLabelText('Página siguiente');
    fireEvent.click(next);
    fireEvent.click(next); // página 3 (última)
    expect(next.disabled).toBe(true);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
  });

  it('paginación opera SOBRE el sort: cambiar sort no cambia la cantidad de filas visibles', () => {
    const rows = makeRows(500); // 3 páginas
    render(<SortableTable columns={COLS} data={rows} pageSize={200} />);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(200);

    // Sort desc por stock — la página 1 ahora debe mostrar Item 0500, 0499, ...
    fireEvent.click(screen.getByText('Stock'));
    fireEvent.click(screen.getByText('Stock')); // asc → desc
    expect(document.querySelectorAll('tbody tr')).toHaveLength(200);
    expect(document.querySelector('tbody tr td:first-child').textContent).toBe('Item 0500');
  });

  it('pageSize=Infinity (default explícito) = sin paginar', () => {
    const rows = makeRows(100);
    render(<SortableTable columns={COLS} data={rows} pageSize={Infinity} />);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(100);
    expect(document.querySelector('.sortable-table-pager')).toBeNull();
  });
});
