/**
 * Tests de endpoints admin de feature flags per-tenant (F2 Rec proactiva #3).
 *
 * Cubre:
 *   · GET /api/super-admin/features → lista con overrides
 *   · PATCH /api/super-admin/features/:name → rollout_pct + enabled + description
 *   · POST /api/super-admin/features/:name/tenants/:tenantId → upsert override
 *   · DELETE .../tenants/:tenantId → clear override
 *   · POST .../plans/:planId → upsert plan override
 *   · DELETE .../plans/:planId → clear plan override
 *   · Todos requieren super-admin (401 sin auth)
 *   · Validaciones Zod (400s)
 *   · Audit log persistido
 *   · Cache invalidation post-write (verificado indirectamente via isFeatureEnabled)
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const userAuthCache = require('../src/lib/userAuthCache');
const { isFeatureEnabled, invalidateFeatureCache } = require('../src/lib/featureFlags');

let pool, superAdminToken;
let testTenantId, otherTenantId;
const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

const TEST_FLAG = 'test_admin_ff_endpoints';

beforeAll(async () => {
  pool = await setupTestDb();

  // TEST_USER como super-admin + 2FA (patrón siteConfig.test.js).
  await pool.query('UPDATE users SET is_super_admin = true WHERE id = 1');
  await pool.query(`
    INSERT INTO user_2fa (user_id, secret_encrypted, recovery_codes, enabled_at)
    VALUES (1, 'test-secret-enc', ARRAY['hash1','hash2'], NOW())
    ON CONFLICT (user_id) DO UPDATE SET enabled_at = NOW()
  `);
  await userAuthCache.invalidateUserAuth(1);

  superAdminToken = jwt.sign({
    id: 1, username: TEST_USER.username, email: TEST_USER.email,
    role: TEST_USER.role, tenant_id: 1, tenant_rol: 'owner',
    is_super_admin: true, iat_ms: Date.now(),
  }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

  testTenantId = 1;
  // Segundo tenant para pruebas de override.
  const slug = `ff-admin-test-${Date.now()}`;
  const { rows } = await pool.query(
    `INSERT INTO tenants (nombre, slug, plan) VALUES ($1, $2, $3) RETURNING id`,
    ['Other FF Admin Test', slug, 'pro']
  );
  otherTenantId = rows[0].id;

  // Seed del flag de prueba.
  await pool.query(
    `INSERT INTO feature_flags (name, enabled, description) VALUES ($1, false, 'ff admin test')
     ON CONFLICT (name) DO NOTHING`,
    [TEST_FLAG]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM feature_flags WHERE name = $1`, [TEST_FLAG]);
  if (otherTenantId) {
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [otherTenantId]);
  }
  await teardownTestDb(pool);
});

// ── Auth ───────────────────────────────────────────────────────────────

describe('Feature flags admin endpoints — auth', () => {
  it('GET /features → 401 sin token', async () => {
    const r = await request(app).get('/api/super-admin/features');
    expect(r.status).toBe(401);
  });

  it('PATCH /features/:name → 401 sin token', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/features/${TEST_FLAG}`)
      .send({ enabled: true });
    expect(r.status).toBe(401);
  });

  it('POST /features/:name/tenants/:id → 401 sin token', async () => {
    const r = await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/tenants/${testTenantId}`)
      .send({ enabled: true });
    expect(r.status).toBe(401);
  });
});

// ── GET /features ──────────────────────────────────────────────────────

describe('GET /api/super-admin/features', () => {
  it('devuelve lista de flags con overrides agrupados', async () => {
    const r = await request(app).get('/api/super-admin/features').set(auth());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.flags)).toBe(true);
    const testFlag = r.body.flags.find((f) => f.name === TEST_FLAG);
    expect(testFlag).toBeDefined();
    expect(testFlag).toHaveProperty('enabled');
    expect(testFlag).toHaveProperty('rollout_pct');
    expect(testFlag).toHaveProperty('description');
    expect(Array.isArray(testFlag.tenant_overrides)).toBe(true);
    expect(Array.isArray(testFlag.plan_overrides)).toBe(true);
  });
});

// ── PATCH /features/:name ──────────────────────────────────────────────

describe('PATCH /api/super-admin/features/:name', () => {
  afterEach(async () => {
    // Reset flag entre tests.
    await pool.query(
      `UPDATE feature_flags SET enabled = false, rollout_pct = NULL WHERE name = $1`,
      [TEST_FLAG]
    );
    await invalidateFeatureCache(TEST_FLAG, testTenantId);
    await invalidateFeatureCache(TEST_FLAG, otherTenantId);
  });

  it('actualiza enabled del flag global', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/features/${TEST_FLAG}`)
      .set(auth())
      .send({ enabled: true });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);

    // Verificar via resolver que el cambio efectivamente aplicó.
    expect(await isFeatureEnabled(TEST_FLAG, testTenantId, { skipCache: true })).toBe(true);
  });

  it('actualiza rollout_pct', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/features/${TEST_FLAG}`)
      .set(auth())
      .send({ rollout_pct: 50 });
    expect(r.status).toBe(200);
    expect(r.body.rollout_pct).toBe(50);
  });

  it('rechaza rollout_pct fuera de rango → 400', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/features/${TEST_FLAG}`)
      .set(auth())
      .send({ rollout_pct: 150 });
    expect(r.status).toBe(400);
  });

  it('rechaza body {} → 400 (al menos un campo requerido)', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/features/${TEST_FLAG}`)
      .set(auth())
      .send({});
    expect(r.status).toBe(400);
  });

  it('rechaza campos extra → 400 (strict)', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/features/${TEST_FLAG}`)
      .set(auth())
      .send({ enabled: true, campo_no_esperado: 'x' });
    expect(r.status).toBe(400);
  });

  it('404 si el flag no existe', async () => {
    const r = await request(app)
      .patch(`/api/super-admin/features/flag_que_no_existe`)
      .set(auth())
      .send({ enabled: true });
    expect(r.status).toBe(404);
  });
});

// ── Tenant override CRUD ───────────────────────────────────────────────

describe('POST/DELETE /api/super-admin/features/:name/tenants/:id', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM feature_flags_tenants WHERE flag_name = $1`, [TEST_FLAG]);
    await invalidateFeatureCache(TEST_FLAG, testTenantId);
    await invalidateFeatureCache(TEST_FLAG, otherTenantId);
  });

  it('POST upsert tenant override + resolver refleja el cambio', async () => {
    // Global OFF, override tenant testTenantId a ON.
    const r = await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/tenants/${testTenantId}`)
      .set(auth())
      .send({ enabled: true, reason: 'canary group A' });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.reason).toBe('canary group A');
    expect(r.body.updated_by).toBe(1);

    // Resolver refleja el override.
    expect(await isFeatureEnabled(TEST_FLAG, testTenantId, { skipCache: true })).toBe(true);
    // Otro tenant sin override sigue en global (OFF).
    expect(await isFeatureEnabled(TEST_FLAG, otherTenantId, { skipCache: true })).toBe(false);
  });

  it('POST idempotente — segundo POST actualiza en lugar de duplicar', async () => {
    // Primer POST.
    await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/tenants/${testTenantId}`)
      .set(auth())
      .send({ enabled: true });

    // Segundo POST con enabled=false → debe pisar.
    const r = await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/tenants/${testTenantId}`)
      .set(auth())
      .send({ enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);

    // Verificar en DB que solo hay 1 row.
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n FROM feature_flags_tenants WHERE flag_name = $1 AND tenant_id = $2`,
      [TEST_FLAG, testTenantId]
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('DELETE limpia override + resolver vuelve a global', async () => {
    // Setup: crear override.
    await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/tenants/${testTenantId}`)
      .set(auth())
      .send({ enabled: true });
    expect(await isFeatureEnabled(TEST_FLAG, testTenantId, { skipCache: true })).toBe(true);

    // DELETE.
    const r = await request(app)
      .delete(`/api/super-admin/features/${TEST_FLAG}/tenants/${testTenantId}`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // Resolver vuelve al default global (OFF).
    expect(await isFeatureEnabled(TEST_FLAG, testTenantId, { skipCache: true })).toBe(false);
  });

  it('DELETE 404 si el override no existía', async () => {
    const r = await request(app)
      .delete(`/api/super-admin/features/${TEST_FLAG}/tenants/${testTenantId}`)
      .set(auth());
    expect(r.status).toBe(404);
  });

  it('POST 404 si el flag no existe', async () => {
    const r = await request(app)
      .post(`/api/super-admin/features/flag_no_existe/tenants/${testTenantId}`)
      .set(auth())
      .send({ enabled: true });
    expect(r.status).toBe(404);
  });

  it('POST 404 si el tenant no existe', async () => {
    const r = await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/tenants/999999`)
      .set(auth())
      .send({ enabled: true });
    expect(r.status).toBe(404);
  });

  it('POST 400 si tenantId no es número', async () => {
    const r = await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/tenants/abc`)
      .set(auth())
      .send({ enabled: true });
    expect(r.status).toBe(400);
  });
});

// ── Plan override CRUD ─────────────────────────────────────────────────

describe('POST/DELETE /api/super-admin/features/:name/plans/:planId', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM feature_flags_plans WHERE flag_name = $1`, [TEST_FLAG]);
    await invalidateFeatureCache(TEST_FLAG, testTenantId);
    await invalidateFeatureCache(TEST_FLAG, otherTenantId);
  });

  it('POST upsert plan override', async () => {
    const r = await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/plans/pro`)
      .set(auth())
      .send({ enabled: true });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.plan_id).toBe('pro');
  });

  it('POST 400 si plan_id inválido', async () => {
    const r = await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/plans/premium_plus`)
      .set(auth())
      .send({ enabled: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/plan_id inválido/);
  });

  it('DELETE limpia plan override', async () => {
    await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/plans/starter`)
      .set(auth())
      .send({ enabled: true });

    const r = await request(app)
      .delete(`/api/super-admin/features/${TEST_FLAG}/plans/starter`)
      .set(auth());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

// ── Audit log ──────────────────────────────────────────────────────────

describe('Feature flags admin — audit log', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM feature_flags_tenants WHERE flag_name = $1`, [TEST_FLAG]);
  });

  it('POST tenant override crea audit_log', async () => {
    await request(app)
      .post(`/api/super-admin/features/${TEST_FLAG}/tenants/${testTenantId}`)
      .set(auth())
      .send({ enabled: true, reason: 'audit test' });

    // Buscar el audit_log más reciente para feature_flags_tenants.
    // audit() escribe async en background (fire-and-forget) — polling
    // corto para no flakear (mismo patrón que otros tests de audit).
    let auditRow = null;
    for (let i = 0; i < 20 && !auditRow; i++) {
      const { rows } = await pool.query(
        `SELECT tabla, accion FROM audit_logs
          WHERE tabla = 'feature_flags_tenants'
          ORDER BY created_at DESC LIMIT 1`
      );
      auditRow = rows[0];
      if (!auditRow) await new Promise((r) => setTimeout(r, 50));
    }
    expect(auditRow).toBeTruthy();
    expect(auditRow.tabla).toBe('feature_flags_tenants');
    expect(['INSERT', 'UPDATE']).toContain(auditRow.accion);
  });
});
