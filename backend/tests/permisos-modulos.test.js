/**
 * Tests de integración — permisos de módulos vía capabilities (post-F4).
 *
 * 2026-06-23 F4: el sistema viejo `perms` (14 booleans en user_permissions)
 * murió. Ahora los gates leen `caps` embebidas en el JWT (objeto slug→true),
 * o hacen fallback a DB si el JWT no las trae. Los tests firman el JWT
 * directamente con las caps necesarias — es el path rápido y aislado del
 * setup de roles/overrides en DB.
 *
 * Cubre:
 *   - operador con `inventario.ver` accede a /api/inventario; sin `ventas.trabajar` → 403
 *   - operador con `cajas.ver` accede a /api/cajas pero no a /api/comprobantes
 *   - operador con `financiera.trabajar` accede a comprobantes pero no a inventario/ventas
 *   - operador sin caps → todo 403 (default-deny)
 *   - admin global bypassa todos los gates
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, adminToken;
const hoy = new Date().toISOString().split('T')[0];

// Helper: firma un JWT con caps embebidas (path rápido en requireCapability,
// no toca DB). `caps` es un objeto { slug: true } — así lo lee el middleware.
// `tenant_cap_rol: 'custom'` evita el bypass por rol (owner/admin) y fuerza
// al middleware a chequear las caps.
function signOpJwt({ id, username, email, caps }) {
  return jwt.sign(
    {
      id,
      username,
      email,
      role: 'op',
      tenant_id: 1,
      tenant_rol: 'member',
      tenant_cap_rol: 'custom',
      caps,
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256' }
  );
}

// Crea un user 'op' en DB (necesario para que requireAuth no rebote por
// user inexistente / password_changed_at) y devuelve { id, token }.
async function createOpUser({ username, caps }) {
  const hash = await bcrypt.hash('opop1234', 4);
  const { rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
     VALUES ($1, $2, $3, $4, 'op', NOW()) RETURNING id`,
    [username, username, `${username}@test.local`, hash]
  );
  const id = rows[0].id;
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'member')
     ON CONFLICT DO NOTHING`,
    [id]
  );
  return {
    id,
    token: signOpJwt({ id, username, email: `${username}@test.local`, caps }),
  };
}

beforeAll(async () => {
  pool = await setupTestDb();
  const a = await request(app).post('/api/auth/login').send({
    username: TEST_USER.username, password: TEST_USER.password,
  });
  adminToken = a.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Permisos de módulos nuevos', () => {
  let opStock;

  beforeAll(async () => {
    // Operador con `inventario.ver` activa, todo lo demás denegado.
    opStock = await createOpUser({
      username: 'opstock',
      caps: { 'inventario.ver': true },
    });
  });

  it('operador CON capability inventario.ver accede a inventario → 200', async () => {
    const res = await request(app).get('/api/inventario/productos')
      .set('Authorization', `Bearer ${opStock.token}`);
    expect(res.status).toBe(200);
  });

  it('operador SIN capability ventas.trabajar → 403', async () => {
    const res = await request(app)
      .get(`/api/ventas?desde=${hoy}&hasta=${hoy}`)
      .set('Authorization', `Bearer ${opStock.token}`);
    expect(res.status).toBe(403);
  });

  it('admin accede a ambos (bypass por rol global)', async () => {
    const inv = await request(app).get('/api/inventario/productos').set('Authorization', `Bearer ${adminToken}`);
    const ven = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}`).set('Authorization', `Bearer ${adminToken}`);
    expect(inv.status).toBe(200);
    expect(ven.status).toBe(200);
  });
});

// H1: Matriz de roles más amplia. Cubre el caso "operador con SOLO una
// capability puntual" para varios módulos y verifica que el control es
// granular post-cutover.
describe('Matriz de permisos por módulo (H1)', () => {
  let opCajas, opFinanciera, opSinNada;

  beforeAll(async () => {
    // Operador con solo `cajas.ver` — accede a /api/cajas pero no a otros módulos.
    opCajas = await createOpUser({
      username: 'opcajas',
      caps: { 'cajas.ver': true },
    });

    // Operador con caps de financiera (mount /api/comprobantes gateado por
    // `financiera.trabajar`). El antiguo `perms.financiera: true` gateaba
    // varios módulos — acá expandimos a los slugs equivalentes para
    // preservar la semántica del test.
    opFinanciera = await createOpUser({
      username: 'opfin',
      caps: {
        'financiera.trabajar': true,
        'historial.ver': true,
        'resumen.ver': true,
        'config.general': true,
        'config.alertas': true,
      },
    });

    // Operador sin ninguna capability — caps={} fuerza default-deny.
    opSinNada = await createOpUser({
      username: 'opnada',
      caps: {},
    });
  });

  it('op con solo `cajas.ver` accede a /api/cajas pero NO a /api/comprobantes', async () => {
    const ok = await request(app).get('/api/cajas/cajas')
      .set('Authorization', `Bearer ${opCajas.token}`);
    expect(ok.status).toBe(200);
    const no = await request(app).get('/api/comprobantes')
      .set('Authorization', `Bearer ${opCajas.token}`);
    expect(no.status).toBe(403);
  });

  it('op con `financiera.trabajar` accede a comprobantes pero NO a inventario ni ventas', async () => {
    const ok = await request(app).get('/api/comprobantes')
      .set('Authorization', `Bearer ${opFinanciera.token}`);
    expect(ok.status).toBe(200);
    const noInv = await request(app).get('/api/inventario/productos')
      .set('Authorization', `Bearer ${opFinanciera.token}`);
    expect(noInv.status).toBe(403);
    const noVen = await request(app)
      .get(`/api/ventas?desde=${hoy}&hasta=${hoy}`)
      .set('Authorization', `Bearer ${opFinanciera.token}`);
    expect(noVen.status).toBe(403);
  });

  it('op sin caps no accede a nada productivo (todo 403)', async () => {
    const endpoints = [
      '/api/inventario/productos',
      '/api/cajas/cajas',
      '/api/comprobantes',
      `/api/ventas?desde=${hoy}&hasta=${hoy}`,
    ];
    for (const ep of endpoints) {
      const r = await request(app).get(ep)
        .set('Authorization', `Bearer ${opSinNada.token}`);
      expect(r.status).toBe(403);
    }
  });

  it('todos los operadores pueden /api/auth/me (no requiere caps de módulo)', async () => {
    for (const u of [opCajas, opFinanciera, opSinNada]) {
      const r = await request(app).get('/api/auth/me')
        .set('Authorization', `Bearer ${u.token}`);
      expect(r.status).toBe(200);
    }
  });
});
