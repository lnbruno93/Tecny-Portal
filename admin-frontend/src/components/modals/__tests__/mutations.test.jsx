// Tests para los 4 modals de mutations (Sub-fase B.3 #353).
//
// Un archivo único para los 4 — son chicos y comparten setup (mock adminApi).
// Cubrimos solo el contrato crítico de cada uno:
//   · EditTenantModal: diff body + skip cuando nada cambió
//   · SuspendTenantModal: validación min chars + reason en body
//   · ReactivateTenantModal: reason vacío → undefined; con texto → pasa
//   · ExtendTrialModal: preview de fecha + submit con days numérico

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../lib/api.js', () => ({
  adminApi: {
    patchTenant: vi.fn(),
    suspendTenant: vi.fn(),
    reactivateTenant: vi.fn(),
    extendTrial: vi.fn(),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

import { adminApi } from '../../../lib/api.js';
import EditTenantModal from '../EditTenantModal.jsx';
import SuspendTenantModal from '../SuspendTenantModal.jsx';
import ReactivateTenantModal from '../ReactivateTenantModal.jsx';
import ExtendTrialModal from '../ExtendTrialModal.jsx';

function makeTenant(overrides = {}) {
  return {
    id: 12,
    nombre: 'Aurora Mobile',
    slug: 'aurora-mobile',
    plan: 'pro',
    custom_mrr_usd: null,
    suspended_at: null,
    suspended_reason: null,
    trial_until: null,
    created_at: '2026-05-10T00:00:00Z',
    notes: 'Cliente VIP',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── EditTenantModal ────────────────────────────────────────────────
describe('EditTenantModal', () => {
  it('cambio de plan + submit llama patchTenant con { plan, reason }', async () => {
    adminApi.patchTenant.mockResolvedValue({ ok: true });
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <EditTenantModal
        tenant={makeTenant()}
        open
        onClose={onClose}
        onSaved={onSaved}
      />
    );

    // Cambiar select de plan: pro → starter
    const planSelect = screen.getByDisplayValue('Pro');
    fireEvent.change(planSelect, { target: { value: 'starter' } });

    // Agregar reason
    fireEvent.change(screen.getByPlaceholderText(/upgrade pactado/i), {
      target: { value: 'downgrade pactado' },
    });

    fireEvent.click(screen.getByRole('button', { name: /guardar cambios/i }));

    await waitFor(() => {
      expect(adminApi.patchTenant).toHaveBeenCalledTimes(1);
    });
    expect(adminApi.patchTenant).toHaveBeenCalledWith(12, {
      plan: 'starter',
      reason: 'downgrade pactado',
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('si nada cambió y se hace submit, NO llama patchTenant — solo cierra', async () => {
    adminApi.patchTenant.mockResolvedValue({ ok: true });
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(
      <EditTenantModal
        tenant={makeTenant()}
        open
        onClose={onClose}
        onSaved={onSaved}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /guardar cambios/i }));

    // Esperamos un tick para que cualquier promise resolved
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(adminApi.patchTenant).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

// ── SuspendTenantModal ─────────────────────────────────────────────
describe('SuspendTenantModal', () => {
  it('botón "Suspender cuenta" disabled hasta que reason tenga >= 5 chars', () => {
    render(
      <SuspendTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    const btn = screen.getByRole('button', { name: /^suspender cuenta$/i });
    expect(btn).toBeDisabled();

    const textarea = screen.getByPlaceholderText(/pago vencido/i);

    fireEvent.change(textarea, { target: { value: '1234' } });
    expect(btn).toBeDisabled();

    fireEvent.change(textarea, { target: { value: '12345' } });
    expect(btn).not.toBeDisabled();
  });

  it('submit con reason válida llama suspendTenant', async () => {
    adminApi.suspendTenant.mockResolvedValue({ ok: true });
    const onSaved = vi.fn();

    render(
      <SuspendTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onSaved={onSaved}
      />
    );

    fireEvent.change(screen.getByPlaceholderText(/pago vencido/i), {
      target: { value: 'pago vencido — cliente no respondió' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^suspender cuenta$/i }));

    await waitFor(() => {
      expect(adminApi.suspendTenant).toHaveBeenCalledWith(12, {
        reason: 'pago vencido — cliente no respondió',
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });
});

// ── ReactivateTenantModal ──────────────────────────────────────────
describe('ReactivateTenantModal', () => {
  it('reason vacío → llama reactivateTenant con { reason: undefined }', async () => {
    adminApi.reactivateTenant.mockResolvedValue({ ok: true });
    const onSaved = vi.fn();

    render(
      <ReactivateTenantModal
        tenant={makeTenant({
          suspended_at: '2026-06-01T00:00:00Z',
          suspended_reason: 'falta de pago',
        })}
        open
        onClose={() => {}}
        onSaved={onSaved}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^reactivar cuenta$/i }));

    await waitFor(() => {
      expect(adminApi.reactivateTenant).toHaveBeenCalledWith(12, {
        reason: undefined,
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('reason con texto → lo pasa trimmed', async () => {
    adminApi.reactivateTenant.mockResolvedValue({ ok: true });

    render(
      <ReactivateTenantModal
        tenant={makeTenant({
          suspended_at: '2026-06-01T00:00:00Z',
          suspended_reason: 'falta de pago',
        })}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    fireEvent.change(screen.getByPlaceholderText(/regularizó el pago/i), {
      target: { value: '  cliente pagó  ' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^reactivar cuenta$/i }));

    await waitFor(() => {
      expect(adminApi.reactivateTenant).toHaveBeenCalledWith(12, {
        reason: 'cliente pagó',
      });
    });
  });
});

// ── ExtendTrialModal ───────────────────────────────────────────────
describe('ExtendTrialModal', () => {
  it('muestra preview de "Nuevo trial hasta X"', () => {
    render(
      <ExtendTrialModal
        tenant={makeTenant({
          plan: 'trial',
          trial_until: '2026-07-01',
        })}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    // El preview se computa desde trial_until + 7 días (default).
    // No checkeamos la fecha exacta (depende del locale) — solo que aparezca.
    expect(screen.getByText(/nuevo trial hasta:/i)).toBeInTheDocument();
  });

  it('submit con days=10 llama extendTrial con { days: 10, reason: undefined }', async () => {
    adminApi.extendTrial.mockResolvedValue({ ok: true });
    const onSaved = vi.fn();

    render(
      <ExtendTrialModal
        tenant={makeTenant({
          plan: 'trial',
          trial_until: '2026-07-01',
        })}
        open
        onClose={() => {}}
        onSaved={onSaved}
      />
    );

    // Con htmlFor en el label, getByLabelText resuelve el input number.
    const daysInput = screen.getByLabelText(/días a extender/i);
    fireEvent.change(daysInput, { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: /extender 10 días/i }));

    await waitFor(() => {
      expect(adminApi.extendTrial).toHaveBeenCalledWith(12, {
        days: 10,
        reason: undefined,
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });
});
