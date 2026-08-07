/**
 * Tests de integración — tercero_link (task #302).
 *
 * Cubre los 4 endpoints:
 *   · POST   /api/tercero-link
 *   · GET    /api/tercero-link/by-cliente/:id
 *   · GET    /api/tercero-link/by-proveedor/:id
 *   · DELETE /api/tercero-link/:id
 *
 * Pattern: espejo del test suite de contactoTipos + proveedores-devoluciones.
 * Cross-tenant aislamiento verificado con 2 tenants (mismo pattern que
 * inventario-check-imei.test.js).
 */
const request = require('supertest');
const app = require('../src/app');
const bcrypt = require('bcrypt');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let adminToken;

async function login(username, password) {
  const r = await request(app).post('/api/auth/login').send({ username, password });
  if (r.status !== 200) {
    throw new Error(`login falló: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.token;
}

async function createCliente(nombre, saldo_inicial = 0) {
  const r = await request(app)
    .post('/api/cuentas/clientes')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre, categoria: 'A-', saldo_inicial });
  if (r.status !== 201) throw new Error(`crear cliente falló: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function createProveedor(nombre, saldo_inicial = 0) {
  const r = await request(app)
    .post('/api/proveedores')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ nombre, saldo_inicial });
  if (r.status !== 201) throw new Error(`crear proveedor falló: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

beforeAll(async () => {
  pool = await setupTestDb();
  adminToken = await login(TEST_USER.username, TEST_USER.password);
});

afterAll(async () => { await teardownTestDb(pool); });

describe('POST /api/tercero-link', () => {
  it('crea link happy path — verifica row + response', async () => {
    const cli = await createCliente('Cliente Happy Link');
    const prov = await createProveedor('Proveedor Happy Link');

    const res = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli.id, proveedor_id: prov.id, notas: 'test happy' });

    expect(res.status).toBe(201);
    expect(res.body.cliente_cc_id).toBe(cli.id);
    expect(res.body.proveedor_id).toBe(prov.id);
    expect(res.body.notas).toBe('test happy');
    expect(typeof res.body.id).toBe('number');

    // Verificar en DB (con set_config para saltear RLS local, tenant_id=1 default).
    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('app.current_tenant', '1', false)`);
      const { rows } = await client.query(
        `SELECT * FROM tercero_link WHERE id = $1 AND deleted_at IS NULL`,
        [res.body.id]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].cliente_cc_id).toBe(cli.id);
      expect(rows[0].proveedor_id).toBe(prov.id);
    } finally {
      client.release();
    }
  });

  it('409 si ya existe link activo para el cliente_cc_id', async () => {
    const cli = await createCliente('Cliente Dup');
    const prov1 = await createProveedor('Proveedor Dup 1');
    const prov2 = await createProveedor('Proveedor Dup 2');

    // 1er link OK
    const r1 = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli.id, proveedor_id: prov1.id });
    expect(r1.status).toBe(201);

    // 2do link mismo cliente → 409
    const r2 = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli.id, proveedor_id: prov2.id });
    expect(r2.status).toBe(409);
    expect(r2.body.conflict_on).toBe('cliente_cc_id');
  });

  it('409 si ya existe link activo para el proveedor_id', async () => {
    const cli1 = await createCliente('Cliente Dup Prov 1');
    const cli2 = await createCliente('Cliente Dup Prov 2');
    const prov = await createProveedor('Proveedor Dup Contra');

    const r1 = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli1.id, proveedor_id: prov.id });
    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli2.id, proveedor_id: prov.id });
    expect(r2.status).toBe(409);
    expect(r2.body.conflict_on).toBe('proveedor_id');
  });

  it('404 si cliente_cc_id no existe', async () => {
    const prov = await createProveedor('Proveedor sin Cliente');
    const res = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: 999999, proveedor_id: prov.id });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/[Cc]liente/);
  });

  it('404 si proveedor_id no existe', async () => {
    const cli = await createCliente('Cliente sin Proveedor');
    const res = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli.id, proveedor_id: 999999 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/[Pp]roveedor/);
  });

  it('400 con body inválido (falta cliente_cc_id)', async () => {
    const prov = await createProveedor('Prov 400');
    const res = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ proveedor_id: prov.id });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/tercero-link/by-cliente/:id', () => {
  it('cliente sin link → link: null + saldo_neto = saldo_cliente', async () => {
    const cli = await createCliente('Cliente Sin Link', 1000);

    const res = await request(app)
      .get(`/api/tercero-link/by-cliente/${cli.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.link).toBeNull();
    expect(res.body.contraparte).toBeNull();
    expect(Number(res.body.saldo_cliente_usd)).toBeCloseTo(1000, 2);
    expect(Number(res.body.saldo_neto_usd)).toBeCloseTo(1000, 2);
  });

  it('con link → saldo neto = saldo_cliente - saldo_proveedor (Kevin case)', async () => {
    // Kevin case: cliente debe 5000 USD, proveedor deuda 2500 USD → neto 2500
    const cli = await createCliente('Kevin CC', 5000);
    const prov = await createProveedor('Kevin Prov', 2500);

    const linkR = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli.id, proveedor_id: prov.id, notas: 'Kevin case' });
    expect(linkR.status).toBe(201);

    const res = await request(app)
      .get(`/api/tercero-link/by-cliente/${cli.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.link).not.toBeNull();
    expect(res.body.link.id).toBe(linkR.body.id);
    expect(res.body.contraparte).not.toBeNull();
    expect(res.body.contraparte.id).toBe(prov.id);
    expect(res.body.contraparte.nombre).toBe('Kevin Prov');
    expect(Number(res.body.contraparte.saldo_usd)).toBeCloseTo(2500, 2);
    expect(Number(res.body.saldo_cliente_usd)).toBeCloseTo(5000, 2);
    expect(Number(res.body.saldo_neto_usd)).toBeCloseTo(2500, 2);
  });

  it('404 si cliente inexistente', async () => {
    const res = await request(app)
      .get(`/api/tercero-link/by-cliente/999999`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/tercero-link/by-proveedor/:id', () => {
  it('proveedor sin link → saldo_neto = -saldo_proveedor', async () => {
    const prov = await createProveedor('Prov Sin Link', 800);
    const res = await request(app)
      .get(`/api/tercero-link/by-proveedor/${prov.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.link).toBeNull();
    expect(Number(res.body.saldo_proveedor_usd)).toBeCloseTo(800, 2);
    // Sin link + deuda con el proveedor → saldo neto es negativo (le debemos).
    expect(Number(res.body.saldo_neto_usd)).toBeCloseTo(-800, 2);
  });

  it('con link → contraparte cliente + saldo neto', async () => {
    const cli = await createCliente('Fulano CC', 3000);
    const prov = await createProveedor('Fulano Prov', 1000);
    const linkR = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli.id, proveedor_id: prov.id });
    expect(linkR.status).toBe(201);

    const res = await request(app)
      .get(`/api/tercero-link/by-proveedor/${prov.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.contraparte).not.toBeNull();
    expect(res.body.contraparte.id).toBe(cli.id);
    expect(Number(res.body.contraparte.saldo_cc)).toBeCloseTo(3000, 2);
    expect(Number(res.body.saldo_proveedor_usd)).toBeCloseTo(1000, 2);
    expect(Number(res.body.saldo_neto_usd)).toBeCloseTo(2000, 2);
  });
});

describe('DELETE /api/tercero-link/:id', () => {
  it('soft-delete happy path', async () => {
    const cli = await createCliente('Cli Delete');
    const prov = await createProveedor('Prov Delete');
    const linkR = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli.id, proveedor_id: prov.id });
    const linkId = linkR.body.id;

    const del = await request(app)
      .delete(`/api/tercero-link/${linkId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    // Post-delete el link ya no aparece en by-cliente.
    const post = await request(app)
      .get(`/api/tercero-link/by-cliente/${cli.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(post.body.link).toBeNull();

    // Permite re-linkeo con otro proveedor (UNIQUE partial WHERE deleted_at IS NULL).
    const prov2 = await createProveedor('Prov Delete Re');
    const r2 = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli.id, proveedor_id: prov2.id });
    expect(r2.status).toBe(201);
  });

  it('404 si ya está soft-deleted', async () => {
    const cli = await createCliente('Cli Del 404');
    const prov = await createProveedor('Prov Del 404');
    const linkR = await request(app)
      .post('/api/tercero-link')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cliente_cc_id: cli.id, proveedor_id: prov.id });

    const d1 = await request(app)
      .delete(`/api/tercero-link/${linkR.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(d1.status).toBe(200);

    const d2 = await request(app)
      .delete(`/api/tercero-link/${linkR.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(d2.status).toBe(404);
  });

  it('400 con id inválido', async () => {
    const res = await request(app)
      .delete('/api/tercero-link/no-es-numero')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

// ─── Cross-tenant RLS ────────────────────────────────────────────────
//
// Caveat: en local con superuser PG, RLS no filtra (mismo caveat que
// inventario-check-imei.test.js). En CI con role NOSUPERUSER + FORCE RLS,
// el aislamiento SÍ aplica. Este test valida el shape esperado —
// backend usa withTenant() en todas las queries.
describe('cross-tenant aislamiento', () => {
  const TENANT_A = 8801;
  const TENANT_B = 8802;
  const USER_A = { username: 'tl_user_a', password: 'tlpassa_123' };
  const USER_B = { username: 'tl_user_b', password: 'tlpassb_123' };
  let clienteA, proveedorA, linkAId, tokenB;

  beforeAll(async () => {
    // 2 tenants + 2 users owner.
    await pool.query(`
      INSERT INTO tenants (id, nombre, slug, plan) VALUES
        ($1, 'Tenant Link A', 'link-a', 'pro'),
        ($2, 'Tenant Link B', 'link-b', 'pro')
      ON CONFLICT (id) DO NOTHING
    `, [TENANT_A, TENANT_B]);
    await pool.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), ${TENANT_B}))`);

    const hashA = await bcrypt.hash(USER_A.password, 4);
    const hashB = await bcrypt.hash(USER_B.password, 4);
    const rA = await pool.query(
      `INSERT INTO users (nombre, username, email, password_hash, role) VALUES ('User A', $1, $2, $3, 'admin') RETURNING id`,
      [USER_A.username, `${USER_A.username}@test.local`, hashA]
    );
    const rB = await pool.query(
      `INSERT INTO users (nombre, username, email, password_hash, role) VALUES ('User B', $1, $2, $3, 'admin') RETURNING id`,
      [USER_B.username, `${USER_B.username}@test.local`, hashB]
    );
    USER_A.id = rA.rows[0].id;
    USER_B.id = rB.rows[0].id;
    await pool.query(`INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`, [TENANT_A, USER_A.id]);
    await pool.query(`INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`, [TENANT_B, USER_B.id]);

    // Cliente + Proveedor + Link en tenant A (INSERT directo con tenant context).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.current_tenant = ${TENANT_A}`);
      const cRes = await client.query(
        `INSERT INTO clientes_cc (tenant_id, nombre, categoria)
         VALUES ($1, 'Kevin A', 'A-') RETURNING id`,
        [TENANT_A]
      );
      clienteA = { id: cRes.rows[0].id };
      const pRes = await client.query(
        `INSERT INTO proveedores (tenant_id, nombre)
         VALUES ($1, 'Kevin A Prov') RETURNING id`,
        [TENANT_A]
      );
      proveedorA = { id: pRes.rows[0].id };
      const lRes = await client.query(
        `INSERT INTO tercero_link (tenant_id, cliente_cc_id, proveedor_id, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [TENANT_A, clienteA.id, proveedorA.id, USER_A.id]
      );
      linkAId = lRes.rows[0].id;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    tokenB = await login(USER_B.username, USER_B.password);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tercero_link WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await pool.query(`DELETE FROM clientes_cc WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await pool.query(`DELETE FROM proveedores WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await pool.query(`DELETE FROM tenant_users WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
    await pool.query(`DELETE FROM users WHERE username IN ($1, $2)`, [USER_A.username, USER_B.username]);
    await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  });

  it('tenant B NO puede leer link del tenant A (GET by-cliente → 404 o link:null)', async () => {
    // En CI con FORCE RLS: RLS filtra clientes_cc del tenant A → tenant B recibe 404
    // en el GET /api/tercero-link/by-cliente/:id (porque el cliente no está a la vista).
    // En local (superuser), el cliente_cc puede aparecer pero el link_by_cliente NO.
    const res = await request(app)
      .get(`/api/tercero-link/by-cliente/${clienteA.id}`)
      .set('Authorization', `Bearer ${tokenB}`);
    // En CI: 404 (cliente no visible). En local con superuser: 200 con link=null
    // (cliente visible pero link filtrado por RLS). Ambos son safe.
    if (res.status === 200) {
      expect(res.body.link).toBeNull();
    } else {
      expect(res.status).toBe(404);
    }
  });

  it('tenant B NO puede borrar link del tenant A (DELETE → 404)', async () => {
    const res = await request(app)
      .delete(`/api/tercero-link/${linkAId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});
