// Test del panel del operador para el share link público (2026-07-11).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  inventario: {
    shareLink: {
      get:    vi.fn(),
      update: vi.fn(),
      rotate: vi.fn(),
    },
  },
}));

// task #229 (2026-08-02): mock del AuthContext para poder controlar las caps
// del user en cada test. Default: owner del tenant (bypass total) — replica
// el comportamiento pre-#229 donde todos los tests asumían acceso completo.
let _mockUser = null;
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: _mockUser }),
}));

const USER_OWNER = { id: 1, role: 'op', tenant_cap_rol: 'owner', caps: [] };
const USER_EDITOR_SIN_DESTRUCTIVAS = {
  id: 2,
  role: 'op',
  tenant_cap_rol: 'custom',
  caps: ['inventario.editar'],
  // Sin `inventario.share_link_desactivar` ni `inventario.share_link_rotate`.
};

import { inventario as inventarioApi } from '../lib/api';
import ShareLinkPanel from './ShareLinkPanel';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';

function renderPanel({ user = USER_OWNER } = {}) {
  _mockUser = user;
  return render(
    <ConfirmProvider>
      <ToastProvider>
        <ShareLinkPanel />
      </ToastProvider>
    </ConfirmProvider>
  );
}

const linkOK = {
  id: 1, token: 'testTk123456789ABC',
  activo: true,
  whatsapp: '+54 9 11 1234-5678',
  mensaje_extra: 'Consultá por financiación',
  mostrar_bateria: true,
  mostrar_precio: true,
  stats: { vistas_ult_mes: 42, unicos_hoy: 5, ultimo_acceso: new Date().toISOString() },
};

describe('ShareLinkPanel — panel del operador del share link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock stable clipboard.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true, configurable: true,
    });
  });

  it('carga config al montar y muestra header con badge "Activo"', async () => {
    inventarioApi.shareLink.get.mockResolvedValue(linkOK);
    renderPanel();
    await waitFor(() => expect(inventarioApi.shareLink.get).toHaveBeenCalled());
    expect(await screen.findByText(/Link público de equipos usados/i)).toBeInTheDocument();
    expect(screen.getByText('Activo')).toBeInTheDocument();
  });

  it('expandir muestra URL + Copiar + Compartir + form + stats', async () => {
    inventarioApi.shareLink.get.mockResolvedValue(linkOK);
    renderPanel();
    // Click en el header para expandir.
    fireEvent.click(await screen.findByRole('button', { name: /Link público de equipos usados/i }));
    // URL box
    const urlInput = await screen.findByDisplayValue(/publico\/usados\/testTk123456789ABC/);
    expect(urlInput).toBeInTheDocument();
    // Botones
    expect(screen.getByRole('button', { name: /Copiar/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Compartir/ })).toBeInTheDocument();
    // Form
    expect(screen.getByDisplayValue('+54 9 11 1234-5678')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Consultá por financiación')).toBeInTheDocument();
    // Stats
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText(/Vistas último mes/)).toBeInTheDocument();
  });

  it('click Copiar → writeText llamado con la URL', async () => {
    inventarioApi.shareLink.get.mockResolvedValue(linkOK);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Link público de equipos usados/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Copiar/ }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const arg = navigator.clipboard.writeText.mock.calls[0][0];
    expect(arg).toContain('/publico/usados/testTk123456789ABC');
  });

  it('Guardar cambios llama a update con los valores actuales del form', async () => {
    inventarioApi.shareLink.get.mockResolvedValue(linkOK);
    inventarioApi.shareLink.update.mockResolvedValue({ ...linkOK, whatsapp: '+54 9 11 9999-0000' });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Link público de equipos usados/i }));

    const waInput = await screen.findByDisplayValue('+54 9 11 1234-5678');
    fireEvent.change(waInput, { target: { value: '+54 9 11 9999-0000' } });

    fireEvent.click(screen.getByRole('button', { name: /Guardar cambios/ }));
    await waitFor(() => expect(inventarioApi.shareLink.update).toHaveBeenCalled());
    const payload = inventarioApi.shareLink.update.mock.calls[0][0];
    expect(payload).toMatchObject({
      whatsapp: '+54 9 11 9999-0000',
      mensaje_extra: 'Consultá por financiación',
      mostrar_bateria: true,
      mostrar_precio: true,
    });
  });

  it('link desactivado muestra badge "Desactivado" y botón "Reactivar"', async () => {
    inventarioApi.shareLink.get.mockResolvedValue({ ...linkOK, activo: false });
    renderPanel();
    await waitFor(() => expect(inventarioApi.shareLink.get).toHaveBeenCalled());
    expect(await screen.findByText('Desactivado')).toBeInTheDocument();
    // Expandir → botón "Reactivar link"
    fireEvent.click(screen.getByRole('button', { name: /Link público de equipos usados/i }));
    expect(await screen.findByRole('button', { name: /Reactivar link/i })).toBeInTheDocument();
  });

  // task #229 (2026-08-02): defense-in-depth UX del split de caps
  // destructivas. El backend enforcea igual — estos tests validan que el
  // frontend ADEMÁS deshabilita los botones para dar señal visual antes
  // del 403.
  describe('gates de caps destructivas (task #229)', () => {
    it('user sin share_link_desactivar → botón "Desactivar link" disabled + tooltip explicativo', async () => {
      inventarioApi.shareLink.get.mockResolvedValue(linkOK);
      renderPanel({ user: USER_EDITOR_SIN_DESTRUCTIVAS });
      fireEvent.click(await screen.findByRole('button', { name: /Link público de equipos usados/i }));

      const btn = await screen.findByRole('button', { name: /Desactivar link/i });
      expect(btn).toBeDisabled();
      expect(btn.getAttribute('title')).toMatch(/Necesitás la capability.*Desactivar/i);
    });

    it('user sin share_link_rotate → botón "Rotar token" disabled + tooltip explicativo', async () => {
      inventarioApi.shareLink.get.mockResolvedValue(linkOK);
      renderPanel({ user: USER_EDITOR_SIN_DESTRUCTIVAS });
      fireEvent.click(await screen.findByRole('button', { name: /Link público de equipos usados/i }));

      const btn = await screen.findByRole('button', { name: /Rotar token/i });
      expect(btn).toBeDisabled();
      expect(btn.getAttribute('title')).toMatch(/Necesitás la capability.*Rotar/i);
    });

    it('user sin desactivar pero link ya está desactivado → botón "Reactivar" NO disabled (reactivar es reversible)', async () => {
      inventarioApi.shareLink.get.mockResolvedValue({ ...linkOK, activo: false });
      renderPanel({ user: USER_EDITOR_SIN_DESTRUCTIVAS });
      fireEvent.click(await screen.findByRole('button', { name: /Link público de equipos usados/i }));

      const btn = await screen.findByRole('button', { name: /Reactivar link/i });
      expect(btn).not.toBeDisabled();
    });

    it('owner del tenant (bypass) → ambos botones habilitados aunque no tenga caps en `caps[]`', async () => {
      inventarioApi.shareLink.get.mockResolvedValue(linkOK);
      renderPanel({ user: USER_OWNER });
      fireEvent.click(await screen.findByRole('button', { name: /Link público de equipos usados/i }));

      expect(await screen.findByRole('button', { name: /Desactivar link/i })).not.toBeDisabled();
      expect(await screen.findByRole('button', { name: /Rotar token/i })).not.toBeDisabled();
    });
  });
});
