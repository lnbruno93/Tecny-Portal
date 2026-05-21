/**
 * Tests de integración — Auth
 *
 * Cubre:
 *   POST /api/auth/login   — credenciales válidas, inválidas, usuario inexistente
 *   GET  /api/auth/me      — token válido
 *   Rutas protegidas       — sin token, token inválido
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Login ───────────────────────────────────────────────────
describe('POST /api/auth/login', () => {
  it('devuelve token con credenciales válidas', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: TEST_USER.password });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.username).toBe(TEST_USER.username);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user).not.toHaveProperty('password_hash');

    token = res.body.token; // guardar para tests siguientes
  });

  it('rechaza contraseña incorrecta → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: 'wrong_password' });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('rechaza usuario inexistente → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'noexiste', password: 'algo' });

    expect(res.status).toBe(401);
  });

  it('rechaza body vacío → 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({});

    expect(res.status).toBe(400);
  });
});

// ─── /me ─────────────────────────────────────────────────────
describe('GET /api/auth/me', () => {
  it('devuelve datos del usuario autenticado', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe(TEST_USER.username);
    expect(res.body).toHaveProperty('perms');
  });
});

// ─── Rutas protegidas ─────────────────────────────────────────
describe('Protección de rutas', () => {
  it('GET /api/envios sin token → 401', async () => {
    const res = await request(app).get('/api/envios');
    expect(res.status).toBe(401);
  });

  it('GET /api/envios con token inválido → 401', async () => {
    const res = await request(app)
      .get('/api/envios')
      .set('Authorization', 'Bearer tokenmalformado');
    expect(res.status).toBe(401);
  });

  it('GET /api/cajas/resumen sin token → 401', async () => {
    const res = await request(app).get('/api/cajas/resumen');
    expect(res.status).toBe(401);
  });
});
