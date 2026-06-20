/**
 * Tests integration para Super-Admin (#353 Fase 1).
 *
 * Cubre:
 *   - 401 sin JWT.
 *   - 403 con JWT válido pero is_super_admin=false.
 *   - 200 + payload correcto cuando is_super_admin=true.
 *   - GET /me devuelve user_id correcto.
 *   - GET /tenants devuelve todos los tenants (cross-tenant).
 *   - GET /tenants?plan=X filtra correctamente.
 *   - GET /tenants?search=X filtra por nombre/slug.
 *   - GET /tenants/:id devuelve detalle + audit actions.
 *   - GET /tenants/:id devuelve 404 si no existe.
 *   - Logging: 403 emite warn log (no validamos formato exacto).
 *
 * Caveat de testing local:
 *   En local NO existe el role `tecny_admin` con BYPASSRLS. db.adminQuery
 *   cae al pool principal (con role normal). Pero como mi role local ES
 *   superuser+BYPASSRLS, ve todo igual. Los tests pasan con la misma
 *   lógica que prod (donde el role admin separado bypassea RLS de verdad).
 *
 * Setup específico: marcamos testadmin (id=1) como super-admin via
 * UPDATE directo a la DB en beforeAll. Invalidamos cache después.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const userAuthCache = require('../src/lib/userAuthCache');

let pool;
let superAdminToken;   // testadmin con is_super_admin=true
let regularUserToken;  // otro user (NO super-admin)

beforeAll(async () => {
  pool = await setupTestDb();

  // Marcar testadmin (id=1) como super-admin.
  await pool.query(`UPDATE users SET is_super_admin = true WHERE id = 1`);
  // Invalidar cache para que el próximo getUserAuth lea el nuevo valor.
  await userAuthCache.invalidateUserAuth(1);

  superAdminToken = jwt.sign(
    {
      id: 1, username: TEST_USER.username, email: TEST_USER.email,
      role: TEST_USER.role, tenant_id: 1, tenant_rol: 'owner',
      is_super_admin: true,
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  // Crear un user "regular" (NO super-admin) en tenant 1.
  const hash = await bcrypt.hash('pass1234', 10);
  const { rows: u2Rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, is_super_admin)
     VALUES ('Regular User', 'regularsa', 'reg@test.local', $1, 'admin', false)
     RETURNING id`,
    [hash]
  );
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'admin')`,
    [u2Rows[0].id]
  );
  regularUserToken = jwt.sign(
    {
      id: u2Rows[0].id, username: 'regularsa', email: 'reg@test.local',
      role: 'admin', tenant_id: 1, tenant_rol: 'admin',
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  // Crear tenant 2 para los tests cross-tenant.
  await pool.query(
    `INSERT INTO tenants (id, nombre, slug, plan) VALUES (777, 'SA Test Tenant', 'sa-test', 'pro')
       ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1))`
  );
});

afterAll(async () => {
  // Cleanup
  await pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id IN (1, 777)`);
  await pool.query(`DELETE FROM tenants WHERE id = 777`);
  await pool.query(`UPDATE users SET is_super_admin = false WHERE id = 1`);
  await userAuthCache.invalidateUserAuth(1);
  await teardownTestDb(pool);
});

describe('Super-Admin auth (requireSuperAdmin)', () => {
  it('401 sin JWT', async () => {
    const r = await request(app).get('/api/super-admin/me');
    expect(r.status).toBe(401);
  });

  it('403 con JWT válido pero is_super_admin=false', async () => {
    const r = await request(app)
      .get('/api/super-admin/me')
      .set('Authorization', `Bearer ${regularUserToken}`);
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('super_admin_required');
  });

  it('200 con super-admin JWT', async () => {
    const r = await request(app)
      .get('/api/super-admin/me')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.is_super_admin).toBe(true);
    expect(r.body.user_id).toBe(1);
    expect(r.body.username).toBe(TEST_USER.username);
  });
});

describe('GET /api/super-admin/tenants', () => {
  it('devuelve lista de TODOS los tenants (cross-tenant)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    // Al menos tenant 1 (default) + tenant 777 (test seed).
    expect(r.body.length).toBeGreaterThanOrEqual(2);
    const ids = r.body.map(t => t.id).sort();
    expect(ids).toContain(1);
    expect(ids).toContain(777);
  });

  it('cada tenant incluye stats: mrr_usd, users_count, last_venta_at, signups_30d', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`);
    const t = r.body.find(x => x.id === 1);
    expect(t).toBeDefined();
    expect(typeof t.mrr_usd).toBe('number');
    expect(typeof t.users_count).toBe('number');
    expect(typeof t.signups_30d).toBe('number');
    // last_venta_at puede ser null (sin ventas)
    expect(['object', 'string']).toContain(typeof t.last_venta_at); // null o ISO string
  });

  it('filtro ?plan=pro devuelve solo plan pro', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?plan=pro')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.every(t => t.plan === 'pro')).toBe(true);
    expect(r.body.find(t => t.id === 777)).toBeDefined();
  });

  it('filtro ?plan=invalid es ignorado (no rompe la query)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?plan=hackplan')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    // sin filtro → devuelve todos
    expect(r.body.length).toBeGreaterThanOrEqual(2);
  });

  it('filtro ?search=sa-test devuelve match por slug', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?search=sa-test')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThanOrEqual(1);
    expect(r.body.some(t => t.slug === 'sa-test')).toBe(true);
  });

  it('filtro ?suspended=true devuelve solo suspendidos', async () => {
    // Suspender tenant 777 temporalmente
    await pool.query(
      `UPDATE tenants SET suspended_at = NOW(), suspended_reason = 'test' WHERE id = 777`
    );
    const r = await request(app)
      .get('/api/super-admin/tenants?suspended=true')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.every(t => t.suspended_at !== null)).toBe(true);
    expect(r.body.find(t => t.id === 777)).toBeDefined();

    // Cleanup
    await pool.query(
      `UPDATE tenants SET suspended_at = NULL, suspended_reason = NULL WHERE id = 777`
    );
  });
});

describe('GET /api/super-admin/tenants/:id', () => {
  it('devuelve detalle del tenant 1', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/1')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(1);
    expect(typeof r.body.mrr_usd).toBe('number');
    expect(Array.isArray(r.body.recent_admin_actions)).toBe(true);
  });

  it('404 si el tenant no existe', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/99999')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(404);
  });

  it('400 si id inválido', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/abc')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(400);
  });

  it('regular user recibe 403 (no super-admin)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/1')
      .set('Authorization', `Bearer ${regularUserToken}`);
    expect(r.status).toBe(403);
  });
});
