// schemas-strict.test.js — 2026-06-11 T-06
//
// Verifica que los schemas Zod con .strict() rechazan payloads con campos extra.
// Antes solo `cuentas.test.js` cubría esta guarda en sus 3 schemas — los otros
// 20+ podían refactorearse a `.strip()` (default) por accidente sin que CI
// detectara la regresión.
//
// Patrón: por cada endpoint canónico, mandamos un payload con 1 campo inventado
// y verificamos 400. El test NO chequea la lógica del endpoint — solo que la
// guarda strict() siga ahí.

const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;

beforeAll(async () => {
  pool = await setupTestDb();
  const login = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = login.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('Schemas .strict() rechazan campos extras', () => {
  const cases = [
    // [método, path, body con 1 campo extra]
    ['post', '/api/ventas', {
      fecha: '2026-04-01',
      cliente_nombre: 'Cliente strict',
      items: [{ descripcion: 'X', cantidad: 1, precio_vendido: 10, costo: 5, moneda: 'USD' }],
      pagos: [],
      _campo_inventado: true,
    }],
    ['post', '/api/envios', {
      fecha: '2026-04-01', cliente: 'Cliente E', direccion: 'Calle 1',
      _inventado: 'x',
    }],
    ['post', '/api/cajas/cajas', {
      nombre: 'Caja strict', moneda: 'USD', saldo_inicial: 0,
      payload_falso: true,
    }],
    ['post', '/api/proveedores', {
      nombre: 'Prov strict',
      otro_campo: 'x',
    }],
    ['post', '/api/inventario/categorias', {
      nombre: 'Cat strict',
      hackeo: 1,
    }],
    ['post', '/api/inventario/depositos', {
      nombre: 'Dep strict',
      extra: true,
    }],
    ['post', '/api/cuentas/clientes', {
      nombre: 'Cliente strict', categoria: 'A+',
      hidden: 'x',
    }],
    ['post', '/api/contactos', {
      nombre: 'Contacto strict', tipo: 'cliente',
      campo_falso: true,
    }],
    ['post', '/api/egresos', {
      fecha: '2026-04-01', concepto: 'Egr strict', monto: 1, moneda: 'USD',
      no_existe: true,
    }],
    ['post', '/api/cambios/entidades', {
      nombre: 'Ent strict',
      malicioso: 'x',
    }],
  ];

  test.each(cases)('%s %s con campo extra → 400', async (method, path, body) => {
    const r = await request(app)[method](path).set(auth()).send(body);
    expect(r.status).toBe(400);
  });
});
