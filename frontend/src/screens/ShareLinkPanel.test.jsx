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

import { inventario as inventarioApi } from '../lib/api';
import ShareLinkPanel from './ShareLinkPanel';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';

function renderPanel() {
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
});
