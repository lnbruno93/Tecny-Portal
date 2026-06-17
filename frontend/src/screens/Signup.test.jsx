import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mocks — el Signup usa:
//   - useAuth().setAuthFromSignup → persistir token + setear user.
//   - useNavigate → redirect a /inicio post-success.
//   - auth.signup de lib/api → POST al backend.
const mockSetAuthFromSignup = vi.fn();
const mockNavigate = vi.fn();
const mockSignup = vi.fn();

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ setAuthFromSignup: mockSetAuthFromSignup }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../lib/api', () => ({
  auth: {
    signup: (...args) => mockSignup(...args),
  },
}));

import Signup from './Signup';

const renderS = () => render(
  <MemoryRouter><Signup /></MemoryRouter>
);

// Selectores — los labels exactos del form (ver Signup.jsx).
const getNombre   = () => screen.getByLabelText('Tu nombre');
const getEmail    = () => screen.getByLabelText('Email');
const getPassword = () => screen.getByLabelText('Contraseña');
const getEmpresa  = () => screen.getByLabelText('Nombre de tu empresa');
const getSubmit   = () => screen.getByRole('button', { name: /crear cuenta/i });
const getEyeBtn   = () => screen.getByRole('button', { name: /^(mostrar|ocultar) contraseña$/i });

describe('Signup — TANDA 2.2 Fase B', () => {
  beforeEach(() => {
    mockSetAuthFromSignup.mockReset();
    mockNavigate.mockReset();
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
    // Link a / (Iniciar sesión)
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

  it('signup exitoso → llama setAuthFromSignup + navigate a /inicio', async () => {
    const fakeData = {
      token: 'jwt-fake',
      user:  { id: 1, email: 'test@x.com', email_verified: false },
      tenant: { id: 1, slug: 'mi-empresa' },
      verification_required: true,
    };
    mockSignup.mockResolvedValue(fakeData);
    renderS();
    const user = userEvent.setup();

    await user.type(getNombre(), 'Lucas Bruno');
    await user.type(getEmail(), '  Lucas@Example.COM  ');
    await user.type(getPassword(), 'pass1234');
    await user.type(getEmpresa(), 'Mi empresa SA');
    await user.click(getSubmit());

    // Email se normaliza a lowercase + trim.
    await waitFor(() => expect(mockSignup).toHaveBeenCalled());
    expect(mockSignup).toHaveBeenCalledWith({
      nombre:        'Lucas Bruno',
      email:         'lucas@example.com',
      password:      'pass1234',
      tenant_nombre: 'Mi empresa SA',
    });
    expect(mockSetAuthFromSignup).toHaveBeenCalledWith({ token: 'jwt-fake', user: fakeData.user });
    expect(mockNavigate).toHaveBeenCalledWith('/inicio', { replace: true });
  });

  it('error del backend muestra mensaje sin navegar', async () => {
    mockSignup.mockRejectedValue(new Error('Email ya registrado'));
    renderS();
    const user = userEvent.setup();

    await user.type(getNombre(), 'Lucas');
    await user.type(getEmail(), 'duplicado@x.com');
    await user.type(getPassword(), 'pass1234');
    await user.type(getEmpresa(), 'Mi empresa');
    await user.click(getSubmit());

    expect(await screen.findByText(/email ya registrado/i)).toBeInTheDocument();
    expect(mockSetAuthFromSignup).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
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
    resolveSignup({ token: 't', user: { id: 1 } });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
  });
});
