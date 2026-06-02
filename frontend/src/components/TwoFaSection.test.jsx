// Tests del componente TwoFaSection — sección de Config para gestionar 2FA.
//
// Cubre los 3 estados visibles:
//   · Loading inicial.
//   · No configurado → botón "Activar 2FA" → muestra TwoFaSetup.
//   · Activado → status + acciones (Desactivar / Regenerar recovery codes).
//
// Mockea api/twoFa y el componente TwoFaSetup (ya tiene sus tests propios).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from './ConfirmModal';

vi.mock('../lib/api', () => ({
  twoFa: {
    status:             vi.fn(),
    disable:            vi.fn(() => Promise.resolve({ ok: true })),
    regenerateRecovery: vi.fn(() => Promise.resolve({
      recovery_codes: ['NEW1-AAAA-AA','NEW2-BBBB-BB','NEW3-CCCC-CC','NEW4-DDDD-DD',
                       'NEW5-EEEE-EE','NEW6-FFFF-FF','NEW7-GGGG-GG','NEW8-HHHH-HH'],
    })),
  },
}));

// Mock TwoFaSetup para no tener que setear sus deps en estos tests.
vi.mock('./TwoFaSetup', () => ({
  default: ({ onDone, onCancel }) => (
    <div data-testid="twofa-setup-mock">
      <button onClick={onDone}>mock-done</button>
      <button onClick={onCancel}>mock-cancel</button>
    </div>
  ),
}));

import TwoFaSection from './TwoFaSection';
import { twoFa } from '../lib/api';

function renderSection() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <TwoFaSection />
      </ConfirmProvider>
    </ToastProvider>
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TwoFaSection — estado de carga', () => {
  it('muestra "Cargando…" mientras espera status()', () => {
    twoFa.status.mockImplementationOnce(() => new Promise(() => {})); // never resolves
    const { container } = renderSection();
    expect(container.textContent).toContain('Cargando');
  });
});

describe('TwoFaSection — estado NO configurado', () => {
  beforeEach(() => {
    twoFa.status.mockResolvedValue({
      configured: false, enabled: false,
      enabled_at: null, last_used_at: null,
      recovery_codes_remaining: 0,
    });
  });

  it('muestra badge "No activado" + recomendación admin', async () => {
    const { findByText, container } = renderSection();
    await findByText('No activado');
    expect(container.textContent).toMatch(/recomendado para cuentas admin/i);
  });

  it('click en "Activar 2FA" muestra TwoFaSetup (mock)', async () => {
    const { findByText, getByTestId } = renderSection();
    fireEvent.click(await findByText('Activar 2FA'));
    expect(getByTestId('twofa-setup-mock')).toBeTruthy();
  });

  it('mock-cancel del setup vuelve a la vista "No activado"', async () => {
    const { findByText, getByText } = renderSection();
    fireEvent.click(await findByText('Activar 2FA'));
    fireEvent.click(getByText('mock-cancel'));
    await waitFor(() => expect(findByText('No activado')).resolves.toBeTruthy());
  });
});

describe('TwoFaSection — estado activado', () => {
  beforeEach(() => {
    twoFa.status.mockResolvedValue({
      configured: true, enabled: true,
      enabled_at: '2026-06-01T10:00:00Z',
      last_used_at: '2026-06-01T22:00:00Z',
      recovery_codes_remaining: 8,
    });
  });

  it('muestra badge "Activo" y los 2 botones de acción', async () => {
    const { findByText } = renderSection();
    await findByText('Activo');
    await findByText('Regenerar recovery codes');
    await findByText('Desactivar 2FA');
  });

  it('muestra "8 de 8 recovery codes disponibles"', async () => {
    const { findByText, container } = renderSection();
    await findByText('Activo');
    expect(container.textContent).toMatch(/8 de 8 recovery codes/);
  });

  it('warning visible cuando quedan ≤2 recovery codes', async () => {
    twoFa.status.mockResolvedValue({
      configured: true, enabled: true,
      enabled_at: '2026-06-01T10:00:00Z',
      last_used_at: null,
      recovery_codes_remaining: 2,
    });
    const { findByText, container } = renderSection();
    await findByText('Activo');
    expect(container.textContent).toMatch(/te quedan pocos|consider/i);
  });
});

describe('TwoFaSection — flow de regenerate recovery codes', () => {
  beforeEach(() => {
    twoFa.status.mockResolvedValue({
      configured: true, enabled: true,
      enabled_at: '2026-06-01T10:00:00Z',
      last_used_at: null,
      recovery_codes_remaining: 8,
    });
  });

  it('regenerate → confirm → prompt → muestra nuevos codes', async () => {
    // Mock window.prompt para devolver un código.
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('123456');

    const { findByText, container } = renderSection();
    fireEvent.click(await findByText('Regenerar recovery codes'));
    // ConfirmModal aparece — click Continuar.
    fireEvent.click(await findByText('Continuar'));
    // prompt() fue llamado.
    await waitFor(() => expect(promptSpy).toHaveBeenCalled());
    // Los nuevos codes aparecen en pantalla.
    await waitFor(() => expect(container.textContent).toContain('NEW1-AAAA-AA'));
    expect(container.textContent).toContain('NEW8-HHHH-HH');
    promptSpy.mockRestore();
  });

  it('si user cancela el prompt, NO llama regenerateRecovery', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null); // canceló
    const { findByText } = renderSection();
    fireEvent.click(await findByText('Regenerar recovery codes'));
    fireEvent.click(await findByText('Continuar'));
    await new Promise(r => setTimeout(r, 50)); // dejá que el async se settle
    expect(twoFa.regenerateRecovery).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });
});

describe('TwoFaSection — disable 2FA', () => {
  beforeEach(() => {
    twoFa.status
      .mockResolvedValueOnce({ // primera llamada
        configured: true, enabled: true,
        enabled_at: '2026-06-01T10:00:00Z', last_used_at: null,
        recovery_codes_remaining: 8,
      })
      .mockResolvedValueOnce({ // post-disable
        configured: false, enabled: false,
        enabled_at: null, last_used_at: null,
        recovery_codes_remaining: 0,
      });
  });

  it('disable → confirm → prompt → llama twoFa.disable con el código', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('999999');
    const { findByText } = renderSection();
    fireEvent.click(await findByText('Desactivar 2FA'));
    fireEvent.click(await findByText('Continuar'));
    await waitFor(() => expect(twoFa.disable).toHaveBeenCalledWith('999999'));
    promptSpy.mockRestore();
  });
});
