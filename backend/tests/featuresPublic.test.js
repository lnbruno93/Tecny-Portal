/**
 * Tests del middleware `loadFeatures()` y del endpoint público
 * `GET /api/features` (F3 Rec proactiva #3, 2026-07-20).
 *
 * Cubre:
 *   Middleware
 *   · Fake req sin tenantId → resolve al default global.
 *   · Fake req con tenantId + override tenant → respeta override.
 *   · Memo per-request: llamadas repetidas al mismo flag comparten resolve.
 *   · resolveAll() → resuelve array de flags en paralelo.
 *
 *   Endpoint /api/features
 *   · Sin JWT → 401.
 *   · Con JWT → 200 + shape { features: {}, resolved_at }.
 *   · Override tenant → visible en el response del tenant afectado.
 *   · Otro tenant sin override → ve el default global.
 *   · Rollout_pct → respeta bucket determinístico.
 *
 * Nota: no testeamos exhaustivamente la precedencia (eso lo hace
 * `featureFlags.test.js` a nivel resolver). Acá verificamos que el
 * middleware/endpoint enganchen bien contra el resolver.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('../tests/helpers/setup');
const userAuthCache = require('../src/lib/userAuthCache');
const loadFeatures = require('../src/middleware/features');
const { invalidateFeatureCache } = require('../src/lib/featureFlags');

let pool, adminToken;
const auth = () => ({ Authorization: `Bearer ${adminToken}` });

// Nombres de flags únicos para este test — evita colisión con otros tests
// que compartan la tabla `feature_flags`.
const FLAG_GLOBAL_ON  = 'test_f3_public_global_on';
const FLAG_GLOBAL_OFF = 'test_f3_public_global_off';
const FLAG_OVERRIDE   = 'test_f3_public_override';
const FLAG_ROLLOUT    = 'test_f3_public_rollout';

let testTenantId;
let otherTenantId;

beforeAll(async () => {
  pool = await setupTestDb();

  // Token estándar del TEST_USER (no super-admin, con tenant_id=1).
  // Firmamos manual porque `POST /login` con super-admin pediría 2FA — para
  // el test público no hace falta.
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [TEST_USER.username]);
  const userId = r.rows[0].id;
  await userAuthCache.invalidateUserAuth(userId);

  adminToken = jwt.sign({
    id: userId, username: TEST_USER.username, email: TEST_USER.email,
    role: TEST_USER.role, tenant_id: 1, tenant_rol: 'owner', iat_ms: Date.now(),
  }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

  testTenantId = 1;

  // Segundo tenant para pruebas de override tenant-specific.
  const slug = `f3-public-test-${Date.now()}`;
  const t = await pool.query(
    `INSERT INTO tenants (nombre, slug, plan) VALUES ($1, $2, 'starter') RETURNING id`,
    ['F3 Public Test', slug]
  );
  otherTenantId = t.rows[0].id;

  // Seed de flags. Todos custom con prefix test_f3_public_ para aislamiento.
  await pool.query(
    `INSERT INTO feature_flags (name, enabled, description) VALUES
       ($1, true,  'F3 test — default global ON'),
       ($2, false, 'F3 test — default global OFF'),
       ($3, false, 'F3 test — override target'),
       ($4, false, 'F3 test — rollout target')
     ON CONFLICT (name) DO NOTHING`,
    [FLAG_GLOBAL_ON, FLAG_GLOBAL_OFF, FLAG_OVERRIDE, FLAG_ROLLOUT]
  );

  // Override tenant: FLAG_OVERRIDE ON solo para testTenantId (tenant 1).
  await pool.query(
    `INSERT INTO feature_flags_tenants (flag_name, tenant_id, enabled)
     VALUES ($1, $2, true)
     ON CONFLICT (flag_name, tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [FLAG_OVERRIDE, testTenantId]
  );

  // Rollout %: seteamos 100% para que sea determinístico ON en cualquier
  // tenant. (Testear el hash del bucket es responsabilidad de featureFlags.test.js.)
  await pool.query(
    `UPDATE feature_flags SET rollout_pct = 100 WHERE name = $1`,
    [FLAG_ROLLOUT]
  );

  // Invalidar cache Redis por si otro test dejó valores stale.
  await invalidateFeatureCache(FLAG_GLOBAL_ON, testTenantId);
  await invalidateFeatureCache(FLAG_GLOBAL_OFF, testTenantId);
  await invalidateFeatureCache(FLAG_OVERRIDE, testTenantId);
  await invalidateFeatureCache(FLAG_OVERRIDE, otherTenantId);
  await invalidateFeatureCache(FLAG_ROLLOUT, testTenantId);
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM feature_flags WHERE name IN ($1, $2, $3, $4)`,
    [FLAG_GLOBAL_ON, FLAG_GLOBAL_OFF, FLAG_OVERRIDE, FLAG_ROLLOUT]
  );
  await pool.query(`DELETE FROM tenants WHERE id = $1`, [otherTenantId]);
  await teardownTestDb(pool);
});

describe('middleware loadFeatures()', () => {
  // Helper: crea un fake req con tenantId y ejecuta el middleware.
  async function makeReq({ tenantId }) {
    const req = { tenantId };
    const mw = loadFeatures();
    await new Promise((resolve) => mw(req, {}, resolve));
    return req;
  }

  it('req.features.enabled devuelve el default global cuando no hay override', async () => {
    const req = await makeReq({ tenantId: otherTenantId });
    // otherTenant no tiene override → cae al global.
    expect(await req.features.enabled(FLAG_GLOBAL_ON)).toBe(true);
    expect(await req.features.enabled(FLAG_GLOBAL_OFF)).toBe(false);
  });

  it('respeta override tenant sobre el default global', async () => {
    const req = await makeReq({ tenantId: testTenantId });
    // FLAG_OVERRIDE es global OFF pero override tenant ON → ON.
    expect(await req.features.enabled(FLAG_OVERRIDE)).toBe(true);
    // Mismo flag sin override en otro tenant → OFF global.
    const req2 = await makeReq({ tenantId: otherTenantId });
    expect(await req2.features.enabled(FLAG_OVERRIDE)).toBe(false);
  });

  it('memoiza per-request: dos llamadas al mismo flag comparten la promesa', async () => {
    const req = await makeReq({ tenantId: testTenantId });
    // Disparar en paralelo — si el memo no comparte, resolveríamos dos veces.
    // La única señal observable "black-box" es que ambas devuelven el mismo
    // valor sin race — verificamos identidad de la promesa via internals.
    const p1 = req.features.enabled(FLAG_GLOBAL_ON);
    const p2 = req.features.enabled(FLAG_GLOBAL_ON);
    // Misma referencia de promesa → memo funcionando.
    expect(p1).toBe(p2);
    // Y ambas resuelven al mismo valor.
    await expect(p1).resolves.toBe(true);
    await expect(p2).resolves.toBe(true);
  });

  it('resolveAll devuelve map con los N flags pedidos', async () => {
    const req = await makeReq({ tenantId: testTenantId });
    const out = await req.features.resolveAll([FLAG_GLOBAL_ON, FLAG_GLOBAL_OFF, FLAG_OVERRIDE]);
    expect(out).toEqual({
      [FLAG_GLOBAL_ON]: true,
      [FLAG_GLOBAL_OFF]: false,
      [FLAG_OVERRIDE]: true,
    });
  });

  it('resolveAll con array vacío → {} sin errores', async () => {
    const req = await makeReq({ tenantId: testTenantId });
    const out = await req.features.resolveAll([]);
    expect(out).toEqual({});
  });

  it('tenantId null (middleware antes de auth) → resuelve al global sin romper', async () => {
    const req = await makeReq({ tenantId: null });
    // Sin tenantId, isFeatureEnabled cae al default global — no evalúa
    // overrides tenant/plan (que requieren tenant). Rollout tampoco (necesita
    // tenant para el bucket hash).
    expect(await req.features.enabled(FLAG_GLOBAL_ON)).toBe(true);
    expect(await req.features.enabled(FLAG_GLOBAL_OFF)).toBe(false);
    // FLAG_OVERRIDE cae al global (false) porque sin tenant no aplica el override.
    expect(await req.features.enabled(FLAG_OVERRIDE)).toBe(false);
  });
});

describe('GET /api/features', () => {
  it('sin JWT → 401', async () => {
    const res = await request(app).get('/api/features');
    expect(res.status).toBe(401);
  });

  it('con JWT → 200 y devuelve shape { features, resolved_at }', async () => {
    const res = await request(app).get('/api/features').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('features');
    expect(res.body).toHaveProperty('resolved_at');
    expect(typeof res.body.features).toBe('object');
    // resolved_at debe ser ISO parseable.
    expect(new Date(res.body.resolved_at).toString()).not.toBe('Invalid Date');
  });

  it('incluye todos los flags conocidos como booleanos', async () => {
    const res = await request(app).get('/api/features').set(auth());
    expect(res.status).toBe(200);
    // Los 4 flags de este test deben aparecer.
    for (const name of [FLAG_GLOBAL_ON, FLAG_GLOBAL_OFF, FLAG_OVERRIDE, FLAG_ROLLOUT]) {
      expect(res.body.features).toHaveProperty(name);
      expect(typeof res.body.features[name]).toBe('boolean');
    }
  });

  it('respeta override tenant (testTenantId tiene FLAG_OVERRIDE ON)', async () => {
    // adminToken tiene tenant_id: 1 = testTenantId, que tiene override ON.
    const res = await request(app).get('/api/features').set(auth());
    expect(res.status).toBe(200);
    // Global ON: default true.
    expect(res.body.features[FLAG_GLOBAL_ON]).toBe(true);
    // Global OFF: default false.
    expect(res.body.features[FLAG_GLOBAL_OFF]).toBe(false);
    // Override activo → true.
    expect(res.body.features[FLAG_OVERRIDE]).toBe(true);
    // Rollout 100% → siempre true.
    expect(res.body.features[FLAG_ROLLOUT]).toBe(true);
  });
});
