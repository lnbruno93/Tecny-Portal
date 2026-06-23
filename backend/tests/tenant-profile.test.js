/**
 * Tests del endpoint /api/tenant-profile (2026-06-22 multi-tenant fix Cotizador).
 *
 * Cubre:
 *   · GET devuelve el perfil del tenant del request (id, nombre, google_*)
 *   · PUT con enabled=true + name + count actualiza correctamente
 *   · PUT con enabled=true SIN name → 400 (regla de coherencia)
 *   · PUT con enabled=false normaliza name/count a null
 *   · PUT como member (no-admin) → 403 (adminOnly gate)
 *   · PUT con count negativo → 400 (schema)
 *
 * El RLS de tenants no aplica per-row (es la tabla master), pero el filtro
 * `WHERE id = req.tenantId` garantiza aislamiento — no testeamos cross-tenant
 * porque el endpoint no acepta tenantId en path/body (lo toma siempre del JWT).
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;
let adminToken;
let memberToken;

beforeAll(async () => {
  pool = await setupTestDb();

  // Admin del tenant 1 (testadmin ya existe del setup, lo logueamos con tenant_rol=admin).
  adminToken = jwt.sign(
    {
      id: 1, username: 'testadmin', email: 'testadmin@test.local',
      role: 'admin', tenant_id: 1, tenant_rol: 'admin',
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256' }
  );

  // Member del tenant 1 — usuario común que debe fallar el PUT.
  // Cleanup defensivo de runs previos antes de insertar.
  await pool.query(`DELETE FROM tenant_users WHERE user_id IN (SELECT id FROM users WHERE username = 'memberuser')`);
  await pool.query(`DELETE FROM users WHERE username = 'memberuser'`);
  const { rows: [memberRow] } = await pool.query(
    // Role 'op' (no 'usuario') — el CHECK constraint solo permite admin|op.
    `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
     VALUES ('Member User', 'memberuser', 'member@test.local', $1, 'op', NOW())
     RETURNING id`,
    [bcrypt.hashSync('pwpw1234', 4)]
  );
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol)
     VALUES (1, $1, 'member')`,
    [memberRow.id]
  );
  memberToken = jwt.sign(
    {
      id: memberRow.id, username: 'memberuser', email: 'member@test.local',
      role: 'op', tenant_id: 1, tenant_rol: 'member',
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256' }
  );

  // Reset del perfil al estado default por las dudas de runs previos.
  await pool.query(
    `UPDATE tenants
        SET google_business_enabled = false,
            google_business_name    = NULL,
            google_reviews_count    = NULL
      WHERE id = 1`
  );
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe('GET /api/tenant-profile', () => {
  it('devuelve { id, nombre, google_business_* } del tenant del JWT', async () => {
    const r = await request(app)
      .get('/api/tenant-profile')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: 1,
      google_business_enabled: false,
      google_business_name: null,
      google_reviews_count: null,
    });
    expect(typeof r.body.nombre).toBe('string');
  });

  it('cualquier miembro autenticado (incluido un member) puede leer', async () => {
    const r = await request(app)
      .get('/api/tenant-profile')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(1);
  });
});

describe('PUT /api/tenant-profile', () => {
  beforeEach(async () => {
    // Reset entre tests para no contaminar.
    await pool.query(
      `UPDATE tenants
          SET google_business_enabled = false,
              google_business_name    = NULL,
              google_reviews_count    = NULL
        WHERE id = 1`
    );
  });

  it('admin actualiza con enabled=true + name + count → 200 + devuelve update', async () => {
    const r = await request(app)
      .put('/api/tenant-profile')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        google_business_enabled: true,
        google_business_name: 'Mi Negocio Tecny',
        google_reviews_count: 150,
      });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      google_business_enabled: true,
      google_business_name: 'Mi Negocio Tecny',
      google_reviews_count: 150,
    });
  });

  it('enabled=true SIN name → 400 con mensaje claro', async () => {
    const r = await request(app)
      .put('/api/tenant-profile')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        google_business_enabled: true,
        google_business_name: '',
        google_reviews_count: 50,
      });
    expect(r.status).toBe(400);
    // El schema rechaza name='' por .min(1). Aceptamos cualquier 400
    // (sea del schema o del guard del handler). El message exacto puede
    // variar entre "Datos inválidos" del wrapper validate o "Si activás
    // Google..." del handler — ambos son OK.
    expect(r.body.error || r.body.message).toBeTruthy();
  });

  it('enabled=false normaliza name/count a null (no preserva valores ocultos)', async () => {
    // Primero seteamos con datos
    await request(app)
      .put('/api/tenant-profile')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        google_business_enabled: true,
        google_business_name: 'A borrar',
        google_reviews_count: 99,
      });

    // Después desactivamos
    const r = await request(app)
      .put('/api/tenant-profile')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        google_business_enabled: false,
      });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      google_business_enabled: false,
      google_business_name: null,
      google_reviews_count: null,
    });
  });

  it('member (no-admin) → 403', async () => {
    const r = await request(app)
      .put('/api/tenant-profile')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        google_business_enabled: true,
        google_business_name: 'Hack',
      });
    expect(r.status).toBe(403);
  });

  it('count negativo → 400 (schema rechaza)', async () => {
    const r = await request(app)
      .put('/api/tenant-profile')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        google_business_enabled: true,
        google_business_name: 'Test',
        google_reviews_count: -5,
      });
    expect(r.status).toBe(400);
  });
});
