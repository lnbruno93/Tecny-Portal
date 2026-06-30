// Smoke tests para ChangePaisTenantModal (#473).
//
// Acotado al contrato crítico: el botón confirm queda deshabilitado hasta que
// el operador tipea el nombre exacto del tenant, y al confirmar dispara
// adminApi.changePaisTenant con el id + país elegido. Coincide en estilo con
// los otros modal tests (mutations.test.jsx).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../lib/api.js', () => ({
  adminApi: {
    changePaisTenant: vi.fn(),
  },
  getToken: vi.fn(() => null),
  saveToken: vi.fn(),
  clearToken: vi.fn(),
  resolveApiBase: (u) => u || 'http://localhost',
}));

import { adminApi } from '../../../lib/api.js';
import ChangePaisTenantModal from '../ChangePaisTenantModal.jsx';

function makeTenant(overrides = {}) {
  return {
    id: 42,
    nombre: 'Aurora Mobile',
    slug: 'aurora-mobile',
    pais: 'AR',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChangePaisTenantModal', () => {
  it('renderiza con país actual visible y radio del actual disabled', () => {
    render(
      <ChangePaisTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    // Hay 2 radios: AR (actual, disabled) y UY (destino, checked default).
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBe(2);
    // El radio del país actual debe estar disabled.
    const arRadio = radios.find((r) => r.value === 'AR');
    expect(arRadio.disabled).toBe(true);
    const uyRadio = radios.find((r) => r.value === 'UY');
    expect(uyRadio.disabled).toBe(false);
    expect(uyRadio.checked).toBe(true);
  });

  it('botón confirm deshabilitado hasta tipear el nombre exacto del tenant', async () => {
    render(
      <ChangePaisTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    const submitBtn = screen.getByRole('button', { name: /cambiar a uruguay/i });
    expect(submitBtn.disabled).toBe(true);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'no es el nombre' } });
    expect(submitBtn.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'Aurora Mobile' } });
    expect(submitBtn.disabled).toBe(false);
  });

  it('submit llama changePaisTenant(id, paisElegido) y dispara onSaved', async () => {
    adminApi.changePaisTenant.mockResolvedValue({
      tenant_id: 42, pais_anterior: 'AR', pais_nuevo: 'UY',
      side_effects: { cajas_creadas: 3, alerta_actualizada: true },
    });
    const onSaved = vi.fn();
    render(
      <ChangePaisTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onSaved={onSaved}
      />
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Aurora Mobile' },
    });
    fireEvent.click(screen.getByRole('button', { name: /cambiar a uruguay/i }));
    await waitFor(() => {
      expect(adminApi.changePaisTenant).toHaveBeenCalledWith(42, 'UY');
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it('error has_active_partnerships muestra mensaje accionable', async () => {
    const err = new Error('partnerships');
    err.body = { code: 'has_active_partnerships' };
    adminApi.changePaisTenant.mockRejectedValue(err);
    render(
      <ChangePaisTenantModal
        tenant={makeTenant()}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Aurora Mobile' },
    });
    fireEvent.click(screen.getByRole('button', { name: /cambiar a uruguay/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/partnerships Red B2B activas/);
    });
  });

  it('tenant UY → default destino es AR', () => {
    render(
      <ChangePaisTenantModal
        tenant={makeTenant({ pais: 'UY' })}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    const arRadio = screen.getAllByRole('radio').find((r) => r.value === 'AR');
    expect(arRadio.checked).toBe(true);
    expect(arRadio.disabled).toBe(false);
  });
});
