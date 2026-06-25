/**
 * Tests del componente OnboardingCard (TANDA 1 H3 #323).
 *
 * Cubre:
 *   - Render con todos los items pendientes → 3 items + sin tachar.
 *   - Render con un item completado → ese item tachado, opacity reducida.
 *   - Render con los 3 items completos → card NO se renderiza (null).
 *   - Botón "Saltar tour" persiste en localStorage + oculta la card.
 *   - localStorage flag pre-existente → card NO se renderiza desde el inicio.
 *   - Error fetcheando status → card NO se renderiza (fail-silent).
 *   - Links apuntan a los módulos correctos (Inventario, Contactos, Ventas).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockStatus = vi.fn();
const mockResendVerification = vi.fn();
vi.mock('../lib/api', () => ({
  onboarding: {
    status: () => mockStatus(),
  },
  auth: {
    resendVerification: () => mockResendVerification(),
  },
}));

// 2026-06-25 ONB-7: OnboardingCard ahora usa useAuth() para mostrar/ocultar
// el step "Verificá tu email". Mockeamos el context con user.email_verified=true
// para que los tests existentes (que no testean el step 0) sigan funcionando.
// Test específico de ONB-7 abajo overrides este mock con email_verified=false.
let mockUser = { email_verified: true, email: 'lucas@example.com' };
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

import OnboardingCard from './OnboardingCard';

const DISMISS_KEY = 'onboarding_dismissed_v1';

function renderCard() {
  return render(<MemoryRouter><OnboardingCard /></MemoryRouter>);
}

describe('OnboardingCard', () => {
  beforeEach(() => {
    mockStatus.mockReset();
    localStorage.removeItem(DISMISS_KEY);
  });

  it('todos los items pendientes → renderiza los 3', async () => {
    mockStatus.mockResolvedValue({
      has_productos: false, has_contactos: false, has_ventas: false,
    });
    renderCard();
    expect(await screen.findByText(/agregá tu primer producto/i)).toBeInTheDocument();
    expect(screen.getByText(/creá tu primer contacto/i)).toBeInTheDocument();
    expect(screen.getByText(/registrá tu primera venta/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /bienvenido/i })).toBeInTheDocument();
  });

  it('item completado → tachado con line-through', async () => {
    mockStatus.mockResolvedValue({
      has_productos: true, has_contactos: false, has_ventas: false,
    });
    renderCard();
    const productoLabel = await screen.findByText(/agregá tu primer producto/i);
    // line-through aplicado.
    expect(productoLabel).toHaveStyle({ textDecoration: 'line-through' });
    // Pendiente NO tiene line-through.
    expect(screen.getByText(/creá tu primer contacto/i))
      .toHaveStyle({ textDecoration: 'none' });
  });

  it('los 3 completos → card NO se renderiza', async () => {
    mockStatus.mockResolvedValue({
      has_productos: true, has_contactos: true, has_ventas: true,
    });
    const { container } = renderCard();
    // Esperamos un tick para que el effect resuelva.
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    // Container vacío.
    expect(container.firstChild).toBeNull();
  });

  it('botón "Saltar tour" oculta + persiste en localStorage', async () => {
    mockStatus.mockResolvedValue({
      has_productos: false, has_contactos: false, has_ventas: false,
    });
    renderCard();
    const dismissBtn = await screen.findByRole('button', { name: /saltar tour/i });

    const user = userEvent.setup();
    await user.click(dismissBtn);

    // Card oculta.
    expect(screen.queryByText(/bienvenido a ipro/i)).not.toBeInTheDocument();
    // localStorage flag seteado.
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1');
  });

  it('localStorage flag pre-existente → no llama API ni renderiza', async () => {
    localStorage.setItem(DISMISS_KEY, '1');
    mockStatus.mockResolvedValue({ has_productos: false, has_contactos: false, has_ventas: false });
    const { container } = renderCard();

    // Esperamos un poco — el effect no debería llamar mockStatus en este path.
    await new Promise(r => setTimeout(r, 50));
    expect(mockStatus).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it('error fetcheando status → card NO renderiza (fail-silent)', async () => {
    mockStatus.mockRejectedValue(new Error('Backend down'));
    const { container } = renderCard();
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    // No mostramos error al user — el onboarding es opcional.
    expect(container.firstChild).toBeNull();
  });

  it('los links apuntan a los módulos correctos', async () => {
    mockStatus.mockResolvedValue({
      has_productos: false, has_contactos: false, has_ventas: false,
    });
    renderCard();
    await screen.findByText(/agregá tu primer producto/i);

    const links = screen.getAllByRole('link');
    const hrefs = links.map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/inventario');
    expect(hrefs).toContain('/contactos');
    expect(hrefs).toContain('/ventas');
  });

  // 2026-06-25 ONB-7 (audit pre-live): step 0 "Verificá tu email" para users
  // unverified. Antes el OnboardingCard listaba 3 pasos pero ninguno era email;
  // el bloqueo blando del backend impedía completarlos sin que el card lo
  // explicara. Ahora se incluye con CTA "Reenviar link" inline.
  describe('ONB-7: step "Verificá tu email"', () => {
    beforeEach(() => {
      // Reset mock entre tests del describe (otros tests usan email_verified=true).
      mockUser = { email_verified: false, email: 'lucas@example.com' };
      mockResendVerification.mockReset();
    });

    it('user unverified → step "Verificá tu email" visible con CTA', async () => {
      mockStatus.mockResolvedValue({
        has_productos: false, has_contactos: false, has_ventas: false,
      });
      renderCard();
      expect(await screen.findByText(/verificá tu email/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reenviar link/i })).toBeInTheDocument();
    });

    it('clickear "Reenviar link" llama API + muestra confirm con email', async () => {
      mockStatus.mockResolvedValue({
        has_productos: false, has_contactos: false, has_ventas: false,
      });
      mockResendVerification.mockResolvedValue({});
      renderCard();
      const btn = await screen.findByRole('button', { name: /reenviar link/i });

      const user = userEvent.setup();
      await user.click(btn);

      await waitFor(() => expect(mockResendVerification).toHaveBeenCalledTimes(1));
      // Confirm mensaje incluye el email del user (anti-typo guard).
      expect(await screen.findByText(/lucas@example\.com/i)).toBeInTheDocument();
    });

    it('los 4 items completos (email + 3 CRUD) → card NO renderiza', async () => {
      mockUser = { email_verified: true, email: 'lucas@example.com' };
      mockStatus.mockResolvedValue({
        has_productos: true, has_contactos: true, has_ventas: true,
      });
      const { container } = renderCard();
      await waitFor(() => expect(mockStatus).toHaveBeenCalled());
      expect(container.firstChild).toBeNull();
    });

    it('3 CRUD completos pero email no verificado → card SIGUE visible', async () => {
      // Acá mockUser ya está unverified por el beforeEach del describe.
      mockStatus.mockResolvedValue({
        has_productos: true, has_contactos: true, has_ventas: true,
      });
      renderCard();
      expect(await screen.findByText(/verificá tu email/i)).toBeInTheDocument();
    });
  });
});
