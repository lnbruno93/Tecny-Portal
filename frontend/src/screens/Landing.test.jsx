/**
 * Smoke test del Landing — pricing dinámico (Sub-fase C.1.4 #353).
 *
 * Cubre los flows del fetch a /api/public/pricing:
 *   1. Render inicial muestra los FALLBACK_PRICES (39 / 189) sin esperar fetch
 *      — el primer paint NUNCA debe quedar vacío o con NaN.
 *   2. Si el fetch resuelve con valores nuevos, el componente los reemplaza.
 *   3. Si el fetch falla (4xx, 5xx, network), se mantienen los fallbacks
 *      silenciosamente (sin banner de error al user).
 *   4. Si el fetch devuelve JSON con campos inválidos (null, string, neg),
 *      se mantienen los fallbacks por validación defensiva.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Landing from './Landing.jsx';

function renderLanding() {
  return render(
    <BrowserRouter>
      <Landing />
    </BrowserRouter>
  );
}

// Helper: localizamos los <span class="num"> que contienen el valor del precio.
// La landing tiene 3 plans pero solo Solo (starter) y Equipo (pro) tienen
// número editable. El tercero ("Multi-local") es "A medida" — no es número.
function getNumericPriceSpans() {
  return Array.from(document.querySelectorAll('.plan .price .num'))
    .map((el) => el.textContent);
}

beforeEach(() => {
  // Fresh fetch stub por test.
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Landing pricing dinámico', () => {
  it('render inicial muestra fallback prices (39 / 189) antes de que resuelva fetch', () => {
    // Fetch que nunca resuelve — simula latency infinita. El render inicial
    // debería tener los defaults visibles.
    globalThis.fetch.mockImplementation(() => new Promise(() => {}));

    renderLanding();

    const prices = getNumericPriceSpans();
    expect(prices).toEqual(expect.arrayContaining(['39', '189']));
  });

  it('reemplaza con valores del backend cuando el fetch resuelve OK', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        prices: { trial: 0, starter: 49, pro: 199, enterprise: null },
        currency: 'USD',
        period: 'monthly',
      }),
    });

    renderLanding();

    await waitFor(() => {
      const prices = getNumericPriceSpans();
      expect(prices).toEqual(expect.arrayContaining(['49', '199']));
    });
  });

  it('fetch falla (network error) → mantiene fallback sin banner de error', async () => {
    globalThis.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

    renderLanding();

    // Esperar a que el .catch se procese (microtask).
    await new Promise((r) => setTimeout(r, 50));

    const prices = getNumericPriceSpans();
    expect(prices).toEqual(expect.arrayContaining(['39', '189']));

    // No debe mostrar banner de error al user — la landing siempre se ve bien.
    // Buscamos roles ARIA de alert/status, no texto suelto (la palabra "error"
    // aparece en el FAQ legítimamente).
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/sin conexión/i)).toBeNull();
  });

  it('fetch responde 500 → mantiene fallback', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });

    renderLanding();
    await new Promise((r) => setTimeout(r, 50));

    const prices = getNumericPriceSpans();
    expect(prices).toEqual(expect.arrayContaining(['39', '189']));
  });

  it('fetch devuelve precios inválidos (negativos / strings) → mantiene fallback', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        prices: { starter: -10, pro: 'cien', enterprise: null },
      }),
    });

    renderLanding();
    await new Promise((r) => setTimeout(r, 50));

    const prices = getNumericPriceSpans();
    expect(prices).toEqual(expect.arrayContaining(['39', '189']));
  });

  it('fetch responde shape parcial (solo starter) → reemplaza starter y mantiene pro fallback', async () => {
    globalThis.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        prices: { starter: 59 }, // pro ausente → debe quedar en fallback 189
      }),
    });

    renderLanding();

    await waitFor(() => {
      const prices = getNumericPriceSpans();
      expect(prices).toContain('59');
    });
    const prices = getNumericPriceSpans();
    expect(prices).toContain('189'); // fallback de pro
  });
});
