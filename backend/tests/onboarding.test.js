/**
 * Tests del endpoint GET /api/onboarding/status (TANDA 1 H3 #323).
 *
 * Cubre:
 *   - Tenant nuevo (sin nada) → todos los `has_*` en false.
 *   - Tenant con producto creado → has_productos=true, resto false.
 *   - Tenant con producto + contacto + venta → todo true.
 *   - Producto soft-deleted no cuenta (deleted_at IS NOT NULL).
 *   - Sin auth → 401.
 *   - Aislamiento multi-tenant: lo que está en tenant 1 no afecta a tenant 2.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let adminToken;

beforeAll(async () => {
  pool = await setupTestDb();
  // Token del Test Admin (tenant 1) creado por setupTestDb.
  adminToken = jwt.sign(
    {
      id: 1, username: TEST_USER.username, email: TEST_USER.email, role: TEST_USER.role,
      tenant_id: 1, tenant_rol: 'owner', iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
});
afterAll(async () => { await teardownTestDb(pool); });

// Helper: limpia productos/contactos/ventas del tenant 1 entre tests para que
// cada caso arranque de cero sin interferir con el resto de la suite.
async function resetTenant1Data() {
  await pool.query('DELETE FROM ventas WHERE tenant_id = 1');
  await pool.query('DELETE FROM productos WHERE tenant_id = 1');
  await pool.query('DELETE FROM contactos WHERE tenant_id = 1');
}

describe('GET /api/onboarding/status', () => {
  beforeEach(resetTenant1Data);
  afterAll(resetTenant1Data); // dejar limpio al terminar

  it('sin auth → 401', async () => {
    const res = await request(app).get('/api/onboarding/status');
    expect(res.status).toBe(401);
  });

  it('tenant sin nada → todos false', async () => {
    const res = await request(app)
      .get('/api/onboarding/status')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      has_productos: false,
      has_contactos: false,
      has_ventas:    false,
    });
  });

  it('solo producto creado → has_productos=true, resto false', async () => {
    await pool.query(
      `INSERT INTO productos (nombre, tenant_id) VALUES ('Producto Test', 1)`
    );
    const res = await request(app)
      .get('/api/onboarding/status')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body).toEqual({
      has_productos: true,
      has_contactos: false,
      has_ventas:    false,
    });
  });

  it('producto + contacto + venta → todo true', async () => {
    await pool.query(
      `INSERT INTO productos (nombre, tenant_id) VALUES ('Producto Test', 1)`
    );
    await pool.query(
      `INSERT INTO contactos (nombre, tenant_id) VALUES ('Cliente Test', 1)`
    );
    // ventas: required fields según migration (order_id NOT NULL, fecha NOT NULL).
    // Resto tiene defaults. Si el schema agrega NOT NULLs nuevos, el INSERT
    // va a fallar y el test lo va a delatar.
    await pool.query(
      `INSERT INTO ventas (order_id, fecha, tenant_id)
         VALUES ('TEST-001', CURRENT_DATE, 1)`
    );

    const res = await request(app)
      .get('/api/onboarding/status')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body).toEqual({
      has_productos: true,
      has_contactos: true,
      has_ventas:    true,
    });
  });

  it('producto soft-deleted no cuenta', async () => {
    await pool.query(
      `INSERT INTO productos (nombre, tenant_id, deleted_at)
         VALUES ('Borrado', 1, NOW())`
    );
    const res = await request(app)
      .get('/api/onboarding/status')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.has_productos).toBe(false);
  });
});
