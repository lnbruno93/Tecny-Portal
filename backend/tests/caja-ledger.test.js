/**
 * Tests de integración — Ledger de cajas (Fase 2a)
 * Saldo inicial por caja + movimientos (ajustes manuales) + saldo_actual.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

async function crearCaja(over = {}) {
  const res = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Ledger ' + Math.random().toString(36).slice(2, 7), moneda: 'USD', ...over });
  return res.body;
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Ledger de cajas', () => {
  it('una caja arranca con su saldo inicial', async () => {
    const caja = await crearCaja({ saldo_inicial: 1000 });
    expect(Number(caja.saldo_inicial)).toBe(1000);

    const list = await request(app).get('/api/cajas/cajas').set(auth());
    const row = list.body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(1000);
  });

  it('los ajustes (ingreso/egreso) actualizan el saldo_actual', async () => {
    const caja = await crearCaja({ saldo_inicial: 500 });

    const ing = await request(app).post(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth())
      .send({ fecha: hoy, tipo: 'ingreso', monto: 300, concepto: 'arqueo +' });
    expect(ing.status).toBe(201);

    const egr = await request(app).post(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth())
      .send({ fecha: hoy, tipo: 'egreso', monto: 100, concepto: 'retiro' });
    expect(egr.status).toBe(201);

    // saldo = 500 + 300 - 100 = 700
    const row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(700);
    expect(Number(row.movimientos)).toBe(2);

    // historial
    const movs = await request(app).get(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth());
    expect(movs.body).toHaveLength(2);

    // borrar el egreso → saldo vuelve a 800
    const del = await request(app).delete(`/api/cajas/cajas/movimientos/${egr.body.id}`).set(auth());
    expect(del.status).toBe(200);
    const row2 = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row2.saldo_actual)).toBe(800);
  });

  it('editar el saldo inicial recalcula el saldo', async () => {
    const caja = await crearCaja({ saldo_inicial: 100 });
    await request(app).put(`/api/cajas/cajas/${caja.id}`).set(auth()).send({ saldo_inicial: 250 });
    const row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(250);
  });

  it('un ajuste en una caja ARS requiere tipo de cambio', async () => {
    const caja = await crearCaja({ moneda: 'ARS' });
    const sinTc = await request(app).post(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth())
      .send({ fecha: hoy, tipo: 'ingreso', monto: 142500 });
    expect(sinTc.status).toBe(400);

    const conTc = await request(app).post(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth())
      .send({ fecha: hoy, tipo: 'ingreso', monto: 142500, tc: 1425 });
    expect(conTc.status).toBe(201);
    expect(Number(conTc.body.monto_usd)).toBe(100); // 142500 / 1425
  });
});
