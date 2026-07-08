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

  // 2026-06-24 SOL-1 (audit pre-live): TC obligatorio cuando moneda='ARS'.
  // Antes: el operador podía cargar un egreso en ARS sin tc, monto_usd quedaba
  // en 0, el dashboard descontaba USD 0 de la ganancia neta → KPI inflado
  // silenciosamente. Estos tests lockean el guard.
  describe('SOL-1: TC obligatorio en egresos ARS', () => {
    it('POST con moneda=ARS sin tc → 400 con mensaje claro', async () => {
      const e = await request(app).post('/api/egresos').set(auth())
        .send({ fecha: hoy, concepto: 'Alquiler ARS', monto: 100000, moneda: 'ARS' });
      expect(e.status).toBe(400);
      expect(JSON.stringify(e.body)).toMatch(/TC.*requerido.*ARS/i);
    });

    it('POST con moneda=ARS con tc=0 → 400', async () => {
      const e = await request(app).post('/api/egresos').set(auth())
        .send({ fecha: hoy, concepto: 'Servicios ARS', monto: 50000, moneda: 'ARS', tc: 0 });
      expect(e.status).toBe(400);
    });

    it('POST con moneda=ARS con tc>0 → 201 (happy path)', async () => {
      const e = await request(app).post('/api/egresos').set(auth())
        .send({ fecha: hoy, concepto: 'Internet ARS', monto: 142500, moneda: 'ARS', tc: 1425 });
      expect(e.status).toBe(201);
      // monto_usd debe ser ~100 USD (142500 / 1425), no 0.
      expect(Number(e.body.monto_usd)).toBeCloseTo(100, 1);
    });

    it('PUT cambiando a moneda=ARS sin tc → 400', async () => {
      // Creamos uno en USD primero.
      const created = await request(app).post('/api/egresos').set(auth())
        .send({ fecha: hoy, concepto: 'Gasto USD', monto: 100, moneda: 'USD' });
      expect(created.status).toBe(201);
      // Intentamos cambiarle moneda a ARS sin proveer tc.
      const upd = await request(app).put(`/api/egresos/${created.body.id}`).set(auth())
        .send({ moneda: 'ARS' });
      expect(upd.status).toBe(400);
      expect(JSON.stringify(upd.body)).toMatch(/TC.*requerido.*ARS/i);
    });
  });

  // 2026-07-08 Multi-país F2 backfill: idem SOL-1 pero para UYU. Antes el
  // refine solo cubría ARS → un tenant UY podía persistir egreso UYU sin tc,
  // `toUsd(m,'UYU',null)=0`, dashboard mentía. Estos tests lockean el fix.
  //
  // NOTA sobre el TEST_USER: el tenant default es AR, por lo que UYU pega
  // primero con `assertMonedaValidaParaPais` (400 "no habilitada para país").
  // Aún así los tests son útiles: en cualquier caso el POST/PUT UYU sin TC
  // debe fallar (nunca persistirse con monto_usd=0). Los happy-path UYU
  // requerirían tenant UY y están cubiertos por los unit tests puros del
  // helper `requiereTc()` en `tests/schemas-common.test.js`.
  describe('Multi-país F2: TC obligatorio en egresos UYU', () => {
    it('POST con moneda=UYU sin tc → 400 (rechazado, no persiste con monto_usd=0)', async () => {
      const e = await request(app).post('/api/egresos').set(auth())
        .send({ fecha: hoy, concepto: 'Alquiler UYU', monto: 40000, moneda: 'UYU' });
      expect(e.status).toBe(400);
      // El body puede indicar "TC requerido" (schema) o "no habilitada para
      // país" (guard multi-país) — ambos son rechazos válidos que evitan el
      // bug del monto_usd=0 silencioso.
      expect(JSON.stringify(e.body)).toMatch(/tc|UYU|no habilitada/i);
    });

    it('POST con moneda=UYU con tc=0 → 400', async () => {
      const e = await request(app).post('/api/egresos').set(auth())
        .send({ fecha: hoy, concepto: 'Servicios UYU', monto: 40000, moneda: 'UYU', tc: 0 });
      expect(e.status).toBe(400);
    });

    it('PUT cambiando a moneda=UYU sin tc → 400', async () => {
      const created = await request(app).post('/api/egresos').set(auth())
        .send({ fecha: hoy, concepto: 'Gasto USD', monto: 100, moneda: 'USD' });
      expect(created.status).toBe(201);
      const upd = await request(app).put(`/api/egresos/${created.body.id}`).set(auth())
        .send({ moneda: 'UYU' });
      expect(upd.status).toBe(400);
      expect(JSON.stringify(upd.body)).toMatch(/tc|UYU|no habilitada/i);
    });
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

  // 2026-07-08 Multi-país F2 backfill: guards TC/país en recurrentes UYU.
  // El bug era hermano del override (que se fixeó en la misma pasada): antes
  // el `createRecurrenteSchema` NO tenía refine `requiereTc()` → un tenant UY
  // podía crear recurrente UYU sin tc → `default_usd = toUsd(m,'UYU',null) = 0`
  // → subestimaba KPI de Sanidad "Gastos e inversiones totales". Este test
  // lockea que en NINGÚN caso se persista sin TC.
  //
  // NOTA: TEST_USER = tenant AR, entonces UYU pega primero con
  // `assertMonedaValidaParaPais` (400 "no habilitada para país"). Ambos son
  // rechazos válidos que evitan el bug del default_usd=0.
  it('rechaza recurrente UYU sin TC (nunca persiste con default_usd=0)', async () => {
    const r = await request(app).post('/api/egresos/recurrentes').set(auth())
      .send({ concepto: 'Alquiler UYU', monto: 40000, moneda: 'UYU', dia_del_mes: 5 });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/tc|UYU|no habilitada/i);
  });

  it('rechaza recurrente UYU con tc=0', async () => {
    const r = await request(app).post('/api/egresos/recurrentes').set(auth())
      .send({ concepto: 'Servicios UYU', monto: 40000, moneda: 'UYU', tc: 0, dia_del_mes: 5 });
    expect(r.status).toBe(400);
  });
});
