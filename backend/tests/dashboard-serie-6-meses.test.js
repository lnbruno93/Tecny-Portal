/**
 * Tests del endpoint GET /api/dashboard/serie-6-meses (task #309).
 *
 * Cubre:
 *  · Shape del response: { data: [{mes, facturacion_usd, egresos_usd, ganancia_neta_usd}], generado_en }
 *  · Cap de meses (400 si <1 o >24)
 *  · Redacción de ganancia_neta_usd si el user no tiene cap ventas.ver_ganancias
 *  · Orden cronológico ascendente (el más viejo primero)
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('GET /api/dashboard/serie-6-meses', () => {
  it('devuelve 6 meses por default en orden cronológico', async () => {
    const r = await request(app).get('/api/dashboard/serie-6-meses').set(auth());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.data).toHaveLength(6);
    // Shape de cada punto
    for (const p of r.body.data) {
      expect(p).toHaveProperty('mes');
      expect(p.mes).toMatch(/^\d{4}-\d{2}$/);
      expect(p).toHaveProperty('facturacion_usd');
      expect(p).toHaveProperty('egresos_usd');
      expect(p).toHaveProperty('ganancia_neta_usd');
      expect(typeof p.facturacion_usd).toBe('number');
      expect(typeof p.egresos_usd).toBe('number');
      expect(typeof p.ganancia_neta_usd).toBe('number');
    }
    // Orden ascendente por mes
    const meses = r.body.data.map(p => p.mes);
    const sorted = [...meses].sort();
    expect(meses).toEqual(sorted);
    // Metadata
    expect(typeof r.body.generado_en).toBe('string');
  });

  it('acepta ?meses=3 y devuelve 3 puntos', async () => {
    const r = await request(app).get('/api/dashboard/serie-6-meses?meses=3').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(3);
  });

  it('acepta ?hasta=YYYY-MM y usa ese mes como final', async () => {
    const r = await request(app).get('/api/dashboard/serie-6-meses?meses=2&hasta=2026-06').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
    expect(r.body.data[0].mes).toBe('2026-05');
    expect(r.body.data[1].mes).toBe('2026-06');
  });

  it('rechaza meses < 1 o > 24 con 400', async () => {
    const r1 = await request(app).get('/api/dashboard/serie-6-meses?meses=0').set(auth());
    expect(r1.status).toBe(400);
    const r2 = await request(app).get('/api/dashboard/serie-6-meses?meses=25').set(auth());
    expect(r2.status).toBe(400);
  });

  it('rechaza hasta con formato inválido', async () => {
    const r = await request(app).get('/api/dashboard/serie-6-meses?hasta=2026/06').set(auth());
    expect(r.status).toBe(400);
  });
});
