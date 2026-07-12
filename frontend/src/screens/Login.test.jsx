import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// 2026-06-18 #321: Login.jsx ahora usa <Link to="/forgot-password"> — necesita
// Router context. MemoryRouter es el wrap correcto para tests (no toca el
// historial real del browser).
import { MemoryRouter } from 'react-router-dom';

// Mock de AuthContext — el Login usa `useAuth().login()`. Mockeamos con una
// función vi.fn() que cada test configura su resolved/rejected value antes
// de renderizar. Tests C1 auditoría 2026-06-06: Login.jsx no tenía coverage
// Vitest aunque es la única puerta de entrada al portal y el redesign
// reciente cambió mucho la estructura.
const mockLogin = vi.fn();
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

import Login from './Login';
import { ToastProvider } from '../contexts/ToastContext';

const renderL = () => render(
  <MemoryRouter><ToastProvider><Login /></ToastProvider></MemoryRouter>
);

// Helpers: getByLabelText(/contraseña/) matchea el input Y el toggle ojito
// (aria-label "Mostrar contraseña"). Usamos selectores específicos para
// distinguir input vs button.
const getUsernameInput = () => screen.getByLabelText('Usuario o email');
const getPasswordInput = () => screen.getByPlaceholderText('••••••••');
const getCodeInput     = () => screen.getByLabelText('Código de verificación');
const getSubmitBtn     = () => screen.getByRole('button', { name: /^(ingresar|verificar)/i });
const getEyeBtn        = () => screen.getByRole('button', { name: /^(mostrar|ocultar) contraseña$/i });

describe('Login — toggle ojito + flow 2FA', () => {
  beforeEach(() => { mockLogin.mockReset(); });

  it('toggle ojito alterna type="password" ↔ "text" e invierte aria-label', async () => {
    renderL();
    const user = userEvent.setup();
    expect(getPasswordInput()).toHaveAttribute('type', 'password');
    await user.click(getEyeBtn());
    expect(getPasswordInput()).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Ocultar contraseña' })).toBeInTheDocument();
    await user.click(getEyeBtn());
    expect(getPasswordInput()).toHaveAttribute('type', 'password');
  });

  it('login básico llama a useAuth().login con username trim (case preservado)', async () => {
    // TANDA 2.5: solo lowercaseamos si el input parece email (@). Usernames
    // preservan case porque `users.username` es case-sensitive en DB —
    // forzar lowercase rompía users pre-existentes con nombres como "Lucas".
    mockLogin.mockResolvedValue({ user: { id: 1 } });
    renderL();
    const user = userEvent.setup();
    await user.type(getUsernameInput(), '  Lucas  ');
    await user.type(getPasswordInput(), 'pass123');
    await user.click(getSubmitBtn());
    await waitFor(() => expect(mockLogin).toHaveBeenCalled());
    // Trim aplica, lowercase NO (no es email).
    // 2026-07-12 (P0-1 Externa): 4to arg hcaptchaResponse — undefined en
    // tests porque el widget hCaptcha en el screen no emite token en el
    // mock (setup del test no simula onVerify).
    expect(mockLogin).toHaveBeenCalledWith('Lucas', 'pass123', undefined, undefined);
  });

  it('TANDA 2.3: login con email también funciona (trim + lowercase)', async () => {
    // Backend acepta `username` o `email` desde TANDA 1; el frontend pasa el
    // identifier tal cual, y api.js lo rutea al field correcto según contenga
    // '@'. Acá testeamos solo la parte del Login.jsx — la decisión del field
    // está en api.test (no se mocká acá).
    mockLogin.mockResolvedValue({ user: { id: 2 } });
    renderL();
    const user = userEvent.setup();
    await user.type(getUsernameInput(), '  Lucas@Empresa.com  ');
    await user.type(getPasswordInput(), 'pass123');
    await user.click(getSubmitBtn());
    await waitFor(() => expect(mockLogin).toHaveBeenCalled());
    // El identifier viene normalizado a lowercase + trim (handleSubmit).
    // 2026-07-12 (P0-1 Externa): 4to arg undefined — idem test previo.
    expect(mockLogin).toHaveBeenCalledWith('lucas@empresa.com', 'pass123', undefined, undefined);
  });

  it('cuando el backend pide 2FA, oculta inputs iniciales y muestra input de código', async () => {
    mockLogin.mockResolvedValue({ twofa_required: true });
    renderL();
    const user = userEvent.setup();
    await user.type(getUsernameInput(), 'lucas');
    await user.type(getPasswordInput(), 'pass123');
    await user.click(getSubmitBtn());
    expect(await screen.findByRole('heading', { name: /verificación en 2 pasos/i })).toBeInTheDocument();
    expect(getCodeInput()).toBeInTheDocument();
    // Los inputs iniciales ya no están visibles.
    expect(screen.queryByLabelText('Usuario o email')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('••••••••')).not.toBeInTheDocument();
  });

  it('botón "Volver al login" del step 2FA resetea password pero mantiene username', async () => {
    mockLogin.mockResolvedValue({ twofa_required: true });
    renderL();
    const user = userEvent.setup();
    await user.type(getUsernameInput(), 'lucas');
    await user.type(getPasswordInput(), 'pass123');
    await user.click(getSubmitBtn());
    await screen.findByLabelText('Código de verificación');
    await user.click(screen.getByRole('button', { name: /volver al login/i }));
    // Step 1 reapareció — el password se reseteó (U5 auditoría previa);
    // username queda igual para que el operador solo retipee lo que estuvo mal.
    expect(getPasswordInput()).toHaveValue('');
    expect(getUsernameInput()).toHaveValue('lucas');
  });

  it('error de login muestra mensaje al usuario', async () => {
    mockLogin.mockRejectedValue(new Error('Usuario o contraseña incorrectos'));
    renderL();
    const user = userEvent.setup();
    await user.type(getUsernameInput(), 'lucas');
    await user.type(getPasswordInput(), 'wrong');
    await user.click(getSubmitBtn());
    expect(await screen.findByText(/usuario o contraseña incorrectos/i)).toBeInTheDocument();
  });
});
