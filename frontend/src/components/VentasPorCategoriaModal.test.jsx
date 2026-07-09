// Tests para VentasPorCategoriaModal (2026-07-09).
//
// Cubre:
//   1. No renderiza cuando open=false
//   2. Renderiza filas con emoji + nombre + count + porcentaje
//   3. Orden por count DESC (más vendidas primero)
//   4. Oculta filas con n=0
//   5. Footer con total agregado y count de categorías
//   6. Estado vacío
//   7. onClose desde el botón footer
//
// Espeja el estilo de InventarioPorCategoriaModal.test.jsx.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import VentasPorCategoriaModal from './VentasPorCategoriaModal';

const FILAS_MOCK = [
  { clase_id: 'aaaa', nombre: 'Cargadores', emoji: '🔋', n: 14 },
  { clase_id: 'bbbb', nombre: 'Celular Sellado', emoji: '📲', n: 18 },
  { clase_id: 'cccc', nombre: 'Auriculares', emoji: '🎧', n: 6 },
  { clase_id: 'dddd', nombre: 'Watch', emoji: '⌚', n: 0 },  // filtrado (n=0)
];

describe('VentasPorCategoriaModal', () => {
  afterEach(() => cleanup());

  it('no renderiza nada cuando open=false', () => {
    const { container } = render(
      <VentasPorCategoriaModal open={false} onClose={() => {}} unidadesPorClase={FILAS_MOCK} />
    );
    expect(container.textContent).toBe('');
  });

  it('renderiza las filas con n>0 (nombre + emoji visibles)', () => {
    render(<VentasPorCategoriaModal open onClose={() => {}} unidadesPorClase={FILAS_MOCK} />);
    expect(screen.getByText('Celular Sellado')).toBeInTheDocument();
    expect(screen.getByText('Cargadores')).toBeInTheDocument();
    expect(screen.getByText('Auriculares')).toBeInTheDocument();
    // Watch tiene n=0 → oculto.
    expect(screen.queryByText('Watch')).not.toBeInTheDocument();
  });

  it('ordena las filas por n DESC (más vendidas arriba)', () => {
    const { container } = render(
      <VentasPorCategoriaModal open onClose={() => {}} unidadesPorClase={FILAS_MOCK} />
    );
    const rows = container.querySelectorAll('.cat-row');
    // Esperado: Celular Sellado (18) → Cargadores (14) → Auriculares (6).
    expect(rows[0].textContent).toContain('Celular Sellado');
    expect(rows[1].textContent).toContain('Cargadores');
    expect(rows[2].textContent).toContain('Auriculares');
  });

  it('muestra el porcentaje relativo de cada fila', () => {
    render(<VentasPorCategoriaModal open onClose={() => {}} unidadesPorClase={FILAS_MOCK} />);
    // Total visible = 18 + 14 + 6 = 38.
    // Celular Sellado: 18/38 ≈ 47.4%
    // Cargadores:     14/38 ≈ 36.8%
    // Auriculares:     6/38 ≈ 15.8%
    // Los porcentajes se formatean con 1 decimal.
    expect(screen.getByText(/47.4%/)).toBeInTheDocument();
    expect(screen.getByText(/36.8%/)).toBeInTheDocument();
    expect(screen.getByText(/15.8%/)).toBeInTheDocument();
  });

  it('footer con total agregado y count de categorías visibles', () => {
    render(<VentasPorCategoriaModal open onClose={() => {}} unidadesPorClase={FILAS_MOCK} />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    // Total = 38 u (3 filas con n>0).
    expect(screen.getByText(/38/)).toBeInTheDocument();
    // "3 cat." como label del count.
    expect(screen.getByText(/3 cat/)).toBeInTheDocument();
  });

  it('estado vacío: sin filas con ventas, muestra fallback', () => {
    const soloVacias = [
      { clase_id: 'x', nombre: 'X', emoji: null, n: 0 },
    ];
    render(<VentasPorCategoriaModal open onClose={() => {}} unidadesPorClase={soloVacias} />);
    expect(screen.getByText(/Sin ventas por categoría en el rango/)).toBeInTheDocument();
  });

  it('llama onClose al clickear el botón Cerrar del footer', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <VentasPorCategoriaModal open onClose={onClose} unidadesPorClase={FILAS_MOCK} />
    );
    // Hay 2 botones "Cerrar" (icono X del header + botón textual del footer).
    // Filtramos por `.modal-ft button.btn` para pegarle al del footer.
    const btn = container.querySelector('.modal-ft button.btn');
    expect(btn).toBeTruthy();
    btn.click();
    expect(onClose).toHaveBeenCalled();
  });
});
