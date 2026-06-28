/**
 * Tests focalizados del helper `resolveOwnerEmail` de redB2bEmail.
 *
 * Issue #462 — TANDA 0 PR-C P0-4: el query ignoraba users.deleted_at, así
 * que un owner soft-deleted seguía recibiendo TODOS los emails Red B2B
 * (invitaciones, ops, pagos cross-tenant). Tras transferencia de cuenta,
 * el ex-dueño recibía notificaciones de operaciones que ya no le
 * correspondían.
 *
 * Tests requeridos por el plan PR-C:
 *   1. Owner soft-deleted (deleted_at != NULL) → NO devuelve ese user.
 *   2. Owner activo (deleted_at IS NULL) → devuelve ese user.
 *   3. Solo hay owners soft-deleted + admins activos → devuelve el admin.
 *   4. Sin ningún owner/admin activo → devuelve { email: null }.
 *
 * Setup acotado: creamos 1 tenant `rb2b-p04` con 0-2 users según test
 * (cleanup en afterEach borra solo nuestro tenant + users).
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const bcrypt = require('bcrypt');
const redB2bEmail = require('../src/lib/redB2bEmail');

const TENANT_SLUG  = 'rb2b-p04';
const TENANT_NAME  = 'Red B2B P0-4 Test';
const USERNAME_OWNER  = 'rb2b-p04-owner';
const USERNAME_ADMIN  = 'rb2b-p04-admin';
const EMAIL_OWNER     = 'rb2b-p04-owner@test.local';
const EMAIL_ADMIN     = 'rb2b-p04-admin@test.local';

let pool;
let tenantId;

async function createTenant() {
  const r = await pool.query(
    `INSERT INTO tenants (nombre, slug, plan)
     VALUES ($1, $2, 'starter')
     ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre
     RETURNING id`,
    [TENANT_NAME, TENANT_SLUG]
  );
  return r.rows[0].id;
}

async function createUser({ username, email, rol, tenantId, softDeleted = false }) {
  const hash = await bcrypt.hash('testpass1234', 10);
  const u = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at, deleted_at)
     VALUES ($1, $2, $3, $4, 'op', NOW(), ${softDeleted ? 'NOW()' : 'NULL'})
     RETURNING id`,
    [username, username, email, hash]
  );
  const userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, rol]
  );
  return userId;
}

async function cleanupUsersAndTenant() {
  // Borrar users de prueba (cascadea tenant_users + tenant_user_roles via FK).
  await pool.query(
    `DELETE FROM users WHERE username IN ($1, $2)`,
    [USERNAME_OWNER, USERNAME_ADMIN]
  );
  // Borrar tenant (los tenant_users ya cayeron arriba; no hay más data).
  await pool.query(`DELETE FROM tenants WHERE slug = $1`, [TENANT_SLUG]);
}

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await cleanupUsersAndTenant();
  await teardownTestDb(pool);
});

beforeEach(async () => {
  await cleanupUsersAndTenant();
  tenantId = await createTenant();
});

describe('resolveOwnerEmail — PR-C P0-4 filtro users.deleted_at', () => {
  it('1. Owner soft-deleted (deleted_at != NULL) → NO lo devuelve', async () => {
    await createUser({
      username: USERNAME_OWNER, email: EMAIL_OWNER, rol: 'owner', tenantId,
      softDeleted: true,
    });

    const result = await redB2bEmail.resolveOwnerEmail(tenantId);
    expect(result.email).toBe(null);
    expect(result.name).toBe(null);
  });

  it('2. Owner activo (deleted_at IS NULL) → devuelve el owner', async () => {
    await createUser({
      username: USERNAME_OWNER, email: EMAIL_OWNER, rol: 'owner', tenantId,
      softDeleted: false,
    });

    const result = await redB2bEmail.resolveOwnerEmail(tenantId);
    expect(result.email).toBe(EMAIL_OWNER);
  });

  it('3. Owner soft-deleted + admin activo → devuelve el admin (no el ex-owner)', async () => {
    await createUser({
      username: USERNAME_OWNER, email: EMAIL_OWNER, rol: 'owner', tenantId,
      softDeleted: true,  // owner saliendo
    });
    await createUser({
      username: USERNAME_ADMIN, email: EMAIL_ADMIN, rol: 'admin', tenantId,
      softDeleted: false, // admin remplazante
    });

    const result = await redB2bEmail.resolveOwnerEmail(tenantId);
    expect(result.email).toBe(EMAIL_ADMIN);
    // Y específicamente NO el ex-owner.
    expect(result.email).not.toBe(EMAIL_OWNER);
  });

  it('4. Sin ningún owner/admin activo → devuelve { email: null }', async () => {
    // Solo un member (no debe matchear).
    await createUser({
      username: USERNAME_OWNER, email: EMAIL_OWNER, rol: 'member', tenantId,
      softDeleted: false,
    });

    const result = await redB2bEmail.resolveOwnerEmail(tenantId);
    expect(result.email).toBe(null);
  });

  it('4b. Solo owners soft-deleted + sin admins → devuelve { email: null }', async () => {
    // Caso extremo: el owner se borró y nadie tomó el lugar.
    await createUser({
      username: USERNAME_OWNER, email: EMAIL_OWNER, rol: 'owner', tenantId,
      softDeleted: true,
    });

    const result = await redB2bEmail.resolveOwnerEmail(tenantId);
    expect(result.email).toBe(null);
  });
});
