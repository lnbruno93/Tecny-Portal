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
