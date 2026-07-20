/**
 * Tests del resolver de feature flags per-tenant (F1 Rec proactiva #3
 * post-audit 2026-07-20).
 *
 * Design doc: docs/design/feature-flags-per-tenant.md
 * Lib: backend/src/lib/featureFlags.js
 *
 * Cobertura:
 *   ── Hash bucketing (bucketFor)
 *      · Determinístico: mismo input → mismo bucket siempre.
 *      · Distribución uniforme: >1000 tenants → ~10% en cada bucket de 10.
 *      · Independencia por flag: bucket(flagA, t) ≠ bucket(flagB, t) para
 *        la mayoría de tenants.
 *
 *   ── Precedencia del resolver (isFeatureEnabled)
 *      · Tenant override gana sobre plan / rollout / global.
 *      · Plan override gana sobre rollout / global.
 *      · Rollout gana sobre global.
 *      · Sin overrides ni rollout → default global.
 *      · Flag inexistente → false (fail-closed).
 *
 *   ── Casos especiales
 *      · Tenant override ON con global OFF (canary).
 *      · Tenant override OFF con global ON (kill switch).
 *      · tenantId=null → solo global.
 *      · Rollout 0% → siempre false para ese flag.
 *      · Rollout 100% → siempre true.
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const {
  isFeatureEnabled,
  invalidateFeatureCache,
  bucketFor,
} = require('../src/lib/featureFlags');

let pool;
let testTenantId;
let otherTenantId;

// Seed helpers ────────────────────────────────────────────────────────

async function ensureFlag(name, enabled = false, rolloutPct = null) {
  await pool.query(
    `INSERT INTO feature_flags (name, enabled, rollout_pct, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE
        SET enabled = EXCLUDED.enabled,
            rollout_pct = EXCLUDED.rollout_pct,
            updated_at = NOW()`,
    [name, enabled, rolloutPct, 'test flag']
  );
  // Cache invalidation entre tests para evitar cross-talk vía Redis.
  await invalidateFeatureCache(name, testTenantId);
  await invalidateFeatureCache(name, otherTenantId);
}

async function setTenantOverride(name, tenantId, enabled) {
  await pool.query(
    `INSERT INTO feature_flags_tenants (flag_name, tenant_id, enabled, reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (flag_name, tenant_id) DO UPDATE
        SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
    [name, tenantId, enabled, 'test override']
  );
  await invalidateFeatureCache(name, tenantId);
}

async function setPlanOverride(name, planId, enabled) {
  await pool.query(
    `INSERT INTO feature_flags_plans (flag_name, plan_id, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (flag_name, plan_id) DO UPDATE
        SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
    [name, planId, enabled]
  );
  await invalidateFeatureCache(name, testTenantId);
  await invalidateFeatureCache(name, otherTenantId);
}

async function setTenantPlan(tenantId, plan) {
  await pool.query(`UPDATE tenants SET plan = $1 WHERE id = $2`, [plan, tenantId]);
}

async function cleanFlag(name) {
  // ON DELETE CASCADE limpia feature_flags_tenants + feature_flags_plans.
  await pool.query(`DELETE FROM feature_flags WHERE name = $1`, [name]);
}

// Setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  pool = await setupTestDb();
  testTenantId = 1; // TEST_USER tenant

  // Crear un tenant secundario para tests de distribución de rollout.
  // slug es NOT NULL en tenants — generamos uno único con timestamp.
  const slug = `ff-test-${Date.now()}`;
  const { rows } = await pool.query(
    `INSERT INTO tenants (nombre, slug, plan)
     VALUES ($1, $2, $3)
     RETURNING id`,
    ['Other Tenant FF Test', slug, 'starter']
  );
  otherTenantId = rows[0].id;
});

afterAll(async () => {
  // Cleanup del tenant secundario.
  if (otherTenantId) {
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [otherTenantId]);
  }
  await teardownTestDb(pool);
});

// ── bucketFor: hash determinístico ─────────────────────────────────────

describe('bucketFor — hash determinístico', () => {
  it('mismo input → mismo bucket (1000 iteraciones)', () => {
    const first = bucketFor('any_flag', 42);
    for (let i = 0; i < 1000; i++) {
      expect(bucketFor('any_flag', 42)).toBe(first);
    }
  });

  it('bucket siempre en rango [0, 99]', () => {
    for (let i = 1; i <= 500; i++) {
      const b = bucketFor('some_flag', i);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(99);
    }
  });

  it('distribución uniforme: 1000 tenants → ~10% en cada bucket de 10', () => {
    const buckets = new Array(10).fill(0);
    for (let t = 1; t <= 1000; t++) {
      const b = bucketFor('rollout_test', t);
      buckets[Math.floor(b / 10)]++;
    }
    // Cada bucket de 10% debería tener ~100 (±30% margen para no flakear).
    // sha256 tiene distribución excelente, en la práctica el rango es <5%.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(70);
      expect(count).toBeLessThan(130);
    }
  });

  it('independencia por flag: bucketFor(flagA, t) != bucketFor(flagB, t) en la mayoría', () => {
    // No es garantizado que TODOS los tenants tengan bucket distinto entre 2
    // flags, pero >90% debería. Si el hash fuera dependiente solo de tenantId
    // (bug), el 100% sería igual.
    let sameCount = 0;
    for (let t = 1; t <= 200; t++) {
      if (bucketFor('flag_a', t) === bucketFor('flag_b', t)) sameCount++;
    }
    // Esperamos ~1% (colisión random). Si es >10% hay bug.
    expect(sameCount).toBeLessThan(20);
  });
});

// ── Precedencia ────────────────────────────────────────────────────────

describe('isFeatureEnabled — precedencia', () => {
  const FLAG = 'test_precedencia';

  afterEach(async () => {
    await cleanFlag(FLAG);
  });

  it('sin flag en DB → false (fail-closed)', async () => {
    expect(await isFeatureEnabled('flag_que_no_existe', testTenantId, { skipCache: true })).toBe(false);
  });

  it('flag global OFF, sin overrides → false', async () => {
    await ensureFlag(FLAG, false);
    expect(await isFeatureEnabled(FLAG, testTenantId, { skipCache: true })).toBe(false);
  });

  it('flag global ON, sin overrides → true', async () => {
    await ensureFlag(FLAG, true);
    expect(await isFeatureEnabled(FLAG, testTenantId, { skipCache: true })).toBe(true);
  });

  it('override tenant ON gana sobre global OFF (canary)', async () => {
    await ensureFlag(FLAG, false);
    await setTenantOverride(FLAG, testTenantId, true);
    expect(await isFeatureEnabled(FLAG, testTenantId, { skipCache: true })).toBe(true);
    // Otro tenant sin override sigue en el default global (OFF).
    expect(await isFeatureEnabled(FLAG, otherTenantId, { skipCache: true })).toBe(false);
  });

  it('override tenant OFF gana sobre global ON (kill switch)', async () => {
    await ensureFlag(FLAG, true);
    await setTenantOverride(FLAG, testTenantId, false);
    expect(await isFeatureEnabled(FLAG, testTenantId, { skipCache: true })).toBe(false);
    expect(await isFeatureEnabled(FLAG, otherTenantId, { skipCache: true })).toBe(true);
  });

  it('override plan gana sobre rollout y global', async () => {
    // Global OFF, rollout 100% (=> serían todos true por rollout),
    // pero plan='starter' override OFF debería ganar.
    await ensureFlag(FLAG, false, 100);
    await setTenantPlan(otherTenantId, 'starter');
    await setPlanOverride(FLAG, 'starter', false);
    expect(await isFeatureEnabled(FLAG, otherTenantId, { skipCache: true })).toBe(false);
  });

  it('override tenant gana sobre override plan', async () => {
    // Plan starter con override ON, pero tenant override OFF debe ganar.
    await ensureFlag(FLAG, false);
    await setTenantPlan(otherTenantId, 'starter');
    await setPlanOverride(FLAG, 'starter', true);
    await setTenantOverride(FLAG, otherTenantId, false);
    expect(await isFeatureEnabled(FLAG, otherTenantId, { skipCache: true })).toBe(false);
  });

  it('rollout 100% → siempre true (sobrescribe enabled=false)', async () => {
    await ensureFlag(FLAG, false, 100);
    // Cualquier tenant debe estar dentro (bucket < 100).
    expect(await isFeatureEnabled(FLAG, testTenantId, { skipCache: true })).toBe(true);
    expect(await isFeatureEnabled(FLAG, otherTenantId, { skipCache: true })).toBe(true);
  });

  it('rollout 0% → siempre false', async () => {
    await ensureFlag(FLAG, true, 0);
    // Rollout 0 significa "nadie" — sobrescribe el enabled=true.
    expect(await isFeatureEnabled(FLAG, testTenantId, { skipCache: true })).toBe(false);
    expect(await isFeatureEnabled(FLAG, otherTenantId, { skipCache: true })).toBe(false);
  });

  it('rollout 50% → ~50% de tenants sintéticos activos', async () => {
    // Test estadístico: no assertamos qué tenant específico está in, solo
    // que la distribución es ~50%.
    await ensureFlag(FLAG, false, 50);
    let inCount = 0;
    for (let t = 1; t <= 200; t++) {
      if (await isFeatureEnabled(FLAG, t, { skipCache: true })) inCount++;
    }
    // Esperamos ~100 ± 30 con la varianza natural de hash sobre 200 tenants.
    expect(inCount).toBeGreaterThan(70);
    expect(inCount).toBeLessThan(130);
  });
});

// ── Casos especiales ───────────────────────────────────────────────────

describe('isFeatureEnabled — casos especiales', () => {
  const FLAG = 'test_casos_especiales';

  afterEach(async () => {
    await cleanFlag(FLAG);
  });

  it('tenantId=null → resuelve solo el global', async () => {
    await ensureFlag(FLAG, true);
    expect(await isFeatureEnabled(FLAG, null, { skipCache: true })).toBe(true);
    await ensureFlag(FLAG, false);
    expect(await isFeatureEnabled(FLAG, null, { skipCache: true })).toBe(false);
  });

  it('flagName vacío o inválido → false sin tirar', async () => {
    expect(await isFeatureEnabled('', testTenantId)).toBe(false);
    expect(await isFeatureEnabled(null, testTenantId)).toBe(false);
    expect(await isFeatureEnabled(undefined, testTenantId)).toBe(false);
  });

  it('override tenant se elimina si el flag se borra (CASCADE)', async () => {
    await ensureFlag(FLAG, false);
    await setTenantOverride(FLAG, testTenantId, true);
    expect(await isFeatureEnabled(FLAG, testTenantId, { skipCache: true })).toBe(true);

    // Borrar el flag → CASCADE limpia overrides.
    await cleanFlag(FLAG);
    // Sin flag ni override → false.
    expect(await isFeatureEnabled(FLAG, testTenantId, { skipCache: true })).toBe(false);

    // Verificar via DB directo que la tabla de overrides quedó limpia.
    const { rows } = await pool.query(
      `SELECT 1 FROM feature_flags_tenants WHERE flag_name = $1`,
      [FLAG]
    );
    expect(rows).toHaveLength(0);
  });
});
