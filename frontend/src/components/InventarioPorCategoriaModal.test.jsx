// Tests para InventarioPorCategoriaModal (F3-Fase2b).
//
// Cubre:
//   1. No renderiza cuando open=false
//   2. Renderiza filas con emoji + nombre + count + valorizado
//   3. Oculta filas con count=0 y usd/ars=0
//   4. Muestra totales cuando hay filas visibles
//   5. Redact caps: si TODAS las filas tienen usd=null, muestra "—" y oculta totales

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import InventarioPorCategoriaModal from './InventarioPorCategoriaModal';

const FILAS_MOCK = [
  { clase_id: 'aaaa', nombre: 'Celular Sellado', emoji: '📲', es_base: true, es_sin_categoria: false, slug_legacy: 'celular_sellado', count: 22, usd: 18500, ars: 0 },
  { clase_id: 'bbbb', nombre: 'Auriculares', emoji: '🎧', es_base: true, es_sin_categoria: false, slug_legacy: 'auriculares', count: 40, usd: 500, ars: 0 },
  { clase_id: 'cccc', nombre: 'Cargadores', emoji: '🔋', es_base: true, es_sin_categoria: false, slug_legacy: 'cargadores', count: 0, usd: 0, ars: 0 },  // filtrada (sin stock)
];

describe('InventarioPorCategoriaModal', () => {
  afterEach(() => cleanup());

  it('no renderiza nada cuando open=false', () => {
    const { container } = render(
      <InventarioPorCategoriaModal open={false} onClose={() => {}} invPorClase={FILAS_MOCK} />
    );
    expect(container.textContent).toBe('');
  });

  it('renderiza las filas con stock (nombre + emoji visibles)', () => {
    render(<InventarioPorCategoriaModal open onClose={() => {}} invPorClase={FILAS_MOCK} />);
    expect(screen.getByText('Celular Sellado')).toBeInTheDocument();
    expect(screen.getByText('Auriculares')).toBeInTheDocument();
    // Cargadores tiene count=0 y usd=0 → oculto.
    expect(screen.queryByText('Cargadores')).not.toBeInTheDocument();
  });

  it('muestra el count por fila con el sufijo "u"', () => {
    render(<InventarioPorCategoriaModal open onClose={() => {}} invPorClase={FILAS_MOCK} />);
    // 22 u para Celular Sellado, 40 u para Auriculares.
    expect(screen.getByText(/22 u/)).toBeInTheDocument();
    expect(screen.getByText(/40 u/)).toBeInTheDocument();
  });

  it('muestra la fila de totales con la suma cuando hay filas visibles', () => {
    render(<InventarioPorCategoriaModal open onClose={() => {}} invPorClase={FILAS_MOCK} />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    // total count = 22 + 40 = 62 u ; total usd = 18500 + 500 = 19000 (formateado 19.000).
    expect(screen.getByText(/62 u/)).toBeInTheDocument();
    // El monto USD formateado con locale es-AR usa "." como separador de miles.
    // Buscamos por regex tolerante para no depender del locale exacto de CI.
    const totalRegex = /19[.,]000/;
    const cells = screen.getAllByText(totalRegex);
    expect(cells.length).toBeGreaterThan(0);
  });

  it('estado vacío: sin filas con stock, muestra fallback', () => {
    const soloVacias = [
      { clase_id: 'x', nombre: 'X', emoji: null, es_base: false, es_sin_categoria: false, slug_legacy: null, count: 0, usd: 0, ars: 0 },
    ];
    render(<InventarioPorCategoriaModal open onClose={() => {}} invPorClase={soloVacias} />);
    expect(screen.getByText(/Sin categorías con stock disponible/)).toBeInTheDocument();
  });

  it('redact caps: cuando todas las filas tienen usd=null, oculta los totales monetarios', () => {
    const redacted = FILAS_MOCK.filter(r => r.count > 0).map(r => ({ ...r, usd: null, ars: null }));
    render(<InventarioPorCategoriaModal open onClose={() => {}} invPorClase={redacted} />);
    // Las filas siguen visibles (count intacto).
    expect(screen.getByText('Celular Sellado')).toBeInTheDocument();
    expect(screen.getByText(/22 u/)).toBeInTheDocument();
    // Pero la fila de totales NO debe aparecer (el modal la oculta con `redacted`).
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
  });

  it('llama onClose al clickear el botón Cerrar del footer', async () => {
    // Hay 2 botones con nombre "Cerrar" (icono X del header + botón textual
    // del footer). Filtramos por la clase `btn` que solo tiene el del footer;
    // el ícono usa `icon-btn`.
    const onClose = vi.fn();
    const { container } = render(
      <InventarioPorCategoriaModal open onClose={onClose} invPorClase={FILAS_MOCK} />
    );
    const btn = container.querySelector('.modal-ft button.btn');
    expect(btn).toBeTruthy();
    btn.click();
    expect(onClose).toHaveBeenCalled();
  });
});

