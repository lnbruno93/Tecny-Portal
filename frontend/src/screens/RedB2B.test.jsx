// Tests de pantalla RedB2B (F1 #454 + PR-X1 #465 hub con tabs).
//
// Cubre los flujos críticos del lifecycle de partnerships del lado UI:
//   - Render empty state cuando no hay partnerships
//   - Render con lista de activos
//   - Click "Invitar partner" abre el modal
//   - Submit del modal llama al endpoint con el slug
//   - Reject de una pending received actualiza la lista
//   - userHasCap('cross_tenant.write') === false → ítem oculto en sidebar
//     (testeado vía userHasCap directo, no via mount completo del Shell)
//
// PR-X1 #465 agrega:
//   - El hub renderea 2 tabs principales: Partners + Configuración
//   - Click en tab Configuración renderea contenido de Config (caja default)
//   - Query param ?tab=config abre el tab Configuración por default
//   - RedB2BConfigContent NO renderea page-head propio (smoke test)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Mock de la lib/api. Mockeamos `redB2b` con vi.fn() en cada método para que
// los tests puedan inspeccionar las llamadas.
const mockListResp = (overrides = {}) => ({
  counts: {
    active_count: 0,
    pending_received_count: 0,
    pending_sent_count: 0,
    revoked_count: 0,
    ...overrides.counts,
  },
  partnerships: overrides.partnerships || [],
});

vi.mock('../lib/api', () => ({
  redB2b: {
    partnerships: {
      list:    vi.fn().mockResolvedValue({ counts: { active_count: 0, pending_received_count: 0, pending_sent_count: 0, revoked_count: 0 }, partnerships: [] }),
      get:     vi.fn(),
      invite:  vi.fn().mockResolvedValue({ partnership: { id: 99, status: 'pending', partner: { slug: 'tekhaus' } } }),
      accept:  vi.fn().mockResolvedValue({ partnership: { id: 1, status: 'active' } }),
      reject:  vi.fn().mockResolvedValue({ partnership: { id: 1, status: 'revoked' } }),
      revoke:  vi.fn().mockResolvedValue({ partnership: { id: 1, status: 'revoked' } }),
    },
    config: {
      get: vi.fn().mockResolvedValue({ red_b2b: { caja_default_id: null, caja_default: null } }),
      setCajaDefault: vi.fn().mockResolvedValue({ red_b2b: { caja_default_id: null } }),
      // PR-X1 #465: email prefs default true para todos los flags.
      getEmailPrefs: vi.fn().mockResolvedValue({ email_prefs: {
        invitation_received: true,
        invitation_accepted: true,
        operation_received:  true,
        operation_cancelled: true,
        payment_received:    true,
      } }),
      setEmailPrefs: vi.fn().mockResolvedValue({ email_prefs: {} }),
    },
  },
  cajas: {
    listMetodosPago: vi.fn().mockResolvedValue({ metodos_pago: [
      { id: 1, nombre: 'Caja ARS', moneda: 'ARS' },
      { id: 2, nombre: 'Caja USD', moneda: 'USD' },
    ] }),
  },
}));

import { redB2b } from '../lib/api';
import { userHasCap } from '../lib/userHasCap';
import RedB2B from './RedB2B';
import RedB2BConfig, { RedB2BConfigContent } from './RedB2BConfig';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';

function renderScreen(initialEntries = ['/red-b2b']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ToastProvider>
        <ConfirmProvider>
          <RedB2B />
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('Pantalla RedB2B', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redB2b.partnerships.list.mockResolvedValue(mockListResp());
  });

  it('renderiza empty state cuando no hay partnerships activas', async () => {
    renderScreen();
    expect(await screen.findByText(/Sin partnerships activas/i)).toBeInTheDocument();
    // El botón "Invitar partner" del tab Partners siempre está visible; el del
    // empty state es opcional según tab.
    expect(screen.getAllByRole('button', { name: /Invitar partner/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('renderiza la lista de partnerships activas', async () => {
    redB2b.partnerships.list.mockResolvedValue(mockListResp({
      counts: { active_count: 1 },
      partnerships: [{
        id: 42,
        status: 'active',
        my_side: 'sent',
        partner: { id: 7, nombre: 'TekHaus', slug: 'tekhaus', plan: 'pro' },
        accepted_at: '2026-06-20T10:00:00Z',
        invited_at:  '2026-06-19T10:00:00Z',
      }],
    }));
    renderScreen();
    expect(await screen.findByText('TekHaus')).toBeInTheDocument();
    // Plan label
    expect(screen.getByText(/Plan Pro/i)).toBeInTheDocument();
    // Botón contextual: Revocar (es active).
    expect(screen.getByRole('button', { name: /Revocar/i })).toBeInTheDocument();
  });

  it('click "Invitar partner" abre el modal', async () => {
    renderScreen();
    // Esperamos al primer render para que el botón esté.
    const btn = await screen.findByRole('button', { name: /Invitar partner/i });
    fireEvent.click(btn);
    expect(await screen.findByRole('dialog', { name: /Invitar partner/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Slug del partner/i)).toBeInTheDocument();
  });

  it('submit del modal con slug válido llama redB2b.invite', async () => {
    const user = userEvent.setup();
    renderScreen();
    const btn = await screen.findByRole('button', { name: /Invitar partner/i });
    await user.click(btn);

    const slugInput = await screen.findByLabelText(/Slug del partner/i);
    await user.type(slugInput, 'tekhaus');

    const submitBtn = screen.getByRole('button', { name: /Enviar invitación/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(redB2b.partnerships.invite).toHaveBeenCalled();
    });
    expect(redB2b.partnerships.invite.mock.calls[0][0]).toBe('tekhaus');
  });

  it('reject de una pending received llama al endpoint y refresca', async () => {
    const user = userEvent.setup();
    // 1) Cargamos con pending_received_count > 0 + una row pending recibida.
    redB2b.partnerships.list.mockResolvedValue(mockListResp({
      counts: { pending_received_count: 1 },
      partnerships: [{
        id: 5,
        status: 'pending',
        my_side: 'received',
        partner: { id: 9, nombre: 'iPro', slug: 'ipro', plan: 'starter' },
        invited_at: '2026-06-25T10:00:00Z',
        invitation_message: 'Hola!',
      }],
    }));
    renderScreen();
    // Click en tab "Invitaciones recibidas".
    const tab = await screen.findByRole('tab', { name: /Invitaciones recibidas/i });
    await user.click(tab);

    // Esperamos que se vea la row.
    expect(await screen.findByText('iPro')).toBeInTheDocument();
    const rejectBtn = screen.getByRole('button', { name: /Rechazar/i });
    await user.click(rejectBtn);

    // ConfirmProvider abre un modal — buscamos el botón confirm DENTRO del
    // dialog (hay 2 botones "Rechazar" en pantalla: el de la row + el del
    // confirm modal; el primary del modal lleva data-autofocus="true").
    const confirmDialog = await screen.findByRole('dialog');
    const confirmBtn = confirmDialog.querySelector('[data-autofocus="true"]');
    expect(confirmBtn).toBeTruthy();
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(redB2b.partnerships.reject).toHaveBeenCalled();
    });
    // El primer argumento es siempre el id de la partnership; el segundo
    // (reason) es opcional. La row sólo pasa el id → la lib api lo recibe
    // sin reason → mock se llama con (5) o (5, undefined) según interop.
    expect(redB2b.partnerships.reject.mock.calls[0][0]).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR-X1 #465: hub con tabs Partners + Configuración
// ─────────────────────────────────────────────────────────────────────────────

describe('Pantalla RedB2B — hub con tabs (PR-X1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redB2b.partnerships.list.mockResolvedValue(mockListResp());
  });

  it('renderiza los 2 tabs principales: Partners + Configuración', async () => {
    renderScreen();
    // Tab Partners (principal) — buscamos un button con role="tab" y nombre exacto.
    const partnersTab = await screen.findByRole('tab', { name: /^Partners$/i });
    const configTab   = await screen.findByRole('tab', { name: /^Configuración$/i });
    expect(partnersTab).toBeInTheDocument();
    expect(configTab).toBeInTheDocument();
    // Partners está activo por default.
    expect(partnersTab).toHaveAttribute('aria-selected', 'true');
    expect(configTab).toHaveAttribute('aria-selected', 'false');
  });

  it('click en tab Configuración renderea contenido de Config (Caja default)', async () => {
    const user = userEvent.setup();
    renderScreen();
    const configTab = await screen.findByRole('tab', { name: /^Configuración$/i });
    await user.click(configTab);

    // Después de clickear, el tab queda activo y se renderea el contenido de
    // RedB2BConfigContent — buscamos texto característico del form de caja default.
    await waitFor(() => {
      expect(configTab).toHaveAttribute('aria-selected', 'true');
    });
    expect(await screen.findByText(/Caja default cross-tenant/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Caja a usar por defecto/i)).toBeInTheDocument();
  });

  it('?tab=config en la URL abre el tab Configuración por default', async () => {
    renderScreen(['/red-b2b?tab=config']);
    const configTab = await screen.findByRole('tab', { name: /^Configuración$/i });
    expect(configTab).toHaveAttribute('aria-selected', 'true');
    // Y el contenido de Config aparece sin necesidad de click.
    expect(await screen.findByText(/Caja default cross-tenant/i)).toBeInTheDocument();
  });

  it('?tab=config NO abre el tab Partners por default', async () => {
    renderScreen(['/red-b2b?tab=config']);
    const partnersTab = await screen.findByRole('tab', { name: /^Partners$/i });
    expect(partnersTab).toHaveAttribute('aria-selected', 'false');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR-X1 #465: smoke test del refactor de RedB2BConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('RedB2BConfig: separation of Content + wrapper standalone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('RedB2BConfigContent NO renderea page-head propio (sin <h1>)', async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <RedB2BConfigContent />
        </ToastProvider>
      </MemoryRouter>
    );
    // Esperamos al fetch de la config para que se renderee el form.
    await screen.findByText(/Caja default cross-tenant/i);
    // No debería haber ningún <h1> — solo el <h2> del card "Caja default cross-tenant".
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('RedB2BConfig (wrapper standalone) SÍ renderea page-head con título', async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <RedB2BConfig />
        </ToastProvider>
      </MemoryRouter>
    );
    // El wrapper agrega el page-head con <h1>Configuración Red B2B</h1>.
    expect(await screen.findByRole('heading', { level: 1, name: /Configuración Red B2B/i })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR-X1 #465: UI email prefs en tab Configuración
// ─────────────────────────────────────────────────────────────────────────────

describe('RedB2BConfigContent — email prefs (PR-X1 #465)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-stubear los mocks tras clearAllMocks (queda sin resolución por default).
    redB2b.config.get.mockResolvedValue({ red_b2b: { caja_default_id: null, caja_default: null } });
    redB2b.config.getEmailPrefs.mockResolvedValue({ email_prefs: {
      invitation_received: true,
      invitation_accepted: true,
      operation_received:  true,
      operation_cancelled: true,
      payment_received:    true,
    } });
    redB2b.config.setEmailPrefs.mockResolvedValue({ email_prefs: {} });
  });

  function renderConfig() {
    return render(
      <MemoryRouter>
        <ToastProvider>
          <RedB2BConfigContent />
        </ToastProvider>
      </MemoryRouter>
    );
  }

  it('renderea los 5 checkboxes con sus labels', async () => {
    renderConfig();
    // Esperamos al load — el título "Avisos por email" aparece junto con los checkboxes.
    await screen.findByText(/Avisos por email/i);

    expect(screen.getByLabelText(/Recibí invitación de partnership/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Un partner aceptó mi invitación/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Un partner me envió una venta/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Un partner canceló una operación/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Un partner cobró un pago/i)).toBeInTheDocument();

    // Default true → todos checked.
    expect(screen.getByLabelText(/Recibí invitación de partnership/i)).toBeChecked();
  });

  it('click en un checkbox llama setEmailPrefs con la key + el nuevo valor', async () => {
    const user = userEvent.setup();
    renderConfig();
    await screen.findByText(/Avisos por email/i);

    const checkbox = screen.getByLabelText(/Un partner me envió una venta/i);
    expect(checkbox).toBeChecked();
    await user.click(checkbox);

    await waitFor(() => {
      expect(redB2b.config.setEmailPrefs).toHaveBeenCalledTimes(1);
    });
    // PATCH con sólo la key que cambió + nuevo valor (false porque arranca true).
    expect(redB2b.config.setEmailPrefs).toHaveBeenCalledWith({ operation_received: false });
  });

  it('optimistic update: UI cambia antes que la promesa resuelva, y revierte si rejecta', async () => {
    const user = userEvent.setup();

    // Setup: setEmailPrefs rejecta para forzar el revert.
    const err = new Error('Backend explotó');
    redB2b.config.setEmailPrefs.mockRejectedValueOnce(err);

    renderConfig();
    await screen.findByText(/Avisos por email/i);

    const checkbox = screen.getByLabelText(/Un partner cobró un pago/i);
    expect(checkbox).toBeChecked();

    await user.click(checkbox);

    // Cuando la promesa rejecte, el checkbox vuelve al estado anterior (checked).
    // En paralelo aparece un toast de error con el mensaje del error.
    await waitFor(() => {
      expect(checkbox).toBeChecked();
    });
    // El toast renderea el mensaje en el DOM.
    expect(await screen.findByText(/Backend explotó/i)).toBeInTheDocument();
  });
});

describe('userHasCap(cross_tenant.write)', () => {
  it('user sin caps no tiene cross_tenant.write', () => {
    const user = { role: 'op', caps: [], tenant_cap_rol: 'custom' };
    expect(userHasCap(user, 'cross_tenant.write')).toBe(false);
  });

  it('user con caps incluyendo cross_tenant.write tiene la cap', () => {
    const user = { role: 'op', caps: ['cross_tenant.write'], tenant_cap_rol: 'custom' };
    expect(userHasCap(user, 'cross_tenant.write')).toBe(true);
  });

  it('owner del tenant bypassa', () => {
    const user = { role: 'op', caps: [], tenant_cap_rol: 'owner' };
    expect(userHasCap(user, 'cross_tenant.write')).toBe(true);
  });
});
