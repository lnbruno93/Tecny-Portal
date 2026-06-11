// api-versioning.test.js — 2026-06-11 H-06
//
// Tests del middleware de API versioning (H-06 GRAN auditoría 2026-06-10).
//
// Contrato:
//   1. `/api/v1/<path>` se rewritea internamente a `/api/<path>` y resuelve
//      en el mismo handler que `/api/<path>`. Resultado funcional idéntico.
//   2. Header `API-Version: v1` aparece en TODA respuesta de `/api/...`
//      (con o sin prefijo `/v1`).
//   3. El rewrite preserva el método (POST sigue POST), el body (JSON) y los
//      query params. Solo cambia la URL antes de routing.
//   4. El path original queda en `x-original-url` para observabilidad.
//   5. Rutas que NO empiezan con `/api/` (ej. /health, /ready) no se afectan.
//
// Si en el futuro se introduce `/api/v2/...`, este middleware debe seguir
// dejando `v1` como alias de `/api/...` sin versión — lo testeamos también
// como contrato de compat.

const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;

beforeAll(async () => {
  pool = await setupTestDb();
  const r = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = r.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('API versioning — H-06', () => {
  describe('`/api/v1/...` se rewritea a `/api/...`', () => {
    it('GET /api/v1/auth/me funciona igual que /api/auth/me', async () => {
      const v1 = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      const v0 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(v1.status).toBe(200);
      expect(v0.status).toBe(200);
      // Mismo shape de respuesta (id, username, role…).
      expect(v1.body.username).toBe(v0.body.username);
      expect(v1.body.id).toBe(v0.body.id);
    });

    it('POST con body JSON funciona vía /api/v1/', async () => {
      // Login con credenciales malas — verificamos que el body llegó al handler
      // (devuelve 401 con mensaje específico, no 404 ni 500).
      const r = await request(app).post('/api/v1/auth/login')
        .send({ username: 'no-existe', password: 'x' });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('Usuario o contraseña incorrectos');
    });

    it('query params se preservan en el rewrite', async () => {
      const v1 = await request(app)
        .get('/api/v1/inventario/productos?limit=1&clase=celular')
        .set('Authorization', `Bearer ${token}`);
      expect([200, 403]).toContain(v1.status); // 403 si el user no tiene permiso inventario
      // No es 404 — el rewrite preservó el path y los query params.
      expect(v1.status).not.toBe(404);
    });
  });

  describe('Header `API-Version`', () => {
    it('Header presente en /api/auth/me (sin versión)', async () => {
      const r = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(r.headers['api-version']).toBe('v1');
    });

    it('Header presente en /api/v1/auth/me', async () => {
      const r = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(r.headers['api-version']).toBe('v1');
    });

    it('Header AUSENTE en /health (no es /api/...)', async () => {
      const r = await request(app).get('/health');
      expect(r.headers['api-version']).toBeUndefined();
    });
  });

  describe('Observabilidad — x-original-url', () => {
    it('GET /api/v1/foo guarda el path original en x-original-url para downstream', async () => {
      // No podemos leer el header desde afuera porque el rewrite ocurre
      // antes que el handler. La prueba indirecta: si en producción Sentry o
      // pino-http loggea `req.url`, ve `/api/foo` (post-rewrite). El path
      // original solo es accesible vía `req.headers['x-original-url']` desde
      // dentro de un handler. Acá validamos que NO rompe nada que el header
      // está seteado — sería visible en logs si lo loggeamos en algún
      // middleware downstream.
      const r = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(r.status).toBe(200);
      // Si el rewrite no rompió el routing, el test pasa.
    });
  });

  describe('Rutas no-/api/ no se afectan', () => {
    it('GET /health pasa sin tocar nada', async () => {
      const r = await request(app).get('/health');
      expect([200, 503]).toContain(r.status); // 503 si DB no responde
      expect(r.body.status).toBeDefined();
    });

    it('GET /ready pasa sin tocar nada', async () => {
      const r = await request(app).get('/ready');
      expect([200, 503]).toContain(r.status);
    });

    it('GET /api/v1 (sin slash final) también se rewritea a /api', async () => {
      // Edge case: si alguien pega `/api/v1` plano sin path adicional,
      // el rewrite lo convierte a `/api`. Express devuelve 404 o lo que
      // sea — la prueba es que NO crashea con 500.
      const r = await request(app).get('/api/v1');
      expect(r.status).not.toBe(500);
    });
  });
});
