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
    // 2026-06-23 F4: el response del /me ya no incluye `perms` (14 booleans
    // del sistema viejo). En su lugar manda `caps` (array de slugs activos
    // o null para bypass) + `tenant_cap_rol`. El test admin tiene role=admin
    // global → no se materializan caps (bypass implícito), pero el campo
    // existe en el response shape.
    expect(res.body).toHaveProperty('caps');
  });

  // TANDA 4.C (billing pre-live 2026-06-25): el response de /me incluye
  // info del tenant para que el frontend pueda mostrar banners de
  // paid_until / suspended state.
  it('TANDA 4.C: incluye tenant {id, plan, paid_until, is_active}', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tenant');
    expect(res.body.tenant).toMatchObject({
      id:        expect.any(Number),
      plan:      expect.any(String),
      is_active: true, // tenant test default: paid_until NULL → grandfathered → active
    });
    // paid_until puede ser null (grandfathered) o una fecha — el shape debe
    // estar definido para que el frontend renderice consistente.
    expect('paid_until' in res.body.tenant).toBe(true);
    expect('suspended_at' in res.body.tenant).toBe(true);
  });

  // 2026-07-11 (bug Tek Haus): cuando `getTenantStatus` falla (cache miss +
  // DB hiccup en el helper), el catch fail-open dejaba `tenant: null` en el
  // response de /me. El frontend cacheaba eso en user.tenant=null → todas
  // las descargas de comprobantes salían brandeadas con "Tecny" (fallback
  // hardcoded). El fix agrega un fallback query directo a `tenants` que
  // garantiza al menos `nombre` + `pais`. Este test forza el fail del
  // helper y verifica que el response sigue trayendo `tenant.nombre`.
  it('fallback query directo a tenants si getTenantStatus falla → nombre presente', async () => {
    const tenantStatus = require('../src/lib/tenantStatus');
    // Forza reject en TODOS los llamados durante el scope del try (mockRejectedValue,
    // no Once — así también cubre eventual retry interno del helper).
    const spy = jest.spyOn(tenantStatus, 'getTenantStatus')
      .mockRejectedValue(new Error('simulated cache/DB hiccup'));
    try {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('tenant');
      // El fix garantiza que tenant NO es null aún con el helper roto — el
      // response cae al fallback query directo a `tenants`.
      expect(res.body.tenant).not.toBeNull();
      // Nombre es lo crítico para brand de comprobantes — no debe venir null.
      expect(res.body.tenant.nombre).toBeTruthy();
      expect(typeof res.body.tenant.nombre).toBe('string');
      // Pais siempre presente (default 'AR' si el row viene sin).
      expect(res.body.tenant.pais).toMatch(/^(AR|UY)$/);
      // En el fallback path, plan/paid_until quedan null (no los conocemos —
      // ver auth.js /me para racional del degraded response).
      expect(res.body.tenant.plan).toBeNull();
      expect(res.body.tenant.paid_until).toBeNull();
      // Verificamos que el spy efectivamente se disparó al menos 1 vez.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
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

  it('TANDA 3 fix T7: cache devuelve password_changed_at corrupto → 401 (fail-closed)', async () => {
    // Cache poisoning / data corruption / parser bug futuro pueden hacer que
    // userAuthCache devuelva un timestamp malformado. Sin el NaN guard, la
    // comparación `tokenIssuedMs < NaN` daba false → token VIEJO aceptado
    // como válido. Con el fix: rechazamos con 401 fail-closed.
    const userAuthCache = require('../src/lib/userAuthCache');
    const spy = jest.spyOn(userAuthCache, 'getUserAuth').mockResolvedValueOnce({
      password_changed_at: 'not-a-valid-date',
      email_verified_at: null,
    });
    try {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/sesión inválida/i);
    } finally {
      spy.mockRestore();
    }
  });
});
