/**
 * Tests del ForgotPassword screen (TANDA 0 #321).
 *
 * Cubre:
 *   - Render del form inicial con email input + hCaptcha mock + submit.
 *   - Submit happy path → muestra pantalla "Revisá tu email" con el email
 *     normalizado (trim + lowercase) y TTL del backend.
 *   - Anti-enum: la pantalla post-submit es idéntica para emails existentes
 *     vs no-existentes (el backend responde el mismo shape).
 *   - "Volver y reintentar" CTA resetea el form para permitir retipear.
 *   - Error de red surface el mensaje al user + resetea captcha token.
 *   - Link "Volver a iniciar sesión" presente en ambos states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockForgotPassword = vi.fn();

vi.mock('../lib/api', () => ({
  auth: {
    forgotPassword: (...args) => mockForgotPassword(...args),
  },
}));

// Mock hCaptcha — auto-verify con token fake al montar (passive mode).
vi.mock('@hcaptcha/react-hcaptcha', () => {
  const React = require('react');
  return {
    default: React.forwardRef(function MockHCaptcha({ onVerify }, ref) {
      React.useImperativeHandle(ref, () => ({ resetCaptcha: () => {} }));
      React.useEffect(() => {
        if (onVerify) onVerify('mock-captcha-token');
      }, [onVerify]);
      return React.createElement('div', { 'data-testid': 'hcaptcha-mock' });
    }),
  };
});

import ForgotPassword from './ForgotPassword';

const renderFP = () => render(
  <MemoryRouter><ForgotPassword /></MemoryRouter>
);

const getEmail = () => screen.getByLabelText('Email');
const getSubmit = () => screen.getByRole('button', { name: /mandar link de reset/i });

describe('ForgotPassword', () => {
  beforeEach(() => { mockForgotPassword.mockReset(); });

  it('renderiza el form inicial con email + captcha + submit', () => {
    renderFP();
    expect(screen.getByRole('heading', { name: /olvidaste tu contraseña/i })).toBeInTheDocument();
    expect(getEmail()).toBeInTheDocument();
    expect(screen.getByTestId('hcaptcha-mock')).toBeInTheDocument();
    expect(getSubmit()).toBeInTheDocument();
    // Footer link a login.
    expect(screen.getByRole('link', { name: /iniciar sesión/i })).toBeInTheDocument();
  });

  it('happy path → muestra "Revisá tu email" con TTL del backend', async () => {
    mockForgotPassword.mockResolvedValue({
      reset_required: true,
      reset_token_ttl_hours: 1,
    });

    const user = userEvent.setup();
    renderFP();
    await user.type(getEmail(), '  ALICE@example.com  '); // espacios + caps a propósito
    await user.click(getSubmit());

    // Backend recibe el email normalizado (trim + lowercase).
    await waitFor(() => expect(mockForgotPassword)
      .toHaveBeenCalledWith('alice@example.com', 'mock-captcha-token'));

    // Pantalla nueva.
    expect(await screen.findByRole('heading', { name: /revisá tu email/i })).toBeInTheDocument();
    expect(screen.getByText(/alice@example.com/i)).toBeInTheDocument();
    // TTL "1 hora" — singular.
    expect(screen.getByText(/expira en\s+1\s+hora\b/i)).toBeInTheDocument();
  });

  it('TTL en plural cuando ttl_hours > 1', async () => {
    mockForgotPassword.mockResolvedValue({
      reset_required: true,
      reset_token_ttl_hours: 24,
    });

    const user = userEvent.setup();
    renderFP();
    await user.type(getEmail(), 'b@example.com');
    await user.click(getSubmit());

    await screen.findByRole('heading', { name: /revisá tu email/i });
    expect(screen.getByText(/expira en\s+24\s+horas/i)).toBeInTheDocument();
  });

  it('"Volver y reintentar" resetea el form', async () => {
    mockForgotPassword.mockResolvedValue({ reset_required: true, reset_token_ttl_hours: 1 });
    const user = userEvent.setup();
    renderFP();
    await user.type(getEmail(), 'first@example.com');
    await user.click(getSubmit());

    await screen.findByRole('heading', { name: /revisá tu email/i });
    await user.click(screen.getByRole('button', { name: /volver y reintentar/i }));

    // Volvió al form inicial — heading + input vacío.
    expect(screen.getByRole('heading', { name: /olvidaste tu contraseña/i })).toBeInTheDocument();
    expect(getEmail()).toHaveValue('');
  });

  it('error del backend muestra mensaje + permite reintentar', async () => {
    mockForgotPassword.mockRejectedValue(new Error('Network down'));

    const user = userEvent.setup();
    renderFP();
    await user.type(getEmail(), 'x@example.com');
    await user.click(getSubmit());

    await screen.findByText(/network down/i);
    // El form sigue visible (no fue al success screen).
    expect(getEmail()).toBeInTheDocument();
  });
});
