/**
 * Tests integration para Red B2B config (PR-C P1-4a + P1-4b — issue #462).
 *
 * Cobertura:
 *
 *   adminOnly gate (P1-4):
 *     · PATCH /caja-default con tenant_rol='member' + cap cross_tenant.write → 403
 *     · PATCH /caja-default con tenant_rol='admin' → 200 + audit log
 *     · PATCH /email-prefs con tenant_rol='member' → 403
 *     · PATCH /email-prefs con tenant_rol='admin' → 200 + audit log
 *
 *   Audit log con before/after_state (P1-4):
 *     · cross_tenant_caja_default_updated logueado con caja_id antes/después
 *     · cross_tenant_email_prefs_updated logueado con las keys mutadas y
 *       el subset before/after
 *
 *   Nota sobre cross-tenant impersonation:
 *     myTenantId viene del JWT (req.tenantId) — no del body. Un admin del
 *     tenant A no puede mutar el config del tenant B vía este endpoint,
 *     porque el server siempre usa el tenant_id firmado en el token.
 *     No hay test específico para esto porque NO hay vector — el endpoint
 *     no acepta tenant_id como input.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

const TENANT = { slug: 'rb2b-p14-tenant', nombre: 'Red B2B P1-4 Tenant', plan: 'starter' };

let pool;
let tenantId;
let userAdminId, userMemberId;
let tokenAdmin, tokenMember;
let cajaArsId; // id de una metodos_pago para usar en PATCH /caja-default

function signToken({ id, username, email, tenant_id, tenant_rol, caps = {} }) {
  return jwt.sign(
    {
      id, username, email,
      role: 'op',                  // global role: no admin (sólo el tenant_rol importa post 2026-06-16)
      tenant_id,
      tenant_rol,                  // 'owner' | 'admin' | 'member'
      tenant_cap_rol: 'custom',
      caps,                        // capability-fast-path
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

async function createTenant() {
  const r = await pool.query(
    `INSERT INTO tenants (nombre, slug, plan)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre
     RETURNING id`,
    [TENANT.nombre, TENANT.slug, TENANT.plan]
  );
  return r.rows[0].id;
}

async function createUserForTenant(tenantId, { username, email, tenantRol }) {
  const hash = await bcrypt.hash('testpass1234', 10);
  const u = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
     VALUES ($1, $2, $3, $4, 'op', NOW())
     RETURNING id`,
    [username, username, email, hash]
  );
  const userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, tenantRol]
  );
  return userId;
}

async function cleanup() {
  await pool.query(
    `DELETE FROM tenant_admin_actions
       WHERE tenant_id = $1
         AND action IN ('cross_tenant_caja_default_updated', 'cross_tenant_email_prefs_updated')`,
    [tenantId]
  );
  await pool.query(
    `DELETE FROM users WHERE username IN ($1, $2)`,
    ['rb2b-p14-admin', 'rb2b-p14-member']
  );
  await pool.query(`DELETE FROM tenants WHERE slug = $1`, [TENANT.slug]);
}

beforeAll(async () => {
  pool = await setupTestDb();

  tenantId = await createTenant();

  userAdminId = await createUserForTenant(tenantId, {
    username: 'rb2b-p14-admin', email: 'rb2b-p14-admin@test.local',
    tenantRol: 'admin',
  });
  userMemberId = await createUserForTenant(tenantId, {
    username: 'rb2b-p14-member', email: 'rb2b-p14-member@test.local',
    tenantRol: 'member',
  });

  // Ambos users tienen cap cross_tenant.write — el adminOnly debe ser el
  // ÚNICO blocker del member, no la cap.
  const capsOn = { 'cross_tenant.write': true };
  tokenAdmin = signToken({
    id: userAdminId, username: 'rb2b-p14-admin', email: 'rb2b-p14-admin@test.local',
    tenant_id: tenantId, tenant_rol: 'admin', caps: capsOn,
  });
  tokenMember = signToken({
    id: userMemberId, username: 'rb2b-p14-member', email: 'rb2b-p14-member@test.local',
    tenant_id: tenantId, tenant_rol: 'member', caps: capsOn,
  });

  // Lookup una caja ARS activa para PATCH /caja-default.
  const cajaQ = await pool.query(
    `SELECT id FROM metodos_pago
       WHERE moneda = 'ARS' AND activo = true AND deleted_at IS NULL
       ORDER BY id LIMIT 1`
  );
  cajaArsId = cajaQ.rows[0].id;
});

afterAll(async () => {
  await cleanup();
  await teardownTestDb(pool);
});

// Cleanup entre tests: borrar audit rows + resetear config.
beforeEach(async () => {
  await pool.query(
    `DELETE FROM tenant_admin_actions
       WHERE tenant_id = $1
         AND action IN ('cross_tenant_caja_default_updated', 'cross_tenant_email_prefs_updated')`,
    [tenantId]
  );
  // red_b2b_email_prefs es NOT NULL en el schema (default JSONB con todas
  // las prefs en true) — reseteamos al objeto vacío para que las pruebas
  // verifiquen el merge con DEFAULT_EMAIL_PREFS desde un baseline limpio.
  await pool.query(
    `UPDATE tenants
        SET red_b2b_caja_default_id = NULL,
            red_b2b_email_prefs = '{}'::jsonb
      WHERE id = $1`,
    [tenantId]
  );
});

// ──────────────────────────────────────────────────────────────────────────
// P1-4b — PATCH /caja-default
// ──────────────────────────────────────────────────────────────────────────
describe('PATCH /api/red-b2b/config/caja-default — adminOnly + audit', () => {
  it('member con cap cross_tenant.write → 403 (adminOnly bloquea)', async () => {
    const r = await request(app)
      .patch('/api/red-b2b/config/caja-default')
      .set('Authorization', `Bearer ${tokenMember}`)
      .send({ caja_id: cajaArsId });
    expect(r.status).toBe(403);
    // Verificar que NO se persistió el cambio.
    const t = await pool.query(
      `SELECT red_b2b_caja_default_id FROM tenants WHERE id = $1`,
      [tenantId]
    );
    expect(t.rows[0].red_b2b_caja_default_id).toBe(null);
    // Y que NO hay audit row.
    const audit = await pool.query(
      `SELECT id FROM tenant_admin_actions
         WHERE tenant_id = $1 AND action = 'cross_tenant_caja_default_updated'`,
      [tenantId]
    );
    expect(audit.rows.length).toBe(0);
  });

  it('admin → 200 + persiste caja_default_id + audit log con before/after', async () => {
    const r = await request(app)
      .patch('/api/red-b2b/config/caja-default')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ caja_id: cajaArsId });
    expect(r.status).toBe(200);
    expect(r.body.caja_default_id).toBe(cajaArsId);

    // Persistió en la tabla.
    const t = await pool.query(
      `SELECT red_b2b_caja_default_id FROM tenants WHERE id = $1`,
      [tenantId]
    );
    expect(t.rows[0].red_b2b_caja_default_id).toBe(cajaArsId);

    // Audit row con before/after.
    const audit = await pool.query(
      `SELECT action, before_state, after_state, super_admin_user_id
         FROM tenant_admin_actions
         WHERE tenant_id = $1 AND action = 'cross_tenant_caja_default_updated'
         ORDER BY created_at DESC LIMIT 1`,
      [tenantId]
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].super_admin_user_id).toBe(userAdminId);
    expect(audit.rows[0].before_state).toEqual({ caja_default_id: null });
    expect(audit.rows[0].after_state).toEqual({ caja_default_id: cajaArsId });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// P1-4a — PATCH /email-prefs
// ──────────────────────────────────────────────────────────────────────────
describe('PATCH /api/red-b2b/config/email-prefs — adminOnly + audit', () => {
  it('member con cap cross_tenant.write → 403 (adminOnly bloquea)', async () => {
    const r = await request(app)
      .patch('/api/red-b2b/config/email-prefs')
      .set('Authorization', `Bearer ${tokenMember}`)
      .send({ invitation_received: false });
    expect(r.status).toBe(403);

    // Verificar que NO se persistió el cambio (el reset del beforeEach
    // dejó '{}'::jsonb, así que el flag invitation_received NO debe estar
    // presente con valor false).
    const t = await pool.query(
      `SELECT red_b2b_email_prefs FROM tenants WHERE id = $1`,
      [tenantId]
    );
    expect(t.rows[0].red_b2b_email_prefs.invitation_received).toBeUndefined();
    // Y que NO hay audit row.
    const audit = await pool.query(
      `SELECT id FROM tenant_admin_actions
         WHERE tenant_id = $1 AND action = 'cross_tenant_email_prefs_updated'`,
      [tenantId]
    );
    expect(audit.rows.length).toBe(0);
  });

  it('admin → 200 + persiste prefs + audit log con updated_keys/before/after', async () => {
    const r = await request(app)
      .patch('/api/red-b2b/config/email-prefs')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ invitation_received: false, payment_received: false });
    expect(r.status).toBe(200);
    expect(r.body.email_prefs.invitation_received).toBe(false);
    expect(r.body.email_prefs.payment_received).toBe(false);
    // Las otras prefs no mutadas conservan default true (merge con DEFAULT_EMAIL_PREFS).
    expect(r.body.email_prefs.invitation_accepted).toBe(true);

    // Persistió.
    const t = await pool.query(
      `SELECT red_b2b_email_prefs FROM tenants WHERE id = $1`,
      [tenantId]
    );
    expect(t.rows[0].red_b2b_email_prefs.invitation_received).toBe(false);
    expect(t.rows[0].red_b2b_email_prefs.payment_received).toBe(false);

    // Audit row.
    const audit = await pool.query(
      `SELECT action, before_state, after_state, super_admin_user_id
         FROM tenant_admin_actions
         WHERE tenant_id = $1 AND action = 'cross_tenant_email_prefs_updated'
         ORDER BY created_at DESC LIMIT 1`,
      [tenantId]
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].super_admin_user_id).toBe(userAdminId);

    const before = audit.rows[0].before_state;
    const after = audit.rows[0].after_state;
    expect(before.updated_keys.sort()).toEqual(['invitation_received', 'payment_received']);
    expect(after.updated_keys.sort()).toEqual(['invitation_received', 'payment_received']);
    // before tenía defaults true; after tiene false en ambas.
    expect(before.prefs.invitation_received).toBe(true);
    expect(after.prefs.invitation_received).toBe(false);
    expect(before.prefs.payment_received).toBe(true);
    expect(after.prefs.payment_received).toBe(false);
  });
});
