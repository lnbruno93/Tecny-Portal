// Smoke tests para RedB2BOperacionDetalle — TANDA 0.5 UX (Red B2B U0-2).
//
// Foco: verificar que la corrección del bug U0-2 funcione:
//   1. El render base no crashea (regresión CSS + JSX).
//   2. Click en "Cancelar operación" abre modal inline (NO dispara
//      window.prompt nativo).
//   3. El botón "Volver" del modal cierra sin llamar a la API.
//
// No hace tests exhaustivos del flujo completo de cancelación — eso pertenece
// a un test de integración más grande. Este es un smoke test para prevenir
// regresiones del fix específico.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../lib/api', () => ({
  redB2b: {
    operations: {
      get:    vi.fn().mockResolvedValue({
        operation: {
          id: 42,
          status: 'active',
          my_side: 'seller',
          partner: { nombre: 'Partner UY' },
          total_usd: 1000,
          total_ars: 1400000,
          tc_used: 1400,
          items: [],
          notes: '',
          partnership_id: 7,
          seller_venta_id: 100,
          buyer_compra_id: 200,
        },
      }),
      cancel: vi.fn().mockResolvedValue({ ok: true }),
      patch:  vi.fn().mockResolvedValue({ ok: true }),
    },
    pagos: {
      listByOperation: vi.fn().mockResolvedValue({ saldo: null, pagos: [] }),
    },
  },
}));

import RedB2BOperacionDetalle from './RedB2BOperacionDetalle';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/red-b2b/operaciones/42']}>
      <ToastProvider>
        <ConfirmProvider>
          <Routes>
            <Route path="/red-b2b/operaciones/:id" element={<RedB2BOperacionDetalle />} />
          </Routes>
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('RedB2BOperacionDetalle — smoke tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renderiza el detalle sin crash', async () => {
    renderScreen();
    // Espera a que aparezca el nombre del partner (post-fetch).
    await waitFor(() => {
      expect(screen.getByText(/Partner UY/i)).toBeInTheDocument();
    });
  });

  it('U0-2: click en "Cancelar operación" abre modal, NO dispara window.prompt', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    renderScreen();

    // Esperar carga.
    await waitFor(() => expect(screen.getByText(/Partner UY/i)).toBeInTheDocument());

    // Click en el botón. Al ser el user seller de una op activa, el botón
    // aparece.
    const btn = screen.getByRole('button', { name: /cancelar operación/i });
    fireEvent.click(btn);

    // Modal aparece con role="dialog".
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Textarea de motivo presente.
    expect(screen.getByLabelText(/motivo/i)).toBeInTheDocument();

    // NO se llamó window.prompt (regresión U0-2 clave).
    expect(promptSpy).not.toHaveBeenCalled();

    promptSpy.mockRestore();
  });

  it('U0-2: botón "Volver" del modal cierra sin llamar a la API', async () => {
    const { redB2b } = await import('../lib/api');
    renderScreen();
    await waitFor(() => expect(screen.getByText(/Partner UY/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /cancelar operación/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    // "Volver" cierra el modal.
    fireEvent.click(screen.getByRole('button', { name: /volver/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // No se disparó la cancelación.
    expect(redB2b.operations.cancel).not.toHaveBeenCalled();
  });
});
