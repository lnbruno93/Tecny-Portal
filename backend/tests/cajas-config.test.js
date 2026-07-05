/**
 * Tests de integración — Config Cajas (CRUD de cuentas de dinero = metodos_pago)
 * Endpoints bajo /api/cajas/cajas (gestión desde la hoja "Config Cajas").
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

describe('Config Cajas — CRUD', () => {
  it('lista las cajas', async () => {
    const res = await request(app).get('/api/cajas/cajas').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('crea una caja (201) y rechaza duplicado (409)', async () => {
    const r1 = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Test USD', moneda: 'USD' });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ nombre: 'Caja Test USD', moneda: 'USD', activo: true });

    const r2 = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Test USD', moneda: 'ARS' });
    expect(r2.status).toBe(409);
  });

  it('valida moneda inválida (400)', async () => {
    const res = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Mala', moneda: 'EUR' });
    expect(res.status).toBe(400);
  });

  it('actualiza una caja (desactivar) y maneja 404/400', async () => {
    const created = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Editable', moneda: 'ARS' });
    const id = created.body.id;

    const upd = await request(app).put(`/api/cajas/cajas/${id}`).set(auth())
      .send({ activo: false, orden: 5 });
    expect(upd.status).toBe(200);
    expect(upd.body.activo).toBe(false);
    expect(upd.body.orden).toBe(5);

    const notFound = await request(app).put('/api/cajas/cajas/999999').set(auth()).send({ activo: false });
    expect(notFound.status).toBe(404);

    const badId = await request(app).put('/api/cajas/cajas/abc').set(auth()).send({ activo: false });
    expect(badId.status).toBe(400);
  });

  it('borra una caja (soft-delete) y devuelve 404 al reintentar', async () => {
    const created = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Borrable', moneda: 'USDT' });
    const del = await request(app).delete(`/api/cajas/cajas/${created.body.id}`).set(auth());
    expect(del.status).toBe(200);
    const del2 = await request(app).delete(`/api/cajas/cajas/${created.body.id}`).set(auth());
    expect(del2.status).toBe(404);
    const badId = await request(app).delete('/api/cajas/cajas/abc').set(auth());
    expect(badId.status).toBe(400);
  });

  it('no permite borrar una caja en uso (financiera o con movimientos) — R2', async () => {
    const fin = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Fin R2', moneda: 'ARS', es_financiera: true });
    expect((await request(app).delete(`/api/cajas/cajas/${fin.body.id}`).set(auth())).status).toBe(409);

    const c = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Mov R2', moneda: 'USD', saldo_inicial: 0 });
    await request(app).post(`/api/cajas/cajas/${c.body.id}/movimientos`).set(auth())
      .send({ fecha: new Date().toISOString().split('T')[0], tipo: 'ingreso', monto: 100, concepto: 'arqueo' });
    expect((await request(app).delete(`/api/cajas/cajas/${c.body.id}`).set(auth())).status).toBe(409);
  });

  it('la caja desactivada NO aparece en los métodos activos de ventas', async () => {
    const created = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Inactiva', moneda: 'USD', activo: false });
    const activos = await request(app).get('/api/ventas/metodos-pago').set(auth());
    expect(activos.body.some(m => m.id === created.body.id)).toBe(false);
  });

  // Sentry P2 (2026-07-05): un typo en el input dejaba pasar valores fuera de
  // NUMERIC(14,2) hasta el INSERT → 500 "value overflows numeric format".
  // Ahora Zod lo ataja en la capa de schema con 400 amigable.
  it('rechaza saldo_inicial fuera de NUMERIC(14,2) con 400 amigable', async () => {
    const res = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Overflow', moneda: 'USD', saldo_inicial: 1_000_000_000_000 });
    expect(res.status).toBe(400);
    // El mensaje debe hablar de "dígitos" para que el operador sepa qué corregir,
    // no un stack-trace de PG.
    const body = JSON.stringify(res.body).toLowerCase();
    expect(body).toMatch(/dígitos|maximo|máximo|excede|overflow/);
  });

  it('acepta saldo_inicial en el borde superior de NUMERIC(14,2)', async () => {
    // 999_999_999_999.99 es el máximo representable — debe pasar.
    const res = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Borde Max', moneda: 'USD', saldo_inicial: 999_999_999_999.99 });
    expect(res.status).toBe(201);
    expect(Number(res.body.saldo_inicial)).toBe(999_999_999_999.99);
  });

  // Regresión hidden bug 2026-07-05: sin cast explícito `::numeric` en el SQL,
  // pg inferia `$5` como int4 y TRUNCABA los decimales de saldo_inicial
  // (100.50 → 100). No producía error visible — solo mal saldo silencioso.
  it('preserva decimales del saldo_inicial (bug de int cast)', async () => {
    const res = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Decimal', moneda: 'USD', saldo_inicial: 100.5 });
    expect(res.status).toBe(201);
    expect(Number(res.body.saldo_inicial)).toBe(100.5);
  });
});
