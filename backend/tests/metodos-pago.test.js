/**
 * Tests de integración — GET /api/metodos-pago
 * Auditoría 2026-06-30 Q-02/Q-03.
 *
 * Cubre:
 *   - Auth required (sin token → 401).
 *   - Shape del response: array de objetos con whitelist de columnas.
 *   - **Regression guard contra leak**: el response NO incluye `saldo`,
 *     `saldo_inicial`, `saldo_actual` ni similares (info sensible que solo
 *     `/api/cajas` debe exponer).
 *   - Soft-deleted (`deleted_at IS NOT NULL`) y `activo=false` no aparecen.
 *   - Aislamiento multi-tenant (smoke test: 2 tenants seedeados, cada uno
 *     ve solo los suyos — caveat de superuser local heredado del patrón de
 *     multitenant-isolation.test.js).
 *
 * Rationale del endpoint: ver backend/src/routes/metodos-pago.js. Es público
 * para cualquier user logueado (sin gate de capability `cajas`) para que
 * operadores con `envios.trabajar` o `ventas.trabajar` pero sin permiso de
 * cajas puedan cobrar. Por eso CRÍTICO no filtrar saldos en este endpoint.
 */
const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;
const auth = () => ({ Authorization: `Bearer ${token}` });

// Tenants/users para aislamiento (mismo patrón que multitenant-isolation.test.js).
const TENANT_MP_A = 8801;
const TENANT_MP_B = 8802;
const USER_MP_A   = { username: 'mp_user_a', password: 'mppass_a_123' };
const USER_MP_B   = { username: 'mp_user_b', password: 'mppass_b_123' };

beforeAll(async () => {
  pool = await setupTestDb();
  const authRes = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = authRes.body.token;

  // Setup multi-tenant para el smoke test de aislamiento.
  await pool.query(`
    INSERT INTO tenants (id, nombre, slug, plan) VALUES
      ($1, 'Tenant MP A', 'mp-iso-a', 'pro'),
      ($2, 'Tenant MP B', 'mp-iso-b', 'pro')
    ON CONFLICT (id) DO NOTHING
  `, [TENANT_MP_A, TENANT_MP_B]);
  await pool.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), ${TENANT_MP_B}))`);

  const hashA = await bcrypt.hash(USER_MP_A.password, 4);
  const hashB = await bcrypt.hash(USER_MP_B.password, 4);
  const { rows: ra } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role) VALUES ('MP A', $1, $2, $3, 'admin') RETURNING id`,
    [USER_MP_A.username, `${USER_MP_A.username}@test.local`, hashA]
  );
  const { rows: rb } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role) VALUES ('MP B', $1, $2, $3, 'admin') RETURNING id`,
    [USER_MP_B.username, `${USER_MP_B.username}@test.local`, hashB]
  );
  USER_MP_A.id = ra[0].id;
  USER_MP_B.id = rb[0].id;
  await pool.query(`INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`, [TENANT_MP_A, USER_MP_A.id]);
  await pool.query(`INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`, [TENANT_MP_B, USER_MP_B.id]);

  // Seedear métodos distintos en cada tenant (con marcadores únicos para
  // poder identificarlos sin ambigüedad con los seeds del tenant 1).
  await pool.query(`
    INSERT INTO metodos_pago (nombre, moneda, orden, tenant_id) VALUES
      ('MP_ISO_A_ARS', 'ARS', 99, $1),
      ('MP_ISO_A_USD', 'USD', 99, $1)
  `, [TENANT_MP_A]);
  await pool.query(`
    INSERT INTO metodos_pago (nombre, moneda, orden, tenant_id) VALUES
      ('MP_ISO_B_ARS', 'ARS', 99, $1)
  `, [TENANT_MP_B]);
});

afterAll(async () => {
  // Cleanup orden seguro (FK + RLS): metodos_pago primero, después tenant_users,
  // después users, después tenants.
  await pool.query(`DELETE FROM metodos_pago WHERE nombre LIKE 'MP_ISO_%'`);
  await pool.query(`DELETE FROM tenant_users WHERE tenant_id IN ($1, $2)`, [TENANT_MP_A, TENANT_MP_B]);
  await pool.query(`DELETE FROM users WHERE username IN ($1, $2)`, [USER_MP_A.username, USER_MP_B.username]);
  await pool.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [TENANT_MP_A, TENANT_MP_B]);
  await teardownTestDb(pool);
});

describe('GET /api/metodos-pago — auth', () => {
  it('sin token → 401', async () => {
    const res = await request(app).get('/api/metodos-pago');
    expect(res.status).toBe(401);
  });

  it('con token válido → 200 y array', async () => {
    const res = await request(app).get('/api/metodos-pago').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // El seed default (helpers/setup.js) inserta 6 cajas en el tenant 1 — el
    // testadmin pertenece a ese tenant, así que el array NO debería venir vacío.
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describe('GET /api/metodos-pago — shape del response', () => {
  it('cada fila incluye id, nombre, moneda, comision_pct, es_financiera, es_tarjeta, orden', async () => {
    const res = await request(app).get('/api/metodos-pago').set(auth());
    expect(res.status).toBe(200);
    const expectedKeys = ['id', 'nombre', 'moneda', 'comision_pct', 'es_financiera', 'es_tarjeta', 'orden'];
    res.body.forEach((row) => {
      expectedKeys.forEach((k) => {
        expect(row).toHaveProperty(k);
      });
    });
  });

  // REGRESSION GUARD (Q-02 audit 2026-06-30): el endpoint /api/metodos-pago
  // NO debe filtrar info sensible de saldos. La columna `metodos_pago.saldo_inicial`
  // (NUMERIC) representa el saldo de apertura de la caja en su moneda — datos que
  // solo deberían ver users con permiso `cajas.ver` vía /api/cajas. Si alguien
  // agrega `SELECT *` o suma columnas de balance por error, este test falla.
  it('NO incluye campos de balance (saldo, saldo_inicial, saldo_actual, saldo_usd)', async () => {
    const res = await request(app).get('/api/metodos-pago').set(auth());
    expect(res.status).toBe(200);
    const forbiddenKeys = ['saldo', 'saldo_inicial', 'saldo_actual', 'saldo_usd', 'saldo_ars'];
    res.body.forEach((row) => {
      forbiddenKeys.forEach((k) => {
        expect(row).not.toHaveProperty(k);
      });
    });
  });

  // Mismo regression guard pero generalizado: ninguna clave del response puede
  // contener la subcadena "saldo" o "balance". Atrapa nombres futuros que se
  // agreguen al schema (ej: `saldo_calculado`, `balance_usd`, etc.) sin que
  // alguien recuerde actualizar el whitelist de columnas del endpoint.
  it('ninguna clave del response contiene la subcadena "saldo" o "balance"', async () => {
    const res = await request(app).get('/api/metodos-pago').set(auth());
    expect(res.status).toBe(200);
    res.body.forEach((row) => {
      Object.keys(row).forEach((k) => {
        expect(k.toLowerCase()).not.toMatch(/saldo|balance/);
      });
    });
  });
});

describe('GET /api/metodos-pago — filtros activo + deleted_at', () => {
  let inactivoId, deletedId;

  beforeAll(async () => {
    // Insertar dos rows en el tenant 1 (donde está el testadmin) para validar
    // los filtros: una con activo=false y otra con deleted_at IS NOT NULL.
    const { rows: r1 } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, orden, activo, tenant_id)
       VALUES ('MP_TEST_INACTIVO', 'ARS', 999, false, 1) RETURNING id`
    );
    inactivoId = r1[0].id;
    const { rows: r2 } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, orden, activo, deleted_at, tenant_id)
       VALUES ('MP_TEST_DELETED', 'ARS', 999, true, NOW(), 1) RETURNING id`
    );
    deletedId = r2[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM metodos_pago WHERE id IN ($1, $2)`, [inactivoId, deletedId]);
  });

  it('NO incluye filas con activo=false', async () => {
    const res = await request(app).get('/api/metodos-pago').set(auth());
    expect(res.status).toBe(200);
    const ids = res.body.map((r) => r.id);
    expect(ids).not.toContain(inactivoId);
  });

  it('NO incluye filas soft-deleted (deleted_at IS NOT NULL)', async () => {
    const res = await request(app).get('/api/metodos-pago').set(auth());
    expect(res.status).toBe(200);
    const ids = res.body.map((r) => r.id);
    expect(ids).not.toContain(deletedId);
  });
});

// Aislamiento multi-tenant — mismo caveat que multitenant-isolation.test.js:
// en local con superuser RLS no aplica de verdad. En CI/staging/prod (role
// no-super) la policy RLS filtra de verdad. Igual el test ES útil porque:
//   - Valida que los users de cada tenant pueden hacer login y consumir el
//     endpoint sin errores (smoke).
//   - Si en el futuro alguien cambia el endpoint a `adminQuery` (sin
//     withTenant) la regresión es visible aunque el filtrado RLS no se haga.
describe('GET /api/metodos-pago — aislamiento multi-tenant (smoke)', () => {
  let tokenA, tokenB;

  it('login del user A del tenant MP_A devuelve JWT con tenant_id correcto', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .send({ username: USER_MP_A.username, password: USER_MP_A.password });
    expect(r.status).toBe(200);
    tokenA = r.body.token;
    const payload = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64').toString());
    expect(payload.tenant_id).toBe(TENANT_MP_A);
  });

  it('login del user B del tenant MP_B devuelve JWT con tenant_id correcto', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .send({ username: USER_MP_B.username, password: USER_MP_B.password });
    expect(r.status).toBe(200);
    tokenB = r.body.token;
    const payload = JSON.parse(Buffer.from(tokenB.split('.')[1], 'base64').toString());
    expect(payload.tenant_id).toBe(TENANT_MP_B);
  });

  it('user A ve sus métodos (MP_ISO_A_*) en /api/metodos-pago', async () => {
    const r = await request(app).get('/api/metodos-pago').set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    const nombres = r.body.map((m) => m.nombre).filter((n) => n.startsWith('MP_ISO_'));
    expect(nombres.sort()).toEqual(expect.arrayContaining(['MP_ISO_A_ARS', 'MP_ISO_A_USD']));
  });

  it('user B ve sus métodos (MP_ISO_B_*) en /api/metodos-pago', async () => {
    const r = await request(app).get('/api/metodos-pago').set('Authorization', `Bearer ${tokenB}`);
    expect(r.status).toBe(200);
    const nombres = r.body.map((m) => m.nombre).filter((n) => n.startsWith('MP_ISO_'));
    expect(nombres.sort()).toEqual(expect.arrayContaining(['MP_ISO_B_ARS']));
  });
});
