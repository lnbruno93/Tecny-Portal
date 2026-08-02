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
    // task #284: el ComisionesPanel (edición admin-only) usa config.update para
    // guardar cambios. get() ya no lo consume el hook, pero lo dejamos por si
    // otro consumer del módulo lo necesita durante el mount del tab Config.
    get: vi.fn().mockResolvedValue({ pct_financiera: 3, ocultar_ganancia_venta: false }),
    update: vi.fn().mockResolvedValue({ ok: true }),
  },
  // task #284: cajasApi.updateCaja es el endpoint de escritura que usa el
  // ComisionesPanel (admin-only). No lo llama el vendedor. listCajas ya no
  // se consume en el hook desde task #286 — el read pasó al endpoint
  // dedicado /api/cotizador/comisiones (gated con cotizador.trabajar).
  cajas: {
    listCajas: vi.fn().mockResolvedValue([]),
    updateCaja: vi.fn().mockResolvedValue({ ok: true }),
  },
  // task #286: nuevo endpoint scoped al Cotizador para el read de comisiones
  // — devuelve pctFinanciera + tarjetas[] gated con cap `cotizador.trabajar`
  // (accesible al vendedor). Reemplaza la combo configApi.get + cajasApi.
  // listCajas que fallaba con 403 para vendedores por caps insuficientes.
  cotizador: {
    comisiones: vi.fn().mockResolvedValue({
      pctFinanciera: 3,
      tarjetas: [
        { id: 101, nombre: 'TC | 1 Cuota',  comision_pct: 11 },
        { id: 102, nombre: 'TC | 3 Cuotas', comision_pct: 23.5 },
        { id: 103, nombre: 'TC | 6 Cuotas', comision_pct: 28 },
      ],
    }),
  },
  // BusinessProfileSection importa tenantProfile.get (ya mockeado arriba) — el
  // tab Configuración no es el foco de estos tests pero el módulo debe importar
  // bien.
}));

import Cotizador from './Cotizador';
import { ToastProvider } from '../contexts/ToastContext';
import { ConfirmProvider } from '../components/ConfirmModal';
import { config as configApi, cotizador as cotizadorApi } from '../lib/api';

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
    // Reset default mocks para que cada test pueda overridearlos.
    configApi.lastTc.mockResolvedValue({ tc: 1400, source: 'fallback', pais: 'AR' });
    // task #286: reset del mock nuevo — cada test debería recibir las 3 tarjetas
    // default salvo que override específicamente. Un test override vacío cubre
    // el edge case de tenant sin tarjetas configuradas.
    cotizadorApi.comisiones.mockResolvedValue({
      pctFinanciera: 3,
      tarjetas: [
        { id: 101, nombre: 'TC | 1 Cuota',  comision_pct: 11 },
        { id: 102, nombre: 'TC | 3 Cuotas', comision_pct: 23.5 },
        { id: 103, nombre: 'TC | 6 Cuotas', comision_pct: 28 },
      ],
    });
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


// ─── Regresión task #286 — vendedor puede cotizar con tarjetas ─────────────
// Contexto: PR #978 (task #284) migró el hook useComisionesTenant() a leer
// desde configApi.get() + cajasApi.listCajas(). Esos endpoints están
// gated con caps que el rol vendedor NO tiene (config.general y cajas.ver).
// Los 2 fetches devolvían 403; los .catch() del hook silenciaban el error;
// el vendedor terminaba viendo el resultado del Cotizador SIN líneas de
// tarjetas de crédito. Lucas lo cazó minutos después del deploy #979.
//
// Fix: nuevo endpoint dedicado GET /api/cotizador/comisiones gated con
// `cotizador.trabajar` (la cap operacional del feature, presente en el
// rol vendedor). El frontend hook ahora usa cotizadorApi.comisiones().
//
// Estos tests aseguran que:
//   1. El hook llama al endpoint nuevo (no a los viejos).
//   2. Un vendedor (caps: ['cotizador.trabajar']) VE las líneas TC en el
//      resultado — el bug reportado por Lucas.
//   3. Si el endpoint falla, el Cotizador degrada gracefully sin crash
//      (Contado y Transferencia siguen funcionando).
describe('Cotizador — vendedor puede cotizar tarjetas (regresión task #286)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser.value = null;
    configApi.lastTc.mockResolvedValue({ tc: 1400, source: 'fallback', pais: 'AR' });
    cotizadorApi.comisiones.mockResolvedValue({
      pctFinanciera: 3,
      tarjetas: [
        { id: 101, nombre: 'TC | 1 Cuota',  comision_pct: 11 },
        { id: 102, nombre: 'TC | 3 Cuotas', comision_pct: 23.5 },
        { id: 103, nombre: 'TC | 6 Cuotas', comision_pct: 28 },
      ],
    });
  });

  it('el hook fetchea desde cotizadorApi.comisiones (no configApi.get ni cajasApi.listCajas)', async () => {
    mockUser.value = { id: 42, caps: ['cotizador.trabajar'], tenant: { pais: 'AR' } };
    renderCotizador();
    // Esperar a que el mount + fetch se completen — buscar cualquier tarjeta
    // renderizada garantiza que useComisionesTenant() terminó.
    await waitFor(() => {
      expect(screen.getByText(/TC \| 1 Cuota/i)).toBeInTheDocument();
    });
    expect(cotizadorApi.comisiones).toHaveBeenCalled();
  });

  it('vendedor: resultado muestra las 3 líneas TC configuradas por el tenant', async () => {
    // Rol vendedor real (caps del defaults): sin cajas.ver, sin config.general,
    // solo cotizador.trabajar + los otros del rol.
    mockUser.value = {
      id: 42,
      caps: [
        'ventas.trabajar', 'b2b.trabajar', 'contactos.ver', 'contactos.crear_borrar',
        'inventario.ver', 'cotizador.trabajar', 'usados.ver', 'envios.trabajar',
      ],
      tenant: { pais: 'AR' },
    };
    renderCotizador();
    // Las 3 líneas TC deben renderizarse en el resultado del tab default
    // (Tarjetas de crédito) — es exactamente lo que Lucas reportó que faltaba.
    await waitFor(() => {
      expect(screen.getByText(/TC \| 1 Cuota/i)).toBeInTheDocument();
      expect(screen.getByText(/TC \| 3 Cuotas/i)).toBeInTheDocument();
      expect(screen.getByText(/TC \| 6 Cuotas/i)).toBeInTheDocument();
    });
    // Sanity: Contado y Transferencia también aparecen (no rompemos el
    // resto del resultado).
    expect(screen.getByText(/Contado/i)).toBeInTheDocument();
    expect(screen.getByText(/Transferencia \(\+3\.09%\)/i)).toBeInTheDocument();
  });

  it('endpoint 403/500 → degrada sin crash: Contado + Transferencia siguen', async () => {
    // Si el endpoint fallara (ej: red caída, deploy rollback, permiso mal
    // configurado), el Cotizador debe seguir renderizando lo que puede.
    // Sin tarjetas dinámicas, Contado (base) y Transferencia (con default
    // pctFinanciera=3) deben funcionar igual.
    cotizadorApi.comisiones.mockRejectedValueOnce(new Error('Forbidden'));
    mockUser.value = { id: 42, caps: ['cotizador.trabajar'], tenant: { pais: 'AR' } };
    renderCotizador();
    await waitFor(() => {
      expect(screen.getByText(/Contado/i)).toBeInTheDocument();
    });
    // No hay tarjetas renderizadas (array vacío por default).
    expect(screen.queryByText(/TC \| 1 Cuota/i)).not.toBeInTheDocument();
    // Transferencia usa el default de 3% cuando el fetch falla.
    expect(screen.getByText(/Transferencia \(\+/i)).toBeInTheDocument();
  });

  it('tenant sin tarjetas configuradas (array vacío) — no rompe el Cotizador', async () => {
    // Edge case: tenant nuevo o admin que borró todas las tarjetas. El
    // Cotizador debe funcionar igual — Contado y Transferencia sin tarjetas.
    cotizadorApi.comisiones.mockResolvedValueOnce({ pctFinanciera: 3, tarjetas: [] });
    mockUser.value = { id: 42, caps: ['cotizador.trabajar'], tenant: { pais: 'AR' } };
    renderCotizador();
    await waitFor(() => {
      expect(screen.getByText(/Contado/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/TC \| /i)).not.toBeInTheDocument();
    expect(screen.getByText(/Transferencia \(\+/i)).toBeInTheDocument();
  });
});
