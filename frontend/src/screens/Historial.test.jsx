// Tests de la pantalla Historial (task #144 UX A, 2026-07-16).
//
// Foco: el modal de "Detalle del evento" — antes renderizaba
// `JSON.stringify(detail)` crudo, ahora presenta los campos humanamente.
// Como el bug era mostrar el JSON tal cual (con `{`, `"tipo":`, comas),
// el test más importante es de regresión: verificar que el modal NUNCA
// contiene la string `JSON.stringify` de un objeto.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/api', () => ({
  historial: {
    list: vi.fn().mockResolvedValue({
      data: [
        {
          id: 101,
          accion: 'movimientos_deudas: INSERT',
          detalle: 'iPhone 16 · u$s250',
          usuario_nombre: 'Lucas Bruno',
          creado_en: '2026-07-16T15:30:00Z',
        },
      ],
      pagination: { total: 1, page: 1, pages: 1 },
    }),
  },
}));

import Historial from './Historial';

function renderPage() {
  return render(
    <MemoryRouter>
      <Historial />
    </MemoryRouter>
  );
}

describe('Historial — modal de detalle (fix P0)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renderiza la fila con el detalle humanizado', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('iPhone 16 · u$s250')).toBeInTheDocument();
    });
    expect(screen.getByText('Lucas Bruno')).toBeInTheDocument();
  });

  it('abre el modal al clickear el ícono de detalle y muestra los campos formateados', async () => {
    renderPage();
    await waitFor(() => screen.getByText('iPhone 16 · u$s250'));

    // Botón de detalle es un icon-btn en la última columna
    const detailBtns = screen.getAllByRole('button');
    const detailBtn = detailBtns.find((b) => b.className.includes('icon-btn') && b.querySelector('svg'));
    expect(detailBtn).toBeDefined();
    fireEvent.click(detailBtn);

    // El modal muestra "Detalle del evento #101" (título con id)
    expect(await screen.findByText('Detalle del evento #101')).toBeInTheDocument();
    // Y el label "Qué pasó" (nueva estructura)
    expect(screen.getByText(/Qué pasó/)).toBeInTheDocument();
    // Y el label Usuario existe dentro del modal (aparece varias veces
    // fuera: filtro, header de tabla → chequeamos dentro del modal).
    const modal = screen.getByText('Detalle del evento #101').closest('.modal');
    expect(modal.textContent).toContain('Usuario');
    // El detalle humanizado aparece dentro del modal
    // (aparece 2x total: fila + modal — verificamos que sean ≥ 2)
    expect(screen.getAllByText('iPhone 16 · u$s250').length).toBeGreaterThanOrEqual(2);
  });

  it('regresión P0: el modal NUNCA contiene JSON crudo (llaves, comillas dobles con claves)', async () => {
    renderPage();
    await waitFor(() => screen.getByText('iPhone 16 · u$s250'));

    const detailBtns = screen.getAllByRole('button');
    const detailBtn = detailBtns.find((b) => b.className.includes('icon-btn') && b.querySelector('svg'));
    fireEvent.click(detailBtn);
    await screen.findByText('Detalle del evento #101');

    // El anti-pattern era `{JSON.stringify(detail)}` que renderiza:
    //   { "id": 101, "accion": "...", ... }
    // La regresión verifica que NO haya ninguna de esas secuencias visibles.
    const modalBody = screen.getByText('Detalle del evento #101').closest('.modal');
    expect(modalBody).toBeTruthy();
    const textContent = modalBody.textContent || '';
    // Nunca debe aparecer un pattern JSON-like como `"id":` o `"accion":`
    // (comillas + clave + dos puntos), señal segura de JSON.stringify output.
    expect(textContent).not.toMatch(/"id"\s*:/);
    expect(textContent).not.toMatch(/"accion"\s*:/);
    expect(textContent).not.toMatch(/"detalle"\s*:/);
    // Y no puede aparecer la palabra "null" ni el objeto vacío {} vacío,
    // que son marcas típicas del JSON dump.
    expect(textContent).not.toContain('null');
  });
});
