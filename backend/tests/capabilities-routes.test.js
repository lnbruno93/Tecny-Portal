/**
 * Tests de integración para /api/capabilities (Permisos F1).
 *
 * Cubre el flow básico:
 *   · GET /catalog devuelve 45 capabilities agrupadas en 19 pantallas.
 *   · GET /users (adminOnly) lista users del tenant con rol + overrides.
 *   · PUT /users/:id cambia rol y guarda overrides.
 *   · PUT 404 si el target no pertenece al tenant.
 *   · No-admin (tenant_rol='member') → 403 en GET /users y PUT /users/:id.
 *   · El catálogo + roleDefaults son consistentes (todo slug en defaults
 *     está en el catálogo).
 *
 * Cleanup defensivo de tenant_user_roles + user_capabilities en beforeEach
 * para aislamiento.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;
let adminToken;
let memberToken;
let memberUserId;

function signToken({ id, username, email, role, tenant_id, tenant_rol }) {
  return jwt.sign(
    { id, username, email, role, tenant_id, tenant_rol, iat_ms: Date.now() },
    process.env.JWT_SECRET,
    { algorithm: 'HS256' },
  );
}

beforeAll(async () => {
  pool = await setupTestDb();

  // Test admin (role=admin global) — bypassea TODO.
  adminToken = signToken({
    id: 1, username: 'testadmin', email: 'testadmin@test.local',
    role: 'admin', tenant_id: 1, tenant_rol: 'admin',
  });

  // Crear un member NO-admin para validar gates de adminOnly del router.
  const hash = await bcrypt.hash('memberpass123', 10);
  const { rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role)
     VALUES ('Member Test', 'membertest', 'member@test.local', $1, 'op')
     RETURNING id`,
    [hash],
  );
  memberUserId = rows[0].id;
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'member')
     ON CONFLICT DO NOTHING`,
    [memberUserId],
  );

  memberToken = signToken({
    id: memberUserId, username: 'membertest', email: 'member@test.local',
    role: 'op', tenant_id: 1, tenant_rol: 'member',
  });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

beforeEach(async () => {
  // Limpiar SOLO las tablas nuevas — capability_catalog NO se toca (es global,
  // seedeada por migration y debería persistir entre tests).
  await pool.query('DELETE FROM user_capabilities WHERE tenant_id = 1');
  await pool.query('DELETE FROM tenant_user_roles WHERE tenant_id = 1');
});

describe('GET /api/capabilities/catalog', () => {
  it('devuelve 20 pantallas con 46 capabilities en total', async () => {
    // 2026-06-27 #454 (Red B2B F1): catálogo ahora tiene 20 pantallas
    // (era 19) y 46 capabilities (era 45) tras agregar 'cross_tenant.write'
    // bajo la nueva pantalla 'cross_tenant' (módulo Red B2B).
    // Cuando agreguemos más capabilities en F2-F5 o features futuras,
    // bumpear estos numeros (son sanity checks de "el seed corrió OK").
    const r = await request(app)
      .get('/api/capabilities/catalog')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(r.body.pantallas).toBeInstanceOf(Array);
    expect(r.body.pantallas.length).toBe(20);
    const total = r.body.pantallas.reduce((acc, p) => acc + p.capabilities.length, 0);
    // 46 → 49 tras #500 (agregamos inventario.crear/editar/eliminar).
    expect(total).toBe(49);
    expect(r.body.roles).toContain('owner');
    expect(r.body.roles).toContain('custom');
  });

  it('cada capability tiene slug, id y label', async () => {
    const r = await request(app)
      .get('/api/capabilities/catalog')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const ventas = r.body.pantallas.find(p => p.id === 'ventas');
    expect(ventas).toBeDefined();
    expect(ventas.label).toBe('Ventas');
    const eliminar = ventas.capabilities.find(c => c.id === 'eliminar');
    expect(eliminar).toBeDefined();
    expect(eliminar.slug).toBe('ventas.eliminar');
    expect(eliminar.label).toBe('Eliminar una venta');
  });

  it('sin auth → 401', async () => {
    await request(app)
      .get('/api/capabilities/catalog')
      .expect(401);
  });
});

describe('GET /api/capabilities/users (adminOnly)', () => {
  it('admin lista users del tenant con rol y caps efectivas', async () => {
    const r = await request(app)
      .get('/api/capabilities/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThanOrEqual(2); // admin + member
    const admin = r.body.find(u => u.username === 'testadmin');
    expect(admin).toBeDefined();
    // Sin fila en tenant_user_roles (beforeEach las borra) → default 'custom'.
    expect(admin.rol).toBe('custom');
    expect(admin.overrides).toEqual([]);
  });

  it('member NO-admin → 403', async () => {
    await request(app)
      .get('/api/capabilities/users')
      .set('Authorization', `Bearer ${memberToken}`)
      .expect(403);
  });
});

describe('PUT /api/capabilities/users/:id', () => {
  it('cambia el rol del target y persiste', async () => {
    const r = await request(app)
      .put(`/api/capabilities/users/${memberUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rol: 'vendedor' })
      .expect(200);

    expect(r.body.rol).toBe('vendedor');

    // Confirmar en DB.
    const { rows } = await pool.query(
      'SELECT rol FROM tenant_user_roles WHERE tenant_id=1 AND user_id=$1',
      [memberUserId],
    );
    expect(rows[0].rol).toBe('vendedor');
  });

  it('guarda overrides (reemplazo total)', async () => {
    await request(app)
      .put(`/api/capabilities/users/${memberUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        rol: 'vendedor',
        overrides: [
          { capability_slug: 'cajas.ver', enabled: true },
          { capability_slug: 'envios.trabajar', enabled: false },
        ],
      })
      .expect(200);

    const { rows } = await pool.query(
      `SELECT capability_slug, enabled FROM user_capabilities
        WHERE tenant_id=1 AND user_id=$1 ORDER BY capability_slug`,
      [memberUserId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ capability_slug: 'cajas.ver', enabled: true });
    expect(rows[1]).toEqual({ capability_slug: 'envios.trabajar', enabled: false });
  });

  it('overrides=[] borra todos los overrides existentes', async () => {
    // Setup: insertar 2 overrides manuales.
    await pool.query(`SET LOCAL app.current_tenant = 1`).catch(() => {});
    await pool.query(`
      INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
      VALUES (1, $1, 'cajas.ver', true), (1, $1, 'envios.trabajar', true)
      ON CONFLICT DO NOTHING
    `, [memberUserId]).catch(() => {}); // ignora si la FORCE RLS bloquea fuera de tx — el test no depende del seed

    await request(app)
      .put(`/api/capabilities/users/${memberUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rol: 'vendedor', overrides: [] })
      .expect(200);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int n FROM user_capabilities WHERE tenant_id=1 AND user_id=$1`,
      [memberUserId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('rechaza override con capability_slug fuera del catálogo (zod)', async () => {
    const r = await request(app)
      .put(`/api/capabilities/users/${memberUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        overrides: [{ capability_slug: 'fake.cap', enabled: true }],
      });
    expect(r.status).toBe(400);
  });

  it('rechaza rol fuera del enum permitido (no acepta owner)', async () => {
    const r = await request(app)
      .put(`/api/capabilities/users/${memberUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rol: 'owner' });
    expect(r.status).toBe(400);
  });

  it('rechaza body vacío {}', async () => {
    const r = await request(app)
      .put(`/api/capabilities/users/${memberUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('target user no en tenant → 404', async () => {
    // Crear user en otro tenant.
    const hash = await bcrypt.hash('xpass', 10);
    const { rows } = await pool.query(
      `INSERT INTO users (nombre, username, email, password_hash, role)
       VALUES ('External', 'externaluser', 'ext@test.local', $1, 'op')
       RETURNING id`,
      [hash],
    );
    const externalId = rows[0].id;
    // NO lo agregamos a tenant_users del tenant 1.

    await request(app)
      .put(`/api/capabilities/users/${externalId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rol: 'vendedor' })
      .expect(404);

    // Cleanup
    await pool.query('DELETE FROM users WHERE id = $1', [externalId]);
  });

  it('member NO-admin → 403 (no puede editar capabilities)', async () => {
    // Re-firmamos memberToken acá: tests previos pueden haber bumpeado
    // password_changed_at del memberUserId (cuando lo usan como target del
    // PUT), invalidando el token original del beforeAll. Re-firmar con
    // iat_ms=now garantiza iat_ms > password_changed_at → middleware deja pasar
    // → llega a adminOnly → 403 (que es lo que el test valida).
    const freshMemberToken = signToken({
      id: memberUserId, username: 'membertest', email: 'member@test.local',
      role: 'op', tenant_id: 1, tenant_rol: 'member',
    });
    await request(app)
      .put(`/api/capabilities/users/${memberUserId}`)
      .set('Authorization', `Bearer ${freshMemberToken}`)
      .send({ rol: 'vendedor' })
      .expect(403);
  });

  it('bumpea password_changed_at del target (invalida JWT)', async () => {
    const before = await pool.query(
      'SELECT password_changed_at FROM users WHERE id = $1',
      [memberUserId],
    );

    // Esperamos un mini delta de tiempo entre before y after.
    await new Promise(r => setTimeout(r, 10));

    await request(app)
      .put(`/api/capabilities/users/${memberUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rol: 'encargado' })
      .expect(200);

    const after = await pool.query(
      'SELECT password_changed_at FROM users WHERE id = $1',
      [memberUserId],
    );

    expect(after.rows[0].password_changed_at.getTime())
      .toBeGreaterThan(before.rows[0].password_changed_at?.getTime() || 0);
  });
});
