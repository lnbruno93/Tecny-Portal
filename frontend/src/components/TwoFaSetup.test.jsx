// Tests del componente TwoFaSetup — flow guiado para activar 2FA.
//
// Cubre los 3 pasos del flow:
//   1. Mostrar QR + secret + 8 recovery codes (post-setup OK).
//   2. Usuario tipea código de verificación de 6 dígitos.
//   3. POST /enable con el código → mostrar "Activado" → llamar onDone.
//
// Mockea la lib api/twoFa y qrcode (toCanvas) para evitar deps reales.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { ToastProvider } from '../contexts/ToastContext';

// Mock de la API.
vi.mock('../lib/api', () => ({
  twoFa: {
    setup: vi.fn(() => Promise.resolve({
      secret: 'ABCDEFGH12345678ABCD',
      otpauth_uri: 'otpauth://totp/iPro:test?secret=ABCD&issuer=iPro',
      recovery_codes: [
        'AAAA-BBBB-CC', 'DDDD-EEEE-FF', 'GGGG-HHHH-II', 'JJJJ-KKKK-LL',
        'MMMM-NNNN-OO', 'PPPP-QQQQ-RR', 'SSSS-TTTT-UU', 'VVVV-WWWW-XX',
      ],
    })),
    enable: vi.fn(() => Promise.resolve({ ok: true })),
  },
}));

// Mock qrcode — el render real falla en jsdom (no canvas API).
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(() => Promise.resolve()) },
  toCanvas: vi.fn(() => Promise.resolve()),
}));

import TwoFaSetup from './TwoFaSetup';
import { twoFa } from '../lib/api';

function renderSetup(props = {}) {
  return render(
    <ToastProvider>
      <TwoFaSetup onDone={vi.fn()} onCancel={vi.fn()} {...props} />
    </ToastProvider>
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Reset mock implementation to default (used by other tests after error tests change it).
  twoFa.setup.mockImplementation(() => Promise.resolve({
    secret: 'ABCDEFGH12345678ABCD',
    otpauth_uri: 'otpauth://totp/iPro:test?secret=ABCD&issuer=iPro',
    recovery_codes: [
      'AAAA-BBBB-CC', 'DDDD-EEEE-FF', 'GGGG-HHHH-II', 'JJJJ-KKKK-LL',
      'MMMM-NNNN-OO', 'PPPP-QQQQ-RR', 'SSSS-TTTT-UU', 'VVVV-WWWW-XX',
    ],
  }));
  twoFa.enable.mockImplementation(() => Promise.resolve({ ok: true }));
});

describe('TwoFaSetup — render inicial', () => {
  it('muestra "Generando código de seguridad…" mientras carga', () => {
    // setup() devuelve una promesa que tarda — capturamos el estado inicial.
    let resolveSetup;
    twoFa.setup.mockImplementationOnce(() => new Promise(r => { resolveSetup = r; }));
    const { container } = renderSetup();
    expect(container.textContent).toContain('Generando código de seguridad');
    // No dejamos colgando — resolvemos para que el componente termine de montar.
    resolveSetup({ secret: 'X', otpauth_uri: 'X', recovery_codes: ['1','2','3','4','5','6','7','8'] });
  });

  it('después de cargar muestra los 3 pasos del setup', async () => {
    const { findByText, container } = renderSetup();
    await findByText(/Paso 1 — Escaneá el QR/);
    expect(container.textContent).toContain('Paso 2');
    expect(container.textContent).toContain('Paso 3');
  });
});

describe('TwoFaSetup — datos del setup', () => {
  it('muestra el secret manual (para fallback si no se escanea el QR)', async () => {
    const { findByText } = renderSetup();
    await findByText('ABCDEFGH12345678ABCD');
  });

  it('muestra los 8 recovery codes', async () => {
    const { findByText, container } = renderSetup();
    await findByText('AAAA-BBBB-CC');
    const codes = ['DDDD-EEEE-FF', 'GGGG-HHHH-II', 'JJJJ-KKKK-LL',
                   'MMMM-NNNN-OO', 'PPPP-QQQQ-RR', 'SSSS-TTTT-UU', 'VVVV-WWWW-XX'];
    for (const c of codes) {
      expect(container.textContent).toContain(c);
    }
  });

  it('warning visible advirtiendo que los recovery codes no se vuelven a mostrar', async () => {
    const { findByText, container } = renderSetup();
    await findByText(/Paso 2 — Guardá estos recovery codes/);
    // "No se vuelven a mostrar" o similar advertencia
    expect(container.textContent.toLowerCase()).toContain('no se vuelven a mostrar');
  });
});

describe('TwoFaSetup — verificación de código', () => {
  it('rechaza códigos que no sean 6 dígitos numéricos', async () => {
    const { findByText, getByPlaceholderText, container } = renderSetup();
    await findByText('ABCDEFGH12345678ABCD');
    const input = getByPlaceholderText('123456');
    // Tipear letras: el onChange filtra non-digits.
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(input.value).toBe('');
    // Tipear 12345 (5 dígitos) y submit: muestra error.
    fireEvent.change(input, { target: { value: '12345' } });
    expect(input.value).toBe('12345');
    // El botón Activar 2FA está disabled mientras code.length !== 6.
    const btn = container.querySelector('button[type="submit"]');
    expect(btn.disabled).toBe(true);
  });

  it('código válido habilita el botón y llama enable() al submit', async () => {
    const onDone = vi.fn();
    const { findByText, getByPlaceholderText, container } = renderSetup({ onDone });
    await findByText('ABCDEFGH12345678ABCD');

    const input = getByPlaceholderText('123456');
    fireEvent.change(input, { target: { value: '123456' } });
    const btn = container.querySelector('button[type="submit"]');
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    await waitFor(() => expect(twoFa.enable).toHaveBeenCalledWith('123456'));
    // Pequeño delay (800ms en el componente) antes de llamar onDone — esperamos.
    await waitFor(() => expect(onDone).toHaveBeenCalled(), { timeout: 1500 });
  });

  it('muestra el heading "2FA activado" después del enable exitoso', async () => {
    const { findByText, findByRole, getByPlaceholderText, container } = renderSetup({ onDone: () => {} });
    await findByText('ABCDEFGH12345678ABCD');
    fireEvent.change(getByPlaceholderText('123456'), { target: { value: '123456' } });
    fireEvent.click(container.querySelector('button[type="submit"]'));
    // El step 'done' renderiza <h3>2FA activado</h3>. Buscamos por role
    // para diferenciar del toast (que tiene el mismo texto).
    const heading = await findByRole('heading', { name: /2FA activado/i });
    expect(heading).toBeTruthy();
  });

  it('si enable() falla, vuelve al step "scan" y muestra el error', async () => {
    twoFa.enable.mockRejectedValueOnce(new Error('Código incorrecto.'));
    const { findByText, getByPlaceholderText, container } = renderSetup();
    await findByText('ABCDEFGH12345678ABCD');
    fireEvent.change(getByPlaceholderText('123456'), { target: { value: '654321' } });
    fireEvent.click(container.querySelector('button[type="submit"]'));
    await findByText('Código incorrecto.');
    // El input se limpia para reintentar.
    expect(getByPlaceholderText('123456').value).toBe('');
  });
});

describe('TwoFaSetup — cancelar / error en setup', () => {
  it('si twoFa.setup() falla, llama onCancel + toast error', async () => {
    twoFa.setup.mockRejectedValueOnce(new Error('Server error'));
    const onCancel = vi.fn();
    renderSetup({ onCancel });
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it('botón "Cancelar" llama onCancel', async () => {
    const onCancel = vi.fn();
    const { findByText } = renderSetup({ onCancel });
    await findByText('ABCDEFGH12345678ABCD');
    fireEvent.click(await findByText('Cancelar'));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('TwoFaSetup — copiar al portapapeles', () => {
  it('botón "Copiar código" usa navigator.clipboard.writeText con el secret', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });

    const { findByText } = renderSetup();
    await findByText('ABCDEFGH12345678ABCD');
    fireEvent.click(await findByText('Copiar código'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCDEFGH12345678ABCD'));
  });

  it('botón "Copiar los 8 codes" copia el join de los 8 recovery codes', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });

    const { findByText } = renderSetup();
    await findByText('AAAA-BBBB-CC');
    fireEvent.click(await findByText('Copiar los 8 codes'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
      const arg = writeText.mock.calls[0][0];
      // Debe incluir todos los 8 codes separados por newline.
      expect(arg).toContain('AAAA-BBBB-CC');
      expect(arg).toContain('VVVV-WWWW-XX');
      expect(arg.split('\n').length).toBe(8);
    });
  });
});
