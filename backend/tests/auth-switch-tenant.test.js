/**
 * Tests de integración — Multi-tenant switch (task #228, Opción A pragmática).
 *
 * Cubre GET /api/auth/tenants + POST /api/auth/switch-tenant.
 *
 * Setup: crea un user con rows en 2 tenants (simulando el caso super-admin
 * invitado). Valida:
 *   · Happy paths: listar tenants, switch a tenant secundario, JWT contiene
 *     tenant_id correcto, response.user.tenant refleja el tenant nuevo.
 *   · Guards: switch a tenant al que el user NO pertenece (403), switch a
 *     tenant soft-deleted (403), body malformado (400), unauth (401).
 */
const request = require('supertest');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;
const TENANT_A = 9101;
const TENANT_B = 9102;
const TENANT_C = 9103;  // el user NO pertenece a este (usado para test 403)
const USER = { username: 'switch_multi_user', password: 'switchmulti_pass_123' };

beforeAll(async () => {
  pool = await setupTestDb();

  // 3 tenants: A + B (user pertenece) + C (user NO pertenece).
  await pool.query(`
    INSERT INTO tenants (id, nombre, slug, plan) VALUES
      ($1, 'Tenant Switch A', 'switch-a', 'pro'),
      ($2, 'Tenant Switch B', 'switch-b', 'pro'),
      ($3, 'Tenant Switch C', 'switch-c', 'pro')
    ON CONFLICT (id) DO NOTHING
  `, [TENANT_A, TENANT_B, TENANT_C]);
  await pool.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), ${TENANT_C}))`);

  // 1 user, membership en tenant A + B (simula super-admin invitado).
  const hash = await bcrypt.hash(USER.password, 4);
  const { rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role)
     VALUES ('Switch Multi User', $1, $2, $3, 'admin') RETURNING id`,
    [USER.username, `${USER.username}@test.local`, hash]
  );
  USER.id = rows[0].id;

  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner'), ($3, $2, 'admin')`,
    [TENANT_A, USER.id, TENANT_B]
  );
  // Nota: NO metemos al user en TENANT_C — test 403 valida el gate.
});

afterAll(async () => {
  await teardownTestDb(pool);
});

async function login() {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: USER.username, password: USER.password });
  return res.body.token;
}

// ═══════════════════════════════════════════════════════════════
// GET /api/auth/tenants
// ═══════════════════════════════════════════════════════════════
describe('GET /api/auth/tenants', () => {
  it('devuelve lista de tenants del user autenticado', async () => {
    const token = await login();
    const res = await request(app)
      .get('/api/auth/tenants')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tenants)).toBe(true);
    expect(res.body.tenants.length).toBe(2);
    const ids = res.body.tenants.map(t => t.id).sort();
    expect(ids).toEqual([TENANT_A, TENANT_B]);
    // active_tenant_id === el JWT actual (resolveUserTenant elige el menor).
    expect(res.body.active_tenant_id).toBe(TENANT_A);
  });

  it('cada tenant incluye nombre, rol, is_active', async () => {
    const token = await login();
    const res = await request(app)
      .get('/api/auth/tenants')
      .set('Authorization', `Bearer ${token}`);
    const t = res.body.tenants.find(x => x.id === TENANT_A);
    expect(t).toBeTruthy();
    expect(t.nombre).toBe('Tenant Switch A');
    expect(t.rol).toBe('owner');
    expect(t.is_active).toBe(true);
  });

  it('sin token → 401', async () => {
    const res = await request(app).get('/api/auth/tenants');
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════
// POST /api/auth/switch-tenant
// ═══════════════════════════════════════════════════════════════
describe('POST /api/auth/switch-tenant', () => {
  it('switch a tenant secundario → 200 con JWT nuevo cuyo tenant_id = target', async () => {
    const token = await login();
    // Sanity: JWT inicial tiene TENANT_A embebido.
    const initialPayload = jwt.decode(token);
    expect(initialPayload.tenant_id).toBe(TENANT_A);

    const res = await request(app)
      .post('/api/auth/switch-tenant')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenant_id: TENANT_B });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    const newPayload = jwt.decode(res.body.token);
    expect(newPayload.tenant_id).toBe(TENANT_B);
    expect(newPayload.tenant_rol).toBe('admin');  // rol en TENANT_B es 'admin'
    expect(newPayload.id).toBe(USER.id);
  });

  it('response.user.tenant refleja el tenant nuevo (nombre)', async () => {
    const token = await login();
    const res = await request(app)
      .post('/api/auth/switch-tenant')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenant_id: TENANT_B });
    expect(res.body.user).toBeTruthy();
    expect(res.body.user.tenant).toBeTruthy();
    expect(res.body.user.tenant.id).toBe(TENANT_B);
    expect(res.body.user.tenant.nombre).toBe('Tenant Switch B');
  });

  it('switch a tenant al que el user NO pertenece → 403 TENANT_NOT_ACCESSIBLE', async () => {
    const token = await login();
    const res = await request(app)
      .post('/api/auth/switch-tenant')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenant_id: TENANT_C });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT_NOT_ACCESSIBLE');
  });

  it('switch a tenant_id inexistente → 403 (misma respuesta neutra)', async () => {
    const token = await login();
    const res = await request(app)
      .post('/api/auth/switch-tenant')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenant_id: 9999999 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TENANT_NOT_ACCESSIBLE');
  });

  it('switch a tenant soft-deleted → 403', async () => {
    const token = await login();
    // Soft-delete temporal de TENANT_B para el test.
    await pool.query(`UPDATE tenants SET deleted_at = NOW() WHERE id = $1`, [TENANT_B]);
    try {
      const res = await request(app)
        .post('/api/auth/switch-tenant')
        .set('Authorization', `Bearer ${token}`)
        .send({ tenant_id: TENANT_B });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TENANT_NOT_ACCESSIBLE');
    } finally {
      // Restaurar para no romper otros tests.
      await pool.query(`UPDATE tenants SET deleted_at = NULL WHERE id = $1`, [TENANT_B]);
    }
  });

  it('body sin tenant_id → 400 (Zod validate)', async () => {
    const token = await login();
    const res = await request(app)
      .post('/api/auth/switch-tenant')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('tenant_id negativo → 400', async () => {
    const token = await login();
    const res = await request(app)
      .post('/api/auth/switch-tenant')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenant_id: -5 });
    expect(res.status).toBe(400);
  });

  it('sin token → 401', async () => {
    const res = await request(app)
      .post('/api/auth/switch-tenant')
      .send({ tenant_id: TENANT_B });
    expect(res.status).toBe(401);
  });

  it('switch al mismo tenant (idempotente) → 200 con JWT válido', async () => {
    const token = await login();
    const res = await request(app)
      .post('/api/auth/switch-tenant')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenant_id: TENANT_A });  // ya activo
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    const payload = jwt.decode(res.body.token);
    expect(payload.tenant_id).toBe(TENANT_A);
  });
});
