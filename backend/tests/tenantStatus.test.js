/**
 * Tests del helper tenantStatus + integración en requireAuth
 * (TANDA 4 billing pre-live 2026-06-25).
 *
 * Cubre 3 dimensiones:
 *   1. getTenantStatus() — lectura, is_active flag, semántica NULL.
 *   2. invalidateTenantStatus() — DEL cache cross-instance.
 *   3. Integración requireAuth — write methods con tenant expirado → 402,
 *      read methods siempre OK, /api/auth/* sin gating.
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const { getTenantStatus, invalidateTenantStatus } = require('../src/lib/tenantStatus');

let pool;
let adminToken;

beforeAll(async () => {
  pool = await setupTestDb();
  const r = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = r.body.token;
});

afterAll(async () => {
  // Restaurar tenant 1 a paid_until = NULL (grandfathered) para no romper
  // otras suites que corran después.
  await pool.query(`UPDATE tenants SET paid_until = NULL, suspended_at = NULL WHERE id = 1`);
  await teardownTestDb(pool);
});

beforeEach(async () => {
  // Cada test parte del tenant 1 limpio: paid_until NULL (activo grandfathered).
  await pool.query(`UPDATE tenants SET paid_until = NULL, suspended_at = NULL WHERE id = 1`);
  await invalidateTenantStatus(1);
});

describe('getTenantStatus — semántica', () => {
  it('paid_until NULL → is_active=true (grandfathered)', async () => {
    const s = await getTenantStatus(1);
    expect(s).toMatchObject({ id: 1, paid_until: null, is_active: true });
  });

  it('paid_until en futuro → is_active=true', async () => {
    await pool.query(`UPDATE tenants SET paid_until = CURRENT_DATE + INTERVAL '30 days' WHERE id = 1`);
    await invalidateTenantStatus(1);
    const s = await getTenantStatus(1);
    expect(s.is_active).toBe(true);
  });

  it('paid_until en pasado → is_active=false', async () => {
    await pool.query(`UPDATE tenants SET paid_until = CURRENT_DATE - INTERVAL '1 day' WHERE id = 1`);
    await invalidateTenantStatus(1);
    const s = await getTenantStatus(1);
    expect(s.is_active).toBe(false);
  });

  it('paid_until = hoy → is_active=true (último día válido)', async () => {
    await pool.query(`UPDATE tenants SET paid_until = CURRENT_DATE WHERE id = 1`);
    await invalidateTenantStatus(1);
    const s = await getTenantStatus(1);
    expect(s.is_active).toBe(true);
  });

  it('suspended_at != NULL → is_active=false aunque paid_until OK', async () => {
    await pool.query(`
      UPDATE tenants
         SET paid_until = CURRENT_DATE + INTERVAL '30 days',
             suspended_at = NOW()
       WHERE id = 1
    `);
    await invalidateTenantStatus(1);
    const s = await getTenantStatus(1);
    expect(s.is_active).toBe(false);
    expect(s.suspended_at).not.toBeNull();
  });

  it('tenant inexistente → null', async () => {
    const s = await getTenantStatus(999999);
    expect(s).toBeNull();
  });
});

describe('requireAuth — gating de tenant expirado', () => {
  it('GET pasa aunque tenant esté expirado (read-only allowed)', async () => {
    await pool.query(`UPDATE tenants SET paid_until = CURRENT_DATE - INTERVAL '1 day' WHERE id = 1`);
    await invalidateTenantStatus(1);

    const r = await request(app)
      .get('/api/inventario/categorias')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
  });

  it('POST en tenant expirado → 402 TENANT_EXPIRED', async () => {
    await pool.query(`UPDATE tenants SET paid_until = CURRENT_DATE - INTERVAL '1 day' WHERE id = 1`);
    await invalidateTenantStatus(1);

    const r = await request(app)
      .post('/api/inventario/categorias')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'TEST_EXPIRED' });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('TENANT_EXPIRED');
    expect(r.body.paid_until).toBeTruthy();
  });

  it('POST en tenant suspendido → 402 TENANT_SUSPENDED', async () => {
    await pool.query(`
      UPDATE tenants
         SET paid_until = CURRENT_DATE + INTERVAL '30 days',
             suspended_at = NOW()
       WHERE id = 1
    `);
    await invalidateTenantStatus(1);

    const r = await request(app)
      .post('/api/inventario/categorias')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'TEST_SUSPENDED' });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('TENANT_SUSPENDED');
  });

  it('POST en tenant activo (paid_until NULL) → pasa', async () => {
    // Estado default del beforeEach: paid_until=NULL → activo grandfathered.
    const r = await request(app)
      .post('/api/inventario/categorias')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'TEST_ACTIVE_GRANDFATHERED' });
    expect(r.status).toBe(201);
    // Cleanup
    await pool.query(`DELETE FROM categorias WHERE nombre = 'TEST_ACTIVE_GRANDFATHERED'`);
  });

  it('PUT en tenant expirado → 402', async () => {
    await pool.query(`UPDATE tenants SET paid_until = CURRENT_DATE - INTERVAL '1 day' WHERE id = 1`);
    await invalidateTenantStatus(1);

    const r = await request(app)
      .put('/api/inventario/categorias/999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'x' });
    expect(r.status).toBe(402);
  });

  it('DELETE en tenant expirado → 402', async () => {
    await pool.query(`UPDATE tenants SET paid_until = CURRENT_DATE - INTERVAL '1 day' WHERE id = 1`);
    await invalidateTenantStatus(1);

    const r = await request(app)
      .delete('/api/inventario/categorias/999999')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r.status).toBe(402);
  });

  it('change-password (auth route) NO se gatea aunque tenant esté expirado', async () => {
    await pool.query(`UPDATE tenants SET paid_until = CURRENT_DATE - INTERVAL '1 day' WHERE id = 1`);
    await invalidateTenantStatus(1);

    // POST a auth route con body inválido — debe rebotar por validación,
    // NO por 402. Eso prueba que el gating no se aplicó.
    const r = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(r.status).not.toBe(402);
  });
});

describe('invalidateTenantStatus — invalidación', () => {
  it('cambio de paid_until + invalidate refleja en próximo get', async () => {
    let s = await getTenantStatus(1);
    expect(s.is_active).toBe(true);

    await pool.query(`UPDATE tenants SET paid_until = CURRENT_DATE - INTERVAL '1 day' WHERE id = 1`);
    await invalidateTenantStatus(1);

    s = await getTenantStatus(1);
    expect(s.is_active).toBe(false);
  });
});
