// Tests para los 4 modals de mutations (#353).
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
    setPaidUntil: vi.fn(),
    deleteTenant: vi.fn(),
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
import SetPaidUntilModal from '../SetPaidUntilModal.jsx';
import DeleteTenantModal from '../DeleteTenantModal.jsx';

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

// ── SetPaidUntilModal (TANDA 4.B) ────────────────────────────────────────
describe('SetPaidUntilModal', () => {
  it('submit con fecha + reason llama setPaidUntil con paid_until + reason', async () => {
    adminApi.setPaidUntil.mockResolvedValue({ paid_until: '2026-07-25' });
    const onSaved = vi.fn();

    render(
      <SetPaidUntilModal
        tenant={makeTenant({ paid_until: null })}
        open
        onClose={() => {}}
        onSaved={onSaved}
      />
    );

    // Cambiar fecha default (+30d) por una explícita
    const dateInput = screen.getByLabelText(/nueva fecha de vencimiento/i);
    fireEvent.change(dateInput, { target: { value: '2026-12-31' } });

    // Reason obligatorio
    fireEvent.change(screen.getByLabelText(/motivo \/ referencia/i), {
      target: { value: 'transferencia $189 USD recibida' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^marcar pago$/i }));

    await waitFor(() => {
      expect(adminApi.setPaidUntil).toHaveBeenCalledWith(12, {
        paid_until: '2026-12-31',
        reason: 'transferencia $189 USD recibida',
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('botón "Marcar pago" deshabilitado sin reason', async () => {
    render(
      <SetPaidUntilModal
        tenant={makeTenant({ paid_until: null })}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />
    );

    const submitBtn = screen.getByRole('button', { name: /^marcar pago$/i });
    expect(submitBtn).toBeDisabled();
  });

  it('grandfather button llama setPaidUntil con paid_until=null tras confirm', async () => {
    // jsdom no implementa window.confirm; mockeamos a true.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    adminApi.setPaidUntil.mockResolvedValue({ paid_until: null });
    const onSaved = vi.fn();

    render(
      <SetPaidUntilModal
        tenant={makeTenant({ paid_until: '2026-08-01' })}
        open
        onClose={() => {}}
        onSaved={onSaved}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /grandfather/i }));

    await waitFor(() => {
      expect(adminApi.setPaidUntil).toHaveBeenCalledWith(12, { paid_until: null });
    });
    expect(onSaved).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

// ── DeleteTenantModal (feature #438) ────────────────────────────────────
describe('DeleteTenantModal', () => {
  it('botón "Eliminar" deshabilitado mientras el slug no coincida', () => {
    render(
      <DeleteTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onDeleted={() => {}}
      />
    );

    const btn = screen.getByRole('button', { name: /eliminar cuenta definitivamente/i });
    expect(btn).toBeDisabled();

    const slugInput = screen.getByLabelText(/escribí el slug/i);

    // Slug parcial — sigue disabled.
    fireEvent.change(slugInput, { target: { value: 'aurora' } });
    expect(btn).toBeDisabled();

    // Slug case-incorrecto — sigue disabled (match exacto).
    fireEvent.change(slugInput, { target: { value: 'AURORA-MOBILE' } });
    expect(btn).toBeDisabled();

    // Slug exacto — habilita.
    fireEvent.change(slugInput, { target: { value: 'aurora-mobile' } });
    expect(btn).not.toBeDisabled();
  });

  it('submit con slug match llama deleteTenant(id, slug, { reason }) y dispara onDeleted', async () => {
    adminApi.deleteTenant.mockResolvedValue({ ok: true });
    const onDeleted = vi.fn();

    render(
      <DeleteTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onDeleted={onDeleted}
      />
    );

    fireEvent.change(screen.getByLabelText(/escribí el slug/i), {
      target: { value: 'aurora-mobile' },
    });
    fireEvent.change(screen.getByLabelText(/motivo/i), {
      target: { value: 'cuenta de prueba thinklab' },
    });

    fireEvent.click(screen.getByRole('button', { name: /eliminar cuenta definitivamente/i }));

    await waitFor(() => {
      expect(adminApi.deleteTenant).toHaveBeenCalledWith(12, 'aurora-mobile', {
        reason: 'cuenta de prueba thinklab',
      });
    });
    expect(onDeleted).toHaveBeenCalledWith({ alreadyDeleted: false });
  });

  it('reason vacío → body sin reason (objeto vacío)', async () => {
    adminApi.deleteTenant.mockResolvedValue({ ok: true });
    const onDeleted = vi.fn();

    render(
      <DeleteTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onDeleted={onDeleted}
      />
    );

    fireEvent.change(screen.getByLabelText(/escribí el slug/i), {
      target: { value: 'aurora-mobile' },
    });

    fireEvent.click(screen.getByRole('button', { name: /eliminar cuenta definitivamente/i }));

    await waitFor(() => {
      expect(adminApi.deleteTenant).toHaveBeenCalledWith(12, 'aurora-mobile', {});
    });
  });

  it('alreadyDeleted=true del backend se propaga a onDeleted', async () => {
    adminApi.deleteTenant.mockResolvedValue({ ok: true, alreadyDeleted: true });
    const onDeleted = vi.fn();

    render(
      <DeleteTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onDeleted={onDeleted}
      />
    );

    fireEvent.change(screen.getByLabelText(/escribí el slug/i), {
      target: { value: 'aurora-mobile' },
    });
    fireEvent.click(screen.getByRole('button', { name: /eliminar cuenta definitivamente/i }));

    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledWith({ alreadyDeleted: true });
    });
  });

  it('error del backend muestra mensaje en el modal y NO dispara onDeleted', async () => {
    const err = new Error('confirm slug no coincide');
    adminApi.deleteTenant.mockRejectedValue(err);
    const onDeleted = vi.fn();

    render(
      <DeleteTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onDeleted={onDeleted}
      />
    );

    fireEvent.change(screen.getByLabelText(/escribí el slug/i), {
      target: { value: 'aurora-mobile' },
    });
    fireEvent.click(screen.getByRole('button', { name: /eliminar cuenta definitivamente/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/confirm slug no coincide/i);
    });
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
