import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Multi-país F5: tests del modo UY del Cotizador. Verificamos que el tab
// "USD → ARS" se renombra a "USD → UYU", que los labels del input TC y
// los resultados usan "UYU"/"$U" en vez de "ARS"/"$", y que el modo AR
// (default) sigue funcionando idéntico.
//
// Pattern de mock: replicamos Inventario.test.jsx — useAuth mockeable via
// `mockUser.value` para inyectar tenant.pais. tenantProfile/configApi
// devuelven datos mínimos para que TabTarjetas/TabUsd no rompan en el mount.

const mockUser = { value: null };
vi.mock('../contexts/AuthContext', async (orig) => {
  const actual = await orig();
  return { ...actual, useAuth: () => ({ user: mockUser.value, loading: false }) };
});

vi.mock('../lib/api', () => ({
  tenantProfile: {
    get: vi.fn().mockResolvedValue({
      google_business_enabled: false,
      google_business_name: '',
      google_reviews_count: 0,
    }),
  },
  config: {
    lastTc: vi.fn().mockResolvedValue({ tc: 1400, source: 'fallback', pais: 'AR' }),
  },
  // BusinessProfileSection importa tenantProfile.get (ya mockeado arriba) — el
  // tab Configuración no es el foco de estos tests pero el módulo debe importar
  // bien.
}));

import Cotizador from './Cotizador';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { config as configApi } from '../lib/api';

function renderCotizador() {
  return render(
    <ToastProvider><ConfirmProvider>
      <Cotizador />
    </ConfirmProvider></ToastProvider>
  );
}

describe('Pantalla Cotizador — modo país-aware (F5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.value = null;
    // Reset default lastTc mock para que cada test pueda overridearlo.
    configApi.lastTc.mockResolvedValue({ tc: 1400, source: 'fallback', pais: 'AR' });
  });

  // ─── Tenant AR (default) ──────────────────────────────────────────────────

  it('tenant AR: tab dice "USD → ARS" y el label del TC dice "USD → ARS"', async () => {
    mockUser.value = { id: 1, caps: [], tenant: { pais: 'AR' } };
    renderCotizador();
    // Tab visible en el header de Cotizador.
    expect(await screen.findByRole('button', { name: /USD → ARS/i })).toBeInTheDocument();
    // El tab default es "tarjetas" — el field-label aparece ahí también.
    // Buscamos el label del input TC del tab default.
    await waitFor(() => {
      // El texto "Tipo de cambio (USD → ARS)" debe aparecer al menos una vez.
      expect(screen.getAllByText(/USD → ARS/i).length).toBeGreaterThan(0);
    });
    // NO debe aparecer "USD → UYU" en ningún lugar para tenant AR.
    expect(screen.queryByText(/USD → UYU/i)).not.toBeInTheDocument();
  });

  // ─── Tenant UY ────────────────────────────────────────────────────────────

  it('tenant UY: tab dice "USD → UYU" y el label del TC dice "USD → UYU"', async () => {
    mockUser.value = { id: 1, caps: [], tenant: { pais: 'UY' } };
    // El backend devuelve fallback país-aware (40 para UY).
    configApi.lastTc.mockResolvedValue({ tc: 40, source: 'fallback', pais: 'UY' });
    renderCotizador();
    // Tab visible con "UYU".
    expect(await screen.findByRole('button', { name: /USD → UYU/i })).toBeInTheDocument();
    // Label del input TC.
    await waitFor(() => {
      expect(screen.getAllByText(/USD → UYU/i).length).toBeGreaterThan(0);
    });
    // NO debe quedar "USD → ARS" colgado en tenant UY (regresión).
    expect(screen.queryByText(/USD → ARS/i)).not.toBeInTheDocument();
  });

  it('tenant UY: tab USD → UYU muestra opción "Transferencia UYU"', async () => {
    mockUser.value = { id: 1, caps: [], tenant: { pais: 'UY' } };
    configApi.lastTc.mockResolvedValue({ tc: 40, source: 'fallback', pais: 'UY' });
    renderCotizador();
    const user = userEvent.setup();
    // Click en el tab USD → UYU.
    await user.click(await screen.findByRole('button', { name: /USD → UYU/i }));
    // La opción de pago "Transferencia UYU" aparece como label de un checkbox.
    await waitFor(() => {
      expect(screen.getByText(/Transferencia UYU/i)).toBeInTheDocument();
    });
    // El equivalente AR ("Transferencia ARS") NO debe aparecer.
    expect(screen.queryByText(/Transferencia ARS/i)).not.toBeInTheDocument();
  });

  it('tenant AR: tab USD → ARS muestra opción "Transferencia ARS" (no degrada modo AR)', async () => {
    mockUser.value = { id: 1, caps: [], tenant: { pais: 'AR' } };
    renderCotizador();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /USD → ARS/i }));
    await waitFor(() => {
      expect(screen.getByText(/Transferencia ARS/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Transferencia UYU/i)).not.toBeInTheDocument();
  });
});
