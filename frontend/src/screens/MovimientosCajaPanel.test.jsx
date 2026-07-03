import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import MovimientosCajaPanel from './MovimientosCajaPanel';

// Auditoría 2026-07-04 TANDA 0 — smoke test de mount inicial.
// Lección de Lucas post crash useModal en prod (2026-07-04): "los tests unit
// no cubren el mount real, causó P0 en pantalla Egresos". Este test valida el
// mount de MovimientosCajaPanel sin crash — el patrón mínimo que atrapa
// regresiones tipo "hook mal usado" o "prop undefined".
//
// Deliberadamente NO cubrimos el flujo submit (más complejo, requiere mock de
// múltiples APIs + modal state). Follow-up: agregar tests de flow completo.

// Mocks: la pantalla llama a `cajaTransferencias.list()` + `cajas.listCajas()`
// al mount. Devolvemos respuestas vacías OK para que el mount llegue al render
// sin explotar.
vi.mock('../lib/api', () => ({
  cajas: {
    listCajas: vi.fn(() => Promise.resolve([])),
  },
  cajaTransferencias: {
    list: vi.fn(() => Promise.resolve({ data: [] })),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

function renderPanel() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <MovimientosCajaPanel />
      </ConfirmProvider>
    </ToastProvider>
  );
}

describe('MovimientosCajaPanel — smoke tests (mount + estado inicial)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mount inicial no crashea + muestra estado de carga', () => {
    renderPanel();
    // El componente arranca con `loading=true` (mounted → useEffect → cargar).
    expect(screen.getByText(/cargando/i)).toBeInTheDocument();
  });

  it('con 0 transferencias muestra empty state (no crashea con lista vacía)', async () => {
    renderPanel();
    // El mount + cargar() dispara render con list vacío → empty state.
    await waitFor(() => {
      expect(screen.getByText(/todav.a no hay transferencias/i)).toBeInTheDocument();
    });
  });

  it('el botón "Nueva transferencia" está presente y clickeable', async () => {
    renderPanel();
    await waitFor(() => {
      // El botón siempre está visible en el toolbar (incluso con list vacía).
      const btn = screen.getByRole('button', { name: /nueva transferencia/i });
      expect(btn).toBeInTheDocument();
      expect(btn).not.toBeDisabled();
    });
  });
});
