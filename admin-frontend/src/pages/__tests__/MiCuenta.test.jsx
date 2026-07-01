// Smoke test de la pantalla Mi cuenta (task #498).
//
// El objetivo NO es cubrir todo el flow — TwoFaSection y ChangePasswordModal
// tienen sus propios tests. Acá validamos:
//   1. Render básico con ambos tabs (Seguridad y Perfil) visibles
//   2. El tab por default es "Seguridad"
//   3. Cambiar al tab "Perfil" muestra los datos del user
//
// Mockeamos twoFa.status para que la TwoFaSection interna no explote
// haciendo un fetch real durante el mount.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../../lib/api.js', () => ({
  adminApi: { me: vi.fn() },
  auth: {
    changePassword: vi.fn(),
  },
  twoFa: {
    // status se llama al montar TwoFaSection — devolvemos "no activado"
    // para que el componente entre al estado más simple posible.
    status: vi.fn().mockResolvedValue({
      configured: false,
      enabled: false,
      enabled_at: null,
      last_used_at: null,
      recovery_codes_remaining: 0,
    }),
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

vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: {
      id: 1,
      username: 'lucas.bruno',
      email: 'lucas@tecnyapp.com',
      is_super_admin: true,
    },
    logout: vi.fn(),
  }),
  AuthProvider: ({ children }) => children,
}));

import MiCuenta from '../MiCuenta.jsx';

function renderMiCuenta(initialPath = '/mi-cuenta') {
  window.history.pushState({}, '', initialPath);
  return render(
    <BrowserRouter>
      <MiCuenta />
    </BrowserRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  try { window.localStorage.clear(); } catch { /* noop */ }
});

describe('MiCuenta', () => {
  it('renderiza el título y ambos tabs (Seguridad + Perfil)', async () => {
    renderMiCuenta();
    expect(screen.getByRole('heading', { name: /mi cuenta/i })).toBeInTheDocument();
    // Seg del primitive es role="tablist" con role="tab" por opción.
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent(/seguridad/i);
    expect(tabs[1]).toHaveTextContent(/perfil/i);
  });

  it('por default muestra el tab Seguridad con card de contraseña', async () => {
    renderMiCuenta();
    // Esperamos a que resuelva el mock de twoFa.status y renderice
    // TwoFaSection en estado "no activado".
    await waitFor(() => {
      expect(screen.getByText(/no activado/i)).toBeInTheDocument();
    });
    // Card "Contraseña" con botón de cambiar
    expect(screen.getByText('Contraseña')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cambiar contraseña/i })).toBeInTheDocument();
  });

  it('click en tab Perfil muestra username, email y badge super-admin', async () => {
    renderMiCuenta();
    const perfilTab = screen.getByRole('tab', { name: /perfil/i });
    fireEvent.click(perfilTab);

    await waitFor(() => {
      expect(screen.getByText('Datos personales')).toBeInTheDocument();
    });
    expect(screen.getByText('lucas.bruno')).toBeInTheDocument();
    expect(screen.getByText('lucas@tecnyapp.com')).toBeInTheDocument();
    // El texto "Super-admin" aparece en 2 lados: en el subtítulo del PageHead
    // ("panel super-admin…" — sub del guard S-25) y en el Badge del rol.
    // Chequeamos el badge específicamente porque es lo que valida el flow.
    const badges = screen.getAllByText(/super-admin/i);
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.some((el) => el.classList.contains('badge'))).toBe(true);
  });

  it('honra el query param ?tab=perfil al mount', async () => {
    renderMiCuenta('/mi-cuenta?tab=perfil');
    await waitFor(() => {
      expect(screen.getByText('Datos personales')).toBeInTheDocument();
    });
  });
});
