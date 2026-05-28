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

// H1: Matriz de roles más amplia. La auditoría detectó que solo testeábamos
// admin / op-sin-permisos. Aquí cubrimos el caso "operador con SOLO un permiso
// puntual" para varios módulos y verificamos que el control es granular.
describe('Matriz de permisos por módulo (H1)', () => {
  let opCajas, opFinanciera, opSinNada;

  beforeAll(async () => {
    // Operador con solo `cajas` (cubre /api/cajas; egresos / cambios / tarjetas
    // requieren sus propios permisos, no se heredan).
    await request(app).post('/api/usuarios').set('Authorization', `Bearer ${adminToken}`).send({
      nombre: 'Op Solo Cajas', username: 'opcajas', password: 'opcajas123', role: 'op',
      perms: { cajas: true },
    });
    opCajas = (await request(app).post('/api/auth/login').send({ username: 'opcajas', password: 'opcajas123' })).body.token;

    // Operador con solo `financiera`
    await request(app).post('/api/usuarios').set('Authorization', `Bearer ${adminToken}`).send({
      nombre: 'Op Solo Fin', username: 'opfin', password: 'opfin123', role: 'op',
      perms: { financiera: true },
    });
    opFinanciera = (await request(app).post('/api/auth/login').send({ username: 'opfin', password: 'opfin123' })).body.token;

    // Operador sin ningún permiso
    await request(app).post('/api/usuarios').set('Authorization', `Bearer ${adminToken}`).send({
      nombre: 'Op Sin Nada', username: 'opnada', password: 'opnada123', role: 'op',
    });
    opSinNada = (await request(app).post('/api/auth/login').send({ username: 'opnada', password: 'opnada123' })).body.token;
  });

  it('op con solo `cajas` accede a /api/cajas pero NO a /api/financiera', async () => {
    const ok = await request(app).get('/api/cajas/cajas').set('Authorization', `Bearer ${opCajas}`);
    expect(ok.status).toBe(200);
    const no = await request(app).get('/api/comprobantes').set('Authorization', `Bearer ${opCajas}`);
    expect(no.status).toBe(403);
  });

  it('op con solo `financiera` accede a comprobantes pero NO a inventario ni ventas', async () => {
    const ok = await request(app).get('/api/comprobantes').set('Authorization', `Bearer ${opFinanciera}`);
    expect(ok.status).toBe(200);
    const noInv = await request(app).get('/api/inventario/productos').set('Authorization', `Bearer ${opFinanciera}`);
    expect(noInv.status).toBe(403);
    const noVen = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}`).set('Authorization', `Bearer ${opFinanciera}`);
    expect(noVen.status).toBe(403);
  });

  it('op sin permisos no accede a nada productivo (todo 403)', async () => {
    const endpoints = [
      '/api/inventario/productos',
      '/api/cajas/cajas',
      '/api/comprobantes',
      `/api/ventas?desde=${hoy}&hasta=${hoy}`,
    ];
    for (const ep of endpoints) {
      const r = await request(app).get(ep).set('Authorization', `Bearer ${opSinNada}`);
      expect(r.status).toBe(403);
    }
  });

  it('todos los operadores pueden /api/auth/me (no requiere permiso de módulo)', async () => {
    for (const t of [opCajas, opFinanciera, opSinNada]) {
      const r = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${t}`);
      expect(r.status).toBe(200);
    }
  });
});
