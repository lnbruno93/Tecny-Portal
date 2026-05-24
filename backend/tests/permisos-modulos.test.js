/**
 * Tests de integración — permisos de los módulos nuevos (inventario / ventas)
 *
 * Verifica que un operador (role 'op') pueda recibir el permiso 'inventario'
 * y NO 'ventas', y que el control de acceso lo respete:
 *   - con permiso → 200
 *   - sin permiso → 403
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, adminToken, opToken;
const hoy = new Date().toISOString().split('T')[0];

beforeAll(async () => {
  pool = await setupTestDb();
  const a = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = a.body.token;

  // Crear operador con permiso de inventario pero NO de ventas
  await request(app).post('/api/usuarios').set('Authorization', `Bearer ${adminToken}`).send({
    nombre: 'Operador Stock', username: 'opstock', password: 'opstock123', role: 'op',
    perms: { inventario: true, ventas: false },
  });
  const o = await request(app).post('/api/auth/login').send({ username: 'opstock', password: 'opstock123' });
  opToken = o.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Permisos de módulos nuevos', () => {
  it('el login del operador devuelve el permiso inventario en perms', async () => {
    const res = await request(app).post('/api/auth/login').send({ username: 'opstock', password: 'opstock123' });
    expect(res.status).toBe(200);
    expect(res.body.user.perms.inventario).toBe(true);
    expect(res.body.user.perms.ventas).toBe(false);
  });

  it('operador CON permiso accede a inventario → 200', async () => {
    const res = await request(app).get('/api/inventario/productos').set('Authorization', `Bearer ${opToken}`);
    expect(res.status).toBe(200);
  });

  it('operador SIN permiso de ventas → 403', async () => {
    const res = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}`).set('Authorization', `Bearer ${opToken}`);
    expect(res.status).toBe(403);
  });

  it('admin accede a ambos (bypass de permisos)', async () => {
    const inv = await request(app).get('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`);
    const ven = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}`).set('Authorization', `Bearer ${adminToken}`);
    expect(inv.status).toBe(200);
    expect(ven.status).toBe(200);
  });
});
