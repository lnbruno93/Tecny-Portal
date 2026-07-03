import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// TANDA 2.7 anti-enum: el Signup ya NO usa setAuthFromSignup ni useNavigate
// (no hay auto-login post-success). Mock solo de lib/api.signup; toggle ojito
// y el flujo nuevo "Revisá tu email" se prueban directamente.
const mockSignup = vi.fn();

vi.mock('../lib/api', () => ({
  auth: {
    signup: (...args) => mockSignup(...args),
  },
}));

// CAPTCHA: mock del widget hCaptcha — el real intenta cargar script externo
// y abre iframe, lo que JSDOM no soporta. El mock auto-dispara onVerify con
// un token fake al montar, simulando el modo "99.9% passive" donde el captcha
// resuelve invisible. Tests que quieran probar el path "captcha no resuelto"
// pueden overridear este mock.
vi.mock('@hcaptcha/react-hcaptcha', () => {
  const React = require('react');
  return {
    default: React.forwardRef(function MockHCaptcha({ onVerify }, ref) {
      React.useImperativeHandle(ref, () => ({
        resetCaptcha: () => {},
      }));
      React.useEffect(() => {
        // Disparo del verify con token fake (simula passive mode auto-pass).
        if (onVerify) onVerify('mock-captcha-token');
      }, [onVerify]);
      return React.createElement('div', { 'data-testid': 'hcaptcha-mock' });
    }),
  };
});

import Signup from './Signup';

const renderS = () => render(
  <MemoryRouter><Signup /></MemoryRouter>
);

// Selectores — los labels usan regex porque llevan `*` de required (audit
// 2026-07-04 P3). El regex evita romperse si mañana cambiamos el asterisco
// por otra marca visual.
const getNombre   = () => screen.getByLabelText(/^Tu nombre/);
const getEmail    = () => screen.getByLabelText(/^Email/);
const getPassword = () => screen.getByLabelText(/^Contraseña/);
const getEmpresa  = () => screen.getByLabelText(/^Nombre de tu empresa/);
const getSubmit   = () => screen.getByRole('button', { name: /crear cuenta/i });
const getEyeBtn   = () => screen.getByRole('button', { name: /^(mostrar|ocultar) contraseña$/i });

describe('Signup — TANDA 2.7 anti-enum', () => {
  beforeEach(() => {
    mockSignup.mockReset();
  });

  it('renderiza split-screen completo con 4 inputs + brand panel', () => {
    renderS();
    // Form panel
    expect(screen.getByRole('heading', { name: /crear tu cuenta/i })).toBeInTheDocument();
    expect(getNombre()).toBeInTheDocument();
    expect(getEmail()).toBeInTheDocument();
    expect(getPassword()).toBeInTheDocument();
    expect(getEmpresa()).toBeInTheDocument();
    expect(getSubmit()).toBeInTheDocument();
    // Brand panel (oculto < 900px vía CSS, pero el DOM existe)
    expect(screen.getByText(/cuenta nueva/i)).toBeInTheDocument();
    expect(screen.getByText(/todo tu negocio/i)).toBeInTheDocument();
    // Link a / (Iniciar sesión) — el form panel tiene el link al login.
    expect(screen.getByRole('link', { name: /iniciar sesión/i })).toHaveAttribute('href', '/');
  });

  it('toggle ojito alterna type del password input', async () => {
    renderS();
    const user = userEvent.setup();
    expect(getPassword()).toHaveAttribute('type', 'password');
    await user.click(getEyeBtn());
    expect(getPassword()).toHaveAttribute('type', 'text');
    await user.click(getEyeBtn());
    expect(getPassword()).toHaveAttribute('type', 'password');
  });

  it('signup exitoso → muestra pantalla "Revisá tu email" con el email submitido (NO auto-login)', async () => {
    // TANDA 2.7: el backend devuelve { verification_required: true } sin
    // token/user. El frontend muestra una pantalla de "revisá tu email"
    // idéntica para email nuevo vs. duplicado (anti-enum).
    mockSignup.mockResolvedValue({ verification_required: true });
    renderS();
    const user = userEvent.setup();

    await user.type(getNombre(), 'Lucas Bruno');
    await user.type(getEmail(), '  Lucas@Example.COM  ');
    await user.type(getPassword(), 'pass1234');
    await user.type(getEmpresa(), 'Mi empresa SA');
    await user.click(getSubmit());

    // Email se normaliza a lowercase + trim. CAPTCHA token incluído
    // (mock auto-dispara onVerify con 'mock-captcha-token').
    // Multi-país F4 (#470): pais default 'AR' siempre va en el body.
    await waitFor(() => expect(mockSignup).toHaveBeenCalled());
    expect(mockSignup).toHaveBeenCalledWith({
      nombre:            'Lucas Bruno',
      email:             'lucas@example.com',
      password:          'pass1234',
      tenant_nombre:     'Mi empresa SA',
      pais:              'AR',
      hcaptcha_response: 'mock-captcha-token',
    });

    // Reemplaza el form con la pantalla de "Revisá tu email" + email visible.
    expect(await screen.findByRole('heading', { name: /revisá tu email/i })).toBeInTheDocument();
    expect(screen.getByText('lucas@example.com')).toBeInTheDocument();
    // Los inputs del form ya no están renderizados.
    expect(screen.queryByLabelText('Tu nombre')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    // Hay un link "Ir a iniciar sesión" hacia /.
    expect(screen.getByRole('link', { name: /iniciar sesión/i })).toHaveAttribute('href', '/');
  });

  it('TANDA 1 fix U2: CTA "Volver y crear cuenta de nuevo" resetea al form', async () => {
    // Trade-off del anti-enum: user con typo en email no recibe error. Sin CTA
    // queda atrapado. El botón debe reaparecer el form (con email vacío) y
    // permitir reintentar.
    mockSignup.mockResolvedValue({ verification_required: true });
    renderS();
    const user = userEvent.setup();

    await user.type(getNombre(), 'Lucas');
    await user.type(getEmail(), 'typo@gnail.com'); // typo intencional
    await user.type(getPassword(), 'pass1234');
    await user.type(getEmpresa(), 'Mi empresa');
    await user.click(getSubmit());

    expect(await screen.findByRole('heading', { name: /revisá tu email/i })).toBeInTheDocument();
    // Click en CTA "Volver y crear cuenta de nuevo".
    await user.click(screen.getByRole('button', { name: /volver y crear cuenta de nuevo/i }));

    // El form reaparece y el campo email está vacío (para retipear).
    expect(screen.getByLabelText(/^Tu nombre/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Email/)).toHaveValue('');
    expect(screen.queryByRole('heading', { name: /revisá tu email/i })).not.toBeInTheDocument();
  });

  it('error del backend muestra mensaje sin pasar a "Revisá tu email"', async () => {
    mockSignup.mockRejectedValue(new Error('Rate limit excedido'));
    renderS();
    const user = userEvent.setup();

    await user.type(getNombre(), 'Lucas');
    await user.type(getEmail(), 'rate@x.com');
    await user.type(getPassword(), 'pass1234');
    await user.type(getEmpresa(), 'Mi empresa');
    await user.click(getSubmit());

    expect(await screen.findByText(/rate limit/i)).toBeInTheDocument();
    // El form sigue visible (no se mostró la pantalla "Revisá tu email").
    expect(screen.getByLabelText(/^Tu nombre/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /revisá tu email/i })).not.toBeInTheDocument();
  });

  it('botón deshabilitado mientras loadea + texto cambia a "Creando cuenta…"', async () => {
    let resolveSignup;
    mockSignup.mockImplementation(() => new Promise(r => { resolveSignup = r; }));
    renderS();
    const user = userEvent.setup();

    await user.type(getNombre(), 'Lucas');
    await user.type(getEmail(), 'test@x.com');
    await user.type(getPassword(), 'pass1234');
    await user.type(getEmpresa(), 'Mi empresa');
    await user.click(getSubmit());

    // Mientras el signup está pending, el botón se deshabilita y cambia texto.
    expect(await screen.findByRole('button', { name: /creando cuenta…/i })).toBeDisabled();

    // Resolveo la promesa para no dejar el test colgado.
    resolveSignup({ verification_required: true });
    // Pantalla "Revisá tu email" aparece después de resolve.
    await waitFor(() => expect(screen.queryByRole('heading', { name: /revisá tu email/i })).toBeInTheDocument());
  });

  // ── TANDA 1 #322 H2: password policy client-side ────────────────────────
  // Backend requiere min 8 + letra + número (Zod). Antes el form solo
  // validaba HTML minLength=8 → passwords como "12345678" o "abcdefgh"
  // pasaban al backend que devolvía "No se pudo crear la cuenta" genérico.
  // Ahora validación inline antes del round-trip.

  describe('#322 password policy client-side', () => {
    async function fillForm({ pw }) {
      const user = userEvent.setup();
      renderS();
      await user.type(getNombre(), 'Lucas');
      await user.type(getEmail(), 'test@x.com');
      await user.type(getPassword(), pw);
      await user.type(getEmpresa(), 'Mi empresa');
      return user;
    }

    it('rechaza password sin letra ("12345678") + NO llama backend', async () => {
      const user = await fillForm({ pw: '12345678' });
      await user.click(getSubmit());
      expect(await screen.findByText(/al menos una letra/i)).toBeInTheDocument();
      expect(mockSignup).not.toHaveBeenCalled();
    });

    it('rechaza password sin número ("abcdefgh") + NO llama backend', async () => {
      const user = await fillForm({ pw: 'abcdefgh' });
      await user.click(getSubmit());
      expect(await screen.findByText(/al menos un número/i)).toBeInTheDocument();
      expect(mockSignup).not.toHaveBeenCalled();
    });

    it('acepta password válida (8 chars + letra + número) y llama backend', async () => {
      mockSignup.mockResolvedValue({ verification_required: true });
      const user = await fillForm({ pw: 'pass1234' });
      await user.click(getSubmit());
      await waitFor(() => expect(mockSignup).toHaveBeenCalledTimes(1));
    });

    it('error inline se limpia cuando el user corrige', async () => {
      const user = await fillForm({ pw: '12345678' });
      await user.click(getSubmit());
      expect(await screen.findByText(/al menos una letra/i)).toBeInTheDocument();
      // Agregamos una letra al input → el error desaparece.
      await user.type(getPassword(), 'a');
      expect(screen.queryByText(/al menos una letra/i)).not.toBeInTheDocument();
    });
  });

  // ── Multi-país F4 (#470): selector país AR/UY ───────────────────────────
  // El form renderiza un segmented control con dos opciones (AR | UY). El
  // backend persiste tenant.pais con este valor y seedea cajas + alertas
  // TC según corresponda. Default visual: AR.
  describe('#470 selector país AR/UY', () => {
    it('renderiza ambas opciones con AR seleccionada por default', () => {
      renderS();
      const arBtn = screen.getByRole('radio', { name: /Argentina/i });
      const uyBtn = screen.getByRole('radio', { name: /Uruguay/i });
      expect(arBtn).toBeInTheDocument();
      expect(uyBtn).toBeInTheDocument();
      // AR está checked por default.
      expect(arBtn).toHaveAttribute('aria-checked', 'true');
      expect(uyBtn).toHaveAttribute('aria-checked', 'false');
      // Hint copy refleja AR.
      expect(screen.getByText(/Vas a operar en ARS/i)).toBeInTheDocument();
    });

    it('click en Uruguay cambia aria-checked + hint copy', async () => {
      renderS();
      const user = userEvent.setup();
      const uyBtn = screen.getByRole('radio', { name: /Uruguay/i });
      await user.click(uyBtn);
      expect(uyBtn).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: /Argentina/i })).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByText(/Vas a operar en UYU/i)).toBeInTheDocument();
    });

    it('submit con UY seleccionado → body POST incluye pais="UY"', async () => {
      mockSignup.mockResolvedValue({ verification_required: true });
      renderS();
      const user = userEvent.setup();
      // Elegimos UY antes de llenar el resto.
      await user.click(screen.getByRole('radio', { name: /Uruguay/i }));
      await user.type(getNombre(), 'Juan Perez');
      await user.type(getEmail(), 'uy@example.com');
      await user.type(getPassword(), 'pass1234');
      await user.type(getEmpresa(), 'Mi empresa UY');
      await user.click(getSubmit());

      await waitFor(() => expect(mockSignup).toHaveBeenCalled());
      // El body POST contiene pais: 'UY' (no 'AR').
      const call = mockSignup.mock.calls[0][0];
      expect(call.pais).toBe('UY');
      expect(call.tenant_nombre).toBe('Mi empresa UY');
    });
  });
});
