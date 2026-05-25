/**
 * Tests de integración — Proveedores (cuentas por pagar)
 * CRUD de proveedores + movimientos (compras/pagos) + saldo en USD.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

async function crearProveedor(over = {}) {
  const res = await request(app).post('/api/proveedores').set(auth())
    .send({ nombre: 'Mayorista Celulares SA', contacto_nombre: 'Juan', contacto_apellido: 'Pérez', whatsapp: '+5491111', ubicacion: 'CABA', ...over });
  return res.body;
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Proveedores — CRUD', () => {
  it('crea, lista (con saldo 0), obtiene, actualiza y borra', async () => {
    const created = await crearProveedor();
    expect(created.id).toBeDefined();
    expect(created.nombre).toBe('Mayorista Celulares SA');

    const list = await request(app).get('/api/proveedores').set(auth());
    expect(list.status).toBe(200);
    const row = list.body.find(p => p.id === created.id);
    expect(Number(row.saldo_usd)).toBe(0);

    const one = await request(app).get(`/api/proveedores/${created.id}`).set(auth());
    expect(one.status).toBe(200);
    expect(one.body.contacto_nombre).toBe('Juan');

    const upd = await request(app).put(`/api/proveedores/${created.id}`).set(auth()).send({ ubicacion: 'Rosario' });
    expect(upd.status).toBe(200);
    expect(upd.body.ubicacion).toBe('Rosario');

    const del = await request(app).delete(`/api/proveedores/${created.id}`).set(auth());
    expect(del.status).toBe(200);
    const del2 = await request(app).delete(`/api/proveedores/${created.id}`).set(auth());
    expect(del2.status).toBe(404);
  });

  it('valida ID inválido (400) y proveedor inexistente (404)', async () => {
    expect((await request(app).get('/api/proveedores/abc').set(auth())).status).toBe(400);
    expect((await request(app).get('/api/proveedores/999999').set(auth())).status).toBe(404);
  });
});

describe('Proveedores — cuenta corriente', () => {
  it('compra y pago: el saldo (lo que debemos) refleja compras - pagos en USD', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor CC' });

    // Compra de USD 1000 → debemos 1000
    const compra = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', descripcion: '10 iPhone', monto: 1000, moneda: 'USD' });
    expect(compra.status).toBe(201);
    expect(Number(compra.body.monto_usd)).toBe(1000);

    // Pago de USD 600 → debemos 400
    const pago = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'pago', monto: 600, moneda: 'USD' });
    expect(pago.status).toBe(201);

    const list = await request(app).get('/api/proveedores').set(auth());
    const row = list.body.find(p => p.id === prov.id);
    expect(Number(row.saldo_usd)).toBe(400);
    expect(Number(row.movimientos)).toBe(2);
  });

  it('convierte ARS a USD con el TC; rechaza ARS sin TC', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor ARS' });

    const ok = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 142500, moneda: 'ARS', tc: 1425 });
    expect(ok.status).toBe(201);
    expect(Number(ok.body.monto_usd)).toBe(100); // 142500 / 1425

    const sinTc = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 1000, moneda: 'ARS' });
    expect(sinTc.status).toBe(400);
  });

  it('lista movimientos, borra uno y rechaza movimiento de proveedor inexistente', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor Movs' });
    const mov = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 50, moneda: 'USD' });

    const movs = await request(app).get(`/api/proveedores/${prov.id}/movimientos`).set(auth());
    expect(movs.status).toBe(200);
    expect(movs.body.length).toBe(1);

    const del = await request(app).delete(`/api/proveedores/movimientos/${mov.body.id}`).set(auth());
    expect(del.status).toBe(200);

    const notFound = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: 999999, fecha: hoy, tipo: 'compra', monto: 10, moneda: 'USD' });
    expect(notFound.status).toBe(404);
  });

  it('resumen de saldos lista solo proveedores con deuda', async () => {
    const prov = await crearProveedor({ nombre: 'Proveedor Deuda' });
    await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.id, fecha: hoy, tipo: 'compra', monto: 250, moneda: 'USD' });

    const res = await request(app).get('/api/proveedores/resumen/saldos').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.proveedores.some(p => p.id === prov.id)).toBe(true);
    expect(Number(res.body.total_deuda_usd)).toBeGreaterThan(0);
  });
});
