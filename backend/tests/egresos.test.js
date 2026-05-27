/**
 * Tests de integración — módulo Egresos (bajo Cajas).
 * Categorías, recurrentes + generación por período, estado pendiente/pagado
 * con impacto en el ledger de la caja.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, cajaId;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];
const saldoDe = async (id) => Number((await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === id).saldo_actual);

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const caja = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Egresos', moneda: 'USD', saldo_inicial: 1000 });
  cajaId = caja.body.id;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Egresos — categorías', () => {
  it('crea, lista y rechaza duplicado', async () => {
    const c = await request(app).post('/api/egresos/categorias').set(auth()).send({ nombre: 'Marketing' });
    expect(c.status).toBe(201);
    const dup = await request(app).post('/api/egresos/categorias').set(auth()).send({ nombre: 'marketing' });
    expect(dup.status).toBe(409);
    const list = await request(app).get('/api/egresos/categorias').set(auth());
    expect(list.body.some(x => x.nombre === 'Marketing')).toBe(true);
  });
});

describe('Egresos — estado y ledger', () => {
  it('un egreso PENDIENTE no toca la caja', async () => {
    const saldoAntes = await saldoDe(cajaId);
    const e = await request(app).post('/api/egresos').set(auth())
      .send({ fecha: hoy, concepto: 'Servicios', monto: 100, moneda: 'USD', metodo_pago_id: cajaId, estado: 'pendiente' });
    expect(e.status).toBe(201);
    expect(await saldoDe(cajaId)).toBe(saldoAntes); // sin impacto
  });

  it('marcar PAGADO descuenta de la caja, y volver a PENDIENTE lo revierte', async () => {
    const saldoAntes = await saldoDe(cajaId);
    const e = await request(app).post('/api/egresos').set(auth())
      .send({ fecha: hoy, concepto: 'Alquiler', monto: 200, moneda: 'USD', metodo_pago_id: cajaId, estado: 'pendiente' });
    // pendiente → pagado
    await request(app).put(`/api/egresos/${e.body.id}`).set(auth()).send({ estado: 'pagado' });
    expect(await saldoDe(cajaId)).toBe(saldoAntes - 200);
    // pagado → pendiente (revierte)
    await request(app).put(`/api/egresos/${e.body.id}`).set(auth()).send({ estado: 'pendiente' });
    expect(await saldoDe(cajaId)).toBe(saldoAntes);
  });

  it('crear PAGADO sin caja → 400', async () => {
    const e = await request(app).post('/api/egresos').set(auth())
      .send({ fecha: hoy, concepto: 'X', monto: 50, moneda: 'USD', estado: 'pagado' });
    expect(e.status).toBe(400);
  });

  it('borrar un egreso pagado revierte la caja', async () => {
    const saldoAntes = await saldoDe(cajaId);
    const e = await request(app).post('/api/egresos').set(auth())
      .send({ fecha: hoy, concepto: 'Impuesto', monto: 75, moneda: 'USD', metodo_pago_id: cajaId, estado: 'pagado' });
    expect(await saldoDe(cajaId)).toBe(saldoAntes - 75);
    await request(app).delete(`/api/egresos/${e.body.id}`).set(auth());
    expect(await saldoDe(cajaId)).toBe(saldoAntes);
  });
});

describe('Egresos — recurrentes', () => {
  it('genera egresos pendientes por período y es idempotente', async () => {
    const r = await request(app).post('/api/egresos/recurrentes').set(auth())
      .send({ concepto: 'Alquiler oficina', monto: 300, moneda: 'USD', metodo_pago_id: cajaId, dia_del_mes: 5 });
    expect(r.status).toBe(201);

    const gen1 = await request(app).post('/api/egresos/generar').set(auth()).send({ periodo: '2026-06' });
    expect(gen1.body.generados).toBeGreaterThanOrEqual(1);

    // idempotente: segunda corrida no duplica
    const gen2 = await request(app).post('/api/egresos/generar').set(auth()).send({ periodo: '2026-06' });
    expect(gen2.body.generados).toBe(0);

    const list = await request(app).get('/api/egresos?estado=pendiente&desde=2026-06-01&hasta=2026-06-30').set(auth());
    const gen = list.body.data.find(e => e.concepto === 'Alquiler oficina');
    expect(gen).toBeTruthy();
    expect(gen.fecha.startsWith('2026-06-05')).toBe(true);
  });

  it('un recurrente en ARS con TC genera el egreso con monto_usd correcto (R3)', async () => {
    await request(app).post('/api/egresos/recurrentes').set(auth())
      .send({ concepto: 'Expensas oficina', monto: 142500, moneda: 'ARS', tc: 1425, dia_del_mes: 10 });
    await request(app).post('/api/egresos/generar').set(auth()).send({ periodo: '2026-07' });
    const list = await request(app).get('/api/egresos?estado=pendiente&desde=2026-07-01&hasta=2026-07-31').set(auth());
    const gen = list.body.data.find(e => e.concepto === 'Expensas oficina');
    expect(gen).toBeTruthy();
    expect(Number(gen.monto_usd)).toBe(100); // 142500 / 1425
  });
});
