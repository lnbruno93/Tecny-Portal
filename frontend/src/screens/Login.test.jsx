import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
  <ToastProvider><Login /></ToastProvider>
);

// Helpers: getByLabelText(/contraseña/) matchea el input Y el toggle ojito
// (aria-label "Mostrar contraseña"). Usamos selectores específicos para
// distinguir input vs button.
const getUsernameInput = () => screen.getByLabelText('Usuario');
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

  it('login básico llama a useAuth().login con username trim + lowercase', async () => {
    mockLogin.mockResolvedValue({ user: { id: 1 } });
    renderL();
    const user = userEvent.setup();
    await user.type(getUsernameInput(), '  Lucas  ');
    await user.type(getPasswordInput(), 'pass123');
    await user.click(getSubmitBtn());
    await waitFor(() => expect(mockLogin).toHaveBeenCalled());
    expect(mockLogin).toHaveBeenCalledWith('lucas', 'pass123', undefined);
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
    expect(screen.queryByLabelText('Usuario')).not.toBeInTheDocument();
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
