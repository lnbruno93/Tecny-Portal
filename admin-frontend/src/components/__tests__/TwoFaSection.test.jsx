// Smoke test de TwoFaSection (task #498).
//
// El componente delega el flow completo de setup a TwoFaSetup (que a su vez
// depende de qrcode y de callbacks async). Acá solo verificamos:
//   1. Estado "no activado" cuando twoFa.status devuelve enabled=false
//   2. Estado "activado" cuando twoFa.status devuelve enabled=true (badge +
//      contador de recovery codes + botones)
//   3. La prop onMessage recibe el error si el fetch inicial falla

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

// Mock de qrcode — TwoFaSetup lo usa, pero en este suite nunca llegamos al
// setup así que un stub vacío alcanza.
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../lib/api.js', () => ({
  twoFa: {
    status: vi.fn(),
    setup: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    regenerateRecovery: vi.fn(),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

import { twoFa } from '../../lib/api.js';
import TwoFaSection from '../TwoFaSection.jsx';

function renderSection(props = {}) {
  return render(
    <BrowserRouter>
      <TwoFaSection {...props} />
    </BrowserRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TwoFaSection', () => {
  it('muestra "No activado" cuando enabled=false', async () => {
    twoFa.status.mockResolvedValue({
      configured: false,
      enabled: false,
      enabled_at: null,
      last_used_at: null,
      recovery_codes_remaining: 0,
    });

    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/no activado/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /activar 2fa/i })).toBeInTheDocument();
  });

  it('muestra "Activo" con contador de recovery codes cuando enabled=true', async () => {
    twoFa.status.mockResolvedValue({
      configured: true,
      enabled: true,
      enabled_at: '2026-06-15T10:30:00Z',
      last_used_at: '2026-07-01T09:00:00Z',
      recovery_codes_remaining: 6,
    });

    renderSection();

    await waitFor(() => {
      expect(screen.getByText(/activo/i)).toBeInTheDocument();
    });
    // Contador: "6 de 8 recovery codes disponibles."
    expect(screen.getByText(/6 de 8 recovery codes/i)).toBeInTheDocument();
    // Los 2 botones de acción
    expect(screen.getByRole('button', { name: /regenerar recovery codes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /desactivar 2fa/i })).toBeInTheDocument();
  });

  it('llama onMessage(error) cuando el fetch de status falla', async () => {
    const onMessage = vi.fn();
    twoFa.status.mockRejectedValue(new Error('backend down'));

    renderSection({ onMessage });

    await waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' })
      );
    });
  });
});
