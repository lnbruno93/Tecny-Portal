/**
 * Tests de integración — Cambios de Divisa.
 * Ledger de dos lados con impacto en cajas (entrega ARS / recibo USD) y saldo.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, cajaArs, cajaUsd, entidadId;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];
const saldoDe = async (id) => Number((await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === id).saldo_actual);

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const ca = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Pesos', moneda: 'ARS', saldo_inicial: 5000000 });
  const cu = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Dólar', moneda: 'USD', saldo_inicial: 0 });
  cajaArs = ca.body.id; cajaUsd = cu.body.id;
  const e = await request(app).post('/api/cambios/entidades').set(auth()).send({ nombre: 'El Dorado' });
  entidadId = e.body.id;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Cambios de Divisa', () => {
  it('rechaza financiera duplicada', async () => {
    const dup = await request(app).post('/api/cambios/entidades').set(auth()).send({ nombre: 'el dorado' });
    expect(dup.status).toBe(409);
  });

  it('entrega ARS: egreso de la caja pesos y USD equivalente que nos deben', async () => {
    const saldoAntes = await saldoDe(cajaArs);
    const m = await request(app).post('/api/cambios/movimientos').set(auth())
      .send({ entidad_id: entidadId, fecha: hoy, tipo: 'entrega_ars', monto_ars: 1000000, tc: 1000, caja_id: cajaArs });
    expect(m.status).toBe(201);
    expect(Number(m.body.monto_usd)).toBe(1000); // 1.000.000 / 1.000
    expect(await saldoDe(cajaArs)).toBe(saldoAntes - 1000000);
  });

  it('recibo USD: ingreso a la caja dólar', async () => {
    const saldoAntes = await saldoDe(cajaUsd);
    const m = await request(app).post('/api/cambios/movimientos').set(auth())
      .send({ entidad_id: entidadId, fecha: hoy, tipo: 'recibo_usd', monto_usd: 600, caja_id: cajaUsd });
    expect(m.status).toBe(201);
    expect(await saldoDe(cajaUsd)).toBe(saldoAntes + 600);
  });

  it('saldo de la financiera = entregado − recibido (nos deben)', async () => {
    const det = await request(app).get(`/api/cambios/entidades/${entidadId}`).set(auth());
    expect(Number(det.body.resumen.saldo_usd)).toBe(400); // 1000 entregado - 600 recibido
  });

  it('rechaza entrega_ars sin TC → 400', async () => {
    const m = await request(app).post('/api/cambios/movimientos').set(auth())
      .send({ entidad_id: entidadId, fecha: hoy, tipo: 'entrega_ars', monto_ars: 50000, caja_id: cajaArs });
    expect(m.status).toBe(400);
  });

  it('rechaza entrega_ars contra una caja USD (moneda no coincide) → 400', async () => {
    const m = await request(app).post('/api/cambios/movimientos').set(auth())
      .send({ entidad_id: entidadId, fecha: hoy, tipo: 'entrega_ars', monto_ars: 50000, tc: 1000, caja_id: cajaUsd });
    expect(m.status).toBe(400);
  });

  it('borrar un movimiento revierte la caja y el saldo', async () => {
    const saldoCajaAntes = await saldoDe(cajaUsd);
    const m = await request(app).post('/api/cambios/movimientos').set(auth())
      .send({ entidad_id: entidadId, fecha: hoy, tipo: 'recibo_usd', monto_usd: 100, caja_id: cajaUsd });
    expect(await saldoDe(cajaUsd)).toBe(saldoCajaAntes + 100);
    await request(app).delete(`/api/cambios/movimientos/${m.body.id}`).set(auth());
    expect(await saldoDe(cajaUsd)).toBe(saldoCajaAntes);
  });
});
