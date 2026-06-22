/**
 * Tests unitarios para lib/planPricing (Sub-fase C.1 #353).
 *
 * Cubre:
 *   · DEFAULT_PRICES como fallback en cold-start
 *   · primeCache() puebla el cache desde DB
 *   · refreshCache() re-lee de DB
 *   · loadFromDb falla silenciosamente sin crashear el cache
 *   · getTenantMrr usa cache para planes estándar, custom_mrr para enterprise
 *   · PLAN_PRICES_USD (compat retroactivo) es un getter dinámico
 *
 * No requiere DB real — mockeamos `db.query` con jest.mock. Los tests
 * de integration (superAdmin.test.js) cubren el camino con DB real.
 *
 * Pattern de cada describe que usa cache:
 *   beforeEach hace `jest.resetModules()` + re-require de los dos módulos
 *   para evitar leakage entre tests (cada test arranca con cache fresh).
 */

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
}));

describe('planPricing — cold start (cache antes de primeCache)', () => {
  let planPricing;

  beforeEach(() => {
    jest.resetModules();
    planPricing = require('../src/lib/planPricing');
  });

  it('getPlanPrices devuelve DEFAULT_PRICES si nunca se primó el cache', () => {
    expect(planPricing.getPlanPrices()).toEqual({
      trial: 0,
      starter: 39,
      pro: 189,
      enterprise: null,
    });
  });

  it('PLAN_PRICES_USD legacy es un getter dinámico (no cached at require)', () => {
    expect(planPricing.PLAN_PRICES_USD).toEqual({
      trial: 0,
      starter: 39,
      pro: 189,
      enterprise: null,
    });
  });

  it('DEFAULT_PRICES es Object.freeze (inmutable)', () => {
    expect(Object.isFrozen(planPricing.DEFAULT_PRICES)).toBe(true);
  });
});

describe('planPricing — primeCache + refreshCache', () => {
  let db;
  let planPricing;

  beforeEach(() => {
    jest.resetModules();
    db = require('../src/config/database');
    db.query.mockReset();
    planPricing = require('../src/lib/planPricing');
  });

  it('primeCache carga precios desde DB y los pone en cache', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { plan: 'trial',      price_usd: '0.00' },
        { plan: 'starter',    price_usd: '49.00' },   // distinto al default
        { plan: 'pro',        price_usd: '199.00' },
        { plan: 'enterprise', price_usd: null },
      ],
    });
    await planPricing.primeCache();
    expect(planPricing.getPlanPrices()).toEqual({
      trial: 0,
      starter: 49,    // del DB, no del default
      pro: 199,
      enterprise: null,
    });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT plan, price_usd FROM plan_prices')
    );
  });

  it('refreshCache actualiza el cache con valor nuevo de DB', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ plan: 'starter', price_usd: '39.00' }],
    });
    await planPricing.primeCache();
    expect(planPricing.getPlanPrices().starter).toBe(39);

    db.query.mockResolvedValueOnce({
      rows: [{ plan: 'starter', price_usd: '59.00' }],
    });
    await planPricing.refreshCache();
    expect(planPricing.getPlanPrices().starter).toBe(59);
  });

  it('loadFromDb error → cache previo se mantiene (no crash, no NaN)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ plan: 'starter', price_usd: '39.00' }],
    });
    await planPricing.primeCache();
    const before = { ...planPricing.getPlanPrices() };

    db.query.mockRejectedValueOnce(new Error('connection timeout'));
    await planPricing.refreshCache();   // NO throws
    expect(planPricing.getPlanPrices()).toEqual(before);
  });

  it('loadFromDb con filas vacías → mantiene cache previo (no se borra)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ plan: 'starter', price_usd: '39.00' }],
    });
    await planPricing.primeCache();

    db.query.mockResolvedValueOnce({ rows: [] });
    await planPricing.refreshCache();
    expect(planPricing.getPlanPrices().starter).toBe(39); // mantiene anterior
  });
});

describe('planPricing — getTenantMrr', () => {
  let db;
  let planPricing;

  beforeEach(() => {
    jest.resetModules();
    db = require('../src/config/database');
    db.query.mockReset();
    planPricing = require('../src/lib/planPricing');
  });

  it('plan estándar (starter) usa el cache', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ plan: 'starter', price_usd: '39.00' }],
    });
    await planPricing.primeCache();
    expect(planPricing.getTenantMrr('starter', null)).toBe(39);
  });

  it('plan trial siempre 0', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ plan: 'trial', price_usd: '0' }],
    });
    await planPricing.primeCache();
    expect(planPricing.getTenantMrr('trial', null)).toBe(0);
  });

  it('plan enterprise usa custom_mrr_usd (no cache)', () => {
    expect(planPricing.getTenantMrr('enterprise', 500)).toBe(500);
    expect(planPricing.getTenantMrr('enterprise', '500')).toBe(500);   // string → number
    expect(planPricing.getTenantMrr('enterprise', null)).toBe(0);      // sin custom → 0 (no NaN)
    expect(planPricing.getTenantMrr('enterprise', 'abc')).toBe(0);     // garbage → 0
  });

  it('plan desconocido devuelve 0 (no crashea)', () => {
    expect(planPricing.getTenantMrr('plan_inexistente', null)).toBe(0);
    expect(planPricing.getTenantMrr(undefined, null)).toBe(0);
    expect(planPricing.getTenantMrr(null, null)).toBe(0);
  });

  it('refresh del cache cambia el resultado de getTenantMrr', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ plan: 'starter', price_usd: '39' }],
    });
    await planPricing.primeCache();
    expect(planPricing.getTenantMrr('starter', null)).toBe(39);

    db.query.mockResolvedValueOnce({
      rows: [{ plan: 'starter', price_usd: '49' }],
    });
    await planPricing.refreshCache();
    expect(planPricing.getTenantMrr('starter', null)).toBe(49);
  });
});

describe('planPricing — TRIAL_DURATION_DAYS', () => {
  it('es 14 (confirmado en design doc)', () => {
    jest.resetModules();
    const fresh = require('../src/lib/planPricing');
    expect(fresh.TRIAL_DURATION_DAYS).toBe(14);
  });
});
