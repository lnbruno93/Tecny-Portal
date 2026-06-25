/**
 * usuarios-role-guard.test.js — 2026-06-24 SEG-1 (audit pre-live).
 *
 * Antes: un owner/admin de cualquier tenant podía pegarle a
 *   POST /api/usuarios { nombre, username, password, role: 'admin' }
 * y crear un user con `role='admin'` GLOBAL. Ese user, al loguear, bypassea
 * `requireCapability` (línea 35 del middleware) en su propio tenant Y los
 * gates del módulo feature-flags que también checkean `role==='admin'`
 * (cross-tenant). Privilege escalation real.
 *
 * Fix: schema fuerza `role: z.literal('op')`. Si el cliente manda 'admin'
 * desde POST o PUT, zod rechaza con 400 antes de tocar la DB. El único
 * path válido para promover a admin global queda `setSuperAdmin.js`.
 *
 * Tests lockean:
 *   1. POST /api/usuarios { role: 'admin' } → 400 (rechazo de schema).
 *   2. POST /api/usuarios { role: 'op' } → 201 (happy path).
 *   3. POST /api/usuarios sin role → 201 con default 'op'.
 *   4. PUT /api/usuarios/:id { role: 'admin' } → 400 (mismo guard).
 */

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

describe('SEG-1: role=admin guard en endpoints públicos', () => {
  it('POST /api/usuarios con role=admin → 400 (zod rechaza)', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set(auth())
      .send({
        nombre: 'Atacante',
        username: 'atacante1',
        password: 'Atacante123!',
        role: 'admin',
      });

    expect(res.status).toBe(400);
    // El body debe mencionar el campo `role` para que el dev vea claro
    // por qué se rechazó.
    expect(JSON.stringify(res.body)).toMatch(/role/i);
  });

  it('POST /api/usuarios con role=op → 201 (happy path)', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set(auth())
      .send({
        nombre: 'Operador 1',
        username: 'op1',
        password: 'Operador123!',
        role: 'op',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'op1', role: 'op' });
  });

  it('POST /api/usuarios sin role → 201 con default op', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set(auth())
      .send({
        nombre: 'Operador 2',
        username: 'op2',
        password: 'Operador123!',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'op2', role: 'op' });
  });

  it('PUT /api/usuarios/:id con role=admin → 400 (mismo guard que POST)', async () => {
    // Creamos un user op para tratar de escalarlo.
    const created = await request(app)
      .post('/api/usuarios')
      .set(auth())
      .send({
        nombre: 'Operador 3',
        username: 'op3',
        password: 'Operador123!',
        role: 'op',
      });
    expect(created.status).toBe(201);
    const opId = created.body.id;

    // Intento de escalada a admin global.
    const res = await request(app)
      .put(`/api/usuarios/${opId}`)
      .set(auth())
      .send({ role: 'admin' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/role/i);
  });
});
