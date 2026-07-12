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
    cancelSetup:        vi.fn(() => Promise.resolve({ ok: true })),
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

// U1 auditoría 2026-06: prompt() reemplazado por TwoFaCodeModal embebido.
// Estos tests usan el nuevo modal (input estilizado + submit) en lugar del
// window.prompt() nativo.
describe('TwoFaSection — flow de regenerate recovery codes', () => {
  beforeEach(() => {
    twoFa.status.mockResolvedValue({
      configured: true, enabled: true,
      enabled_at: '2026-06-01T10:00:00Z',
      last_used_at: null,
      recovery_codes_remaining: 8,
    });
  });

  it('regenerate → confirm → modal input → muestra nuevos codes', async () => {
    const { findByText, container, getByPlaceholderText } = renderSection();
    fireEvent.click(await findByText('Regenerar recovery codes'));
    // ConfirmModal aparece — click Continuar.
    fireEvent.click(await findByText('Continuar'));
    // Modal de código aparece — tipear código + submit.
    const input = await findByPlaceholderTextWithWait(getByPlaceholderText);
    fireEvent.change(input, { target: { value: '123456' } });
    // Submit directo del form en vez de clickear el botón "Confirmar". El
    // botón arranca disabled={!valid} y se habilita cuando code tiene ≥6
    // dígitos; en CI el re-render asincrónico hacía que querySelector
    // devolviera null (race). El handler onSubmit del form ya valida `valid`
    // internamente, así que esto cubre el path real (Enter en el input o
    // click del submit) sin depender del timing del re-render.
    fireEvent.submit(input.closest('form'));
    // Los nuevos codes aparecen en pantalla.
    //
    // 2026-07-12 (fix flakiness CI): timeout 3000ms explícito. Default
    // (1000ms) fallaba intermitente en el runner de GitHub Actions —
    // Docker sobrecargado, mock async del regenerateRecovery + re-render
    // del componente + waitFor sumaban > 1s. Local siempre pasa (< 300ms).
    // El submit del form SÍ dispara (visible en la mutation de mocks),
    // pero waitFor expiraba antes del re-render.
    await waitFor(
      () => expect(container.textContent).toContain('NEW1-AAAA-AA'),
      { timeout: 3000 }
    );
    expect(container.textContent).toContain('NEW8-HHHH-HH');
    expect(twoFa.regenerateRecovery).toHaveBeenCalledWith('123456');
  });

  it('si user cancela el modal de código, NO llama regenerateRecovery', async () => {
    const { findByText, getAllByText } = renderSection();
    fireEvent.click(await findByText('Regenerar recovery codes'));
    fireEvent.click(await findByText('Continuar'));
    // Esperamos al modal de código y clickeamos Cancelar (puede haber dos botones "Cancelar"
    // si los confirm modals legacy quedan abiertos — tomamos el del modal de código).
    const cancelBtns = await waitFor(() => getAllByText('Cancelar'));
    fireEvent.click(cancelBtns[cancelBtns.length - 1]);
    await new Promise(r => setTimeout(r, 50));
    expect(twoFa.regenerateRecovery).not.toHaveBeenCalled();
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

  it('disable → confirm → modal input → llama twoFa.disable con el código', async () => {
    const { findByText, getByPlaceholderText } = renderSection();
    fireEvent.click(await findByText('Desactivar 2FA'));
    fireEvent.click(await findByText('Continuar'));
    const input = await findByPlaceholderTextWithWait(getByPlaceholderText);
    fireEvent.change(input, { target: { value: '999999' } });
    // Submit directo del form — ver explicación en el test 'regenerate → ...'
    // del describe anterior (mismo race condition con button:disabled en CI).
    fireEvent.submit(input.closest('form'));
    await waitFor(() => expect(twoFa.disable).toHaveBeenCalledWith('999999'));
  });
});

// ─── Task #497: estado SETUP PENDIENTE ─────────────────────────────────────
// Cuando el user llamó /setup pero no completó /enable, status devuelve
// configured=true + enabled=false. La UI debe mostrar el card amarillo con
// badge "Setup pendiente" + 2 botones ("Continuar setup" y "Cancelar setup").
describe('TwoFaSection — estado SETUP PENDIENTE (task #497)', () => {
  beforeEach(() => {
    twoFa.status.mockResolvedValue({
      configured: true, enabled: false,
      enabled_at: null, last_used_at: null,
      recovery_codes_remaining: 8,
    });
  });

  it('muestra badge "Setup pendiente" + botones Continuar/Cancelar', async () => {
    const { findByText } = renderSection();
    await findByText('Setup pendiente');
    await findByText('Continuar setup');
    await findByText('Cancelar setup');
  });

  it('click en "Continuar setup" muestra TwoFaSetup (mock)', async () => {
    const { findByText, getByTestId } = renderSection();
    fireEvent.click(await findByText('Continuar setup'));
    expect(getByTestId('twofa-setup-mock')).toBeTruthy();
  });

  it('click en "Cancelar setup" + confirm → llama twoFa.cancelSetup()', async () => {
    const { findByText } = renderSection();
    fireEvent.click(await findByText('Cancelar setup'));
    // ConfirmModal aparece — click "Cancelar setup" (confirmLabel).
    // Ese label aparece 2x: el botón de la card y el del confirm modal. Buscamos
    // el que aparece cuando el confirm ya está montado — el último rendered.
    const confirmBtn = await waitFor(() => {
      // Cuando el confirm modal aparece, hay un botón "Cancelar setup" adicional
      // (el confirmLabel del useConfirm). Esperamos a que hayan >= 2 y clickeamos
      // el último (el del confirm modal).
      const btns = document.querySelectorAll('button');
      const matches = Array.from(btns).filter(b => b.textContent.trim() === 'Cancelar setup');
      if (matches.length < 2) throw new Error('waiting for confirm modal');
      return matches[matches.length - 1];
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(twoFa.cancelSetup).toHaveBeenCalled());
  });

  it('si user cancela el confirm modal, NO llama cancelSetup', async () => {
    const { findByText, getAllByText } = renderSection();
    fireEvent.click(await findByText('Cancelar setup'));
    // ConfirmModal aparece — click "Cancelar" (label default del hook).
    const cancelBtns = await waitFor(() => getAllByText('Cancelar'));
    fireEvent.click(cancelBtns[cancelBtns.length - 1]);
    await new Promise(r => setTimeout(r, 50));
    expect(twoFa.cancelSetup).not.toHaveBeenCalled();
  });
});

// Helper para esperar a que el input del modal de código aparezca.
async function findByPlaceholderTextWithWait(getByPlaceholderText) {
  return await waitFor(() => getByPlaceholderText(/6 dígitos|6 d.gitos/));
}
