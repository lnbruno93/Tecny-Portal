/**
 * Test E2E de aislamiento multi-tenant (PR 4.0).
 *
 * Valida el flujo COMPLETO end-to-end:
 *   1. Crear 2 tenants en DB.
 *   2. Crear 1 user por tenant (vincular via tenant_users).
 *   3. Sembrar categorías distintas en cada tenant.
 *   4. Login del user A → recibe JWT con tenant_id A.
 *   5. GET /api/inventario/categorias con ese token → recibe SOLO las cats de A.
 *   6. Login del user B → recibe JWT con tenant_id B.
 *   7. GET /api/inventario/categorias con ese token → recibe SOLO las cats de B.
 *
 * Este es el test que prueba que TODA la stack multi-tenant funciona end-to-end:
 *   migration (PR 1) + RLS (PR 2) + JWT/middleware/withTenant (PR 3) + endpoint
 *   refactoreado (PR 4.0). Es la base de la suite que crecerá en PR 4.1+ a
 *   medida que refactoreemos cada módulo.
 *
 * Caveat de testing local: el pool de tests corre con un user superuser de
 * Postgres (default en macOS), que BYPASSA RLS incluso con FORCE. En esos
 * casos el endpoint NO filtra por tenant aunque setee app.current_tenant.
 * En CI/staging/prod el role NO es superuser → RLS aplica de verdad. La
 * validación de aislamiento real con role no-super está cubierta en
 * `tests/withTenant.test.js` (PR 3).
 *
 * Lo que este test SÍ valida en cualquier entorno:
 *   - Login emite JWT con tenant_id correcto.
 *   - El endpoint responde 200 y devuelve resultados.
 *   - El payload del JWT distingue tenants correctamente.
 *
 * Lo que NO valida en local (sí en CI/prod):
 *   - Filtrado real de filas por RLS. Para eso, ver withTenant.test.js.
 */
const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/app');
const db      = require('../src/config/database');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;
const TENANT_A = 8001;
const TENANT_B = 8002;
const USER_A   = { username: 'iso_user_a', password: 'isopass_a_123' };
const USER_B   = { username: 'iso_user_b', password: 'isopass_b_123' };

beforeAll(async () => {
  pool = await setupTestDb();

  // 1. Crear los 2 tenants (id forzado para no colisionar con el tenant 1 de PR 1).
  await pool.query(`
    INSERT INTO tenants (id, nombre, slug, plan) VALUES
      ($1, 'Tenant Iso A', 'iso-a', 'pro'),
      ($2, 'Tenant Iso B', 'iso-b', 'pro')
    ON CONFLICT (id) DO NOTHING
  `, [TENANT_A, TENANT_B]);
  await pool.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), ${TENANT_B}))`);

  // 2. Crear los 2 users y vincularlos cada uno a su tenant.
  const hashA = await bcrypt.hash(USER_A.password, 4);
  const hashB = await bcrypt.hash(USER_B.password, 4);
  const { rows: ra } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role) VALUES ('User A', $1, $2, $3, 'admin') RETURNING id`,
    [USER_A.username, `${USER_A.username}@test.local`, hashA]
  );
  const { rows: rb } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role) VALUES ('User B', $1, $2, $3, 'admin') RETURNING id`,
    [USER_B.username, `${USER_B.username}@test.local`, hashB]
  );
  USER_A.id = ra[0].id;
  USER_B.id = rb[0].id;
  await pool.query(`INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`, [TENANT_A, USER_A.id]);
  await pool.query(`INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`, [TENANT_B, USER_B.id]);

  // 3. Sembrar categorías distintas en cada tenant (3 en A, 2 en B).
  await pool.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('ISO_A_CAT_1', $1), ('ISO_A_CAT_2', $1), ('ISO_A_CAT_3', $1)`, [TENANT_A]);
  await pool.query(`INSERT INTO categorias (nombre, tenant_id) VALUES ('ISO_B_CAT_1', $1), ('ISO_B_CAT_2', $1)`, [TENANT_B]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM categorias WHERE nombre LIKE 'ISO_A_%' OR nombre LIKE 'ISO_B_%'`);
  await pool.query(`DELETE FROM tenant_users WHERE tenant_id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  await pool.query(`DELETE FROM users WHERE username IN ($1, $2)`, [USER_A.username, USER_B.username]);
  await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]);
  await teardownTestDb(pool);
});

describe('E2E multi-tenant: aislamiento de /api/inventario/categorias', () => {
  let tokenA, tokenB;

  it('login del user A recibe JWT con tenant_id correcto', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: USER_A.username, password: USER_A.password });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    tokenA = r.body.token;
    // Decodificar el JWT (sin verificar firma, solo para chequear payload)
    const payload = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64').toString());
    expect(payload.tenant_id).toBe(TENANT_A);
    expect(payload.tenant_rol).toBe('owner');
  });

  it('login del user B recibe JWT con tenant_id correcto', async () => {
    const r = await request(app).post('/api/auth/login').send({ username: USER_B.username, password: USER_B.password });
    expect(r.status).toBe(200);
    tokenB = r.body.token;
    const payload = JSON.parse(Buffer.from(tokenB.split('.')[1], 'base64').toString());
    expect(payload.tenant_id).toBe(TENANT_B);
  });

  it('endpoint responde 200 para user A y devuelve resultados', async () => {
    const r = await request(app).get('/api/inventario/categorias').set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    // Las 3 cats que sembramos para tenant A están en la respuesta.
    const nombresA = r.body.map(c => c.nombre).filter(n => n.startsWith('ISO_A_'));
    expect(nombresA.sort()).toEqual(['ISO_A_CAT_1', 'ISO_A_CAT_2', 'ISO_A_CAT_3']);
  });

  it('endpoint responde 200 para user B y devuelve resultados', async () => {
    const r = await request(app).get('/api/inventario/categorias').set('Authorization', `Bearer ${tokenB}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const nombresB = r.body.map(c => c.nombre).filter(n => n.startsWith('ISO_B_'));
    expect(nombresB.sort()).toEqual(['ISO_B_CAT_1', 'ISO_B_CAT_2']);
  });

  it('JWT distingue tenants correctamente (mismo endpoint, distinto contexto)', async () => {
    // Aunque en local el aislamiento real no aplique (superuser bypass), los
    // dos tokens DEBEN tener distinto tenant_id en el payload — eso es lo
    // que en prod gatilla el filtrado RLS via app.current_tenant.
    const payloadA = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64').toString());
    const payloadB = JSON.parse(Buffer.from(tokenB.split('.')[1], 'base64').toString());
    expect(payloadA.tenant_id).not.toBe(payloadB.tenant_id);
    expect(payloadA.tenant_id).toBe(TENANT_A);
    expect(payloadB.tenant_id).toBe(TENANT_B);
  });

  // TANDA 2.4 fix BLOCKER auditoría 2026-06-17: la tabla `users` NO está en
  // RLS, así que el filtro de tenant en /api/usuarios DEBE ser explícito (JOIN
  // a tenant_users con WHERE tenant_id). Antes del fix, un signupeado de A
  // veía PII (nombre, email, username, role) de todos los users de TODOS los
  // tenants. Este test corre con un real role no-super, por eso valida la
  // protección REAL, no la dependencia de RLS.
  it('TANDA 2.4 BLOCKER: GET /api/usuarios solo devuelve users del tenant del caller', async () => {
    // El user A debe ver SOLO al user A en su /api/usuarios (no a user B ni al
    // testadmin del setup).
    const rA = await request(app).get('/api/usuarios').set('Authorization', `Bearer ${tokenA}`);
    expect(rA.status).toBe(200);
    const idsA = rA.body.map(u => u.id);
    expect(idsA).toContain(USER_A.id);
    expect(idsA).not.toContain(USER_B.id);

    // Lo mismo para B: ve B pero no A.
    const rB = await request(app).get('/api/usuarios').set('Authorization', `Bearer ${tokenB}`);
    expect(rB.status).toBe(200);
    const idsB = rB.body.map(u => u.id);
    expect(idsB).toContain(USER_B.id);
    expect(idsB).not.toContain(USER_A.id);
  });
});
