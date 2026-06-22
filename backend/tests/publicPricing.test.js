/**
 * Tests integration para el endpoint público GET /api/public/pricing
 * (Sub-fase C.1.2 #353).
 *
 * Cubre:
 *   · 200 sin auth (es endpoint público).
 *   · Shape: { prices, currency, period }.
 *   · prices.trial === 0 (matchea seed de migration).
 *   · Header Cache-Control: public, max-age=60.
 *   · Refleja cambios del cache: si refreshCache() corre con valor nuevo,
 *     el endpoint devuelve el valor nuevo.
 *
 * No requiere DB real para el shape — mockeamos planPricing.getPlanPrices.
 * Pero un test final usa el flow real (setupTestDb + primeCache desde la
 * tabla plan_prices con los seeds) para confirmar la integración end-to-end.
 */

const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const planPricing = require('../src/lib/planPricing');

let pool;

beforeAll(async () => {
  pool = await setupTestDb();
  // Forzar prime desde la tabla `plan_prices` (los tests deberían correr
  // con el seed: trial=0, starter=39, pro=189, enterprise=NULL).
  await planPricing.primeCache();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe('GET /api/public/pricing', () => {
  it('200 sin auth — es endpoint público', async () => {
    const r = await request(app).get('/api/public/pricing');
    expect(r.status).toBe(200);
  });

  it('devuelve shape { prices, currency, period }', async () => {
    const r = await request(app).get('/api/public/pricing');
    expect(r.body).toHaveProperty('prices');
    expect(r.body).toHaveProperty('currency', 'USD');
    expect(r.body).toHaveProperty('period', 'monthly');
    expect(r.body.prices).toEqual(expect.objectContaining({
      trial: 0,
      starter: expect.any(Number),
      pro: expect.any(Number),
      enterprise: null,
    }));
  });

  it('header Cache-Control: public, max-age=60', async () => {
    const r = await request(app).get('/api/public/pricing');
    expect(r.headers['cache-control']).toMatch(/public/);
    expect(r.headers['cache-control']).toMatch(/max-age=60/);
  });

  it('refleja el cache actual (cambio post-refreshCache se ve)', async () => {
    // Update directo de la DB + refresh manual (simula lo que hace el
    // endpoint admin PATCH /plan-prices/starter).
    await pool.query(`UPDATE plan_prices SET price_usd = 59 WHERE plan = 'starter'`);
    await planPricing.refreshCache();

    const r = await request(app).get('/api/public/pricing');
    expect(r.body.prices.starter).toBe(59);

    // Cleanup — restaurar el seed.
    await pool.query(`UPDATE plan_prices SET price_usd = 39 WHERE plan = 'starter'`);
    await planPricing.refreshCache();
  });

  it('seed inicial: starter=39 y pro=189 (matchea migration)', async () => {
    const r = await request(app).get('/api/public/pricing');
    expect(r.body.prices.starter).toBe(39);
    expect(r.body.prices.pro).toBe(189);
  });
});
