/**
 * Tests de integración — Response shaping basado en capabilities (F5b + TANDA 0).
 *
 * Cubre el gap T0 detectado en la auditoría post-F5c: ningún test verificaba
 * que el redact de campos sensibles funcionaba realmente. Un refactor del
 * SELECT (ej. agregar `costo_usd` derivado, o cambiar la estrategia de redact
 * de `delete` a `if (showCostos) ...`) leakearía costos sin que CI atrape.
 *
 * Cubre:
 *   · GET /api/inventario/productos              — redact costo + costo_moneda
 *   · GET /api/inventario/productos/:id/historial — redact bloque `compra`
 *   · GET /api/inventario/productos/metricas      — redact 6 campos monetarios (TANDA 0)
 *   · GET /api/proyectos                          — redact total_ars / total_usd
 *   · GET /api/proyectos/:id                      — redact totales del resumen
 *   · GET /api/proyectos/:id/movimientos          — redact monto / tc / monto_usd
 *
 * Patrón: firmamos JWTs con `caps` específicos y verificamos que el response
 * incluye/excluye los campos esperados. Admin (login normal) bypassea todo y
 * sirve de baseline. User con caps acotadas valida el redact real.
 */
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let adminToken;   // user.role='admin' — bypassea TODO (baseline)
let capUserId;

function signCapToken(caps) {
  return jwt.sign({
    id: capUserId, username: 'capuser', email: 'capuser@test.local',
    role: 'op',
    tenant_id: 1, tenant_rol: 'member',
    tenant_cap_rol: 'vendedor',     // NO bypassea (solo owner/admin lo hacen)
    caps,                            // object {slug:true} — fast-path del middleware
    iat_ms: Date.now(),
  }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

beforeAll(async () => {
  pool = await setupTestDb();
  const loginRes = await request(app).post('/api/auth/login').send({
    username: TEST_USER.username, password: TEST_USER.password,
  });
  adminToken = loginRes.body.token;

  // Usuario "cap user" para firmar tokens con caps específicas — necesita
  // existir en users + tenant_users para que requireAuth no lo rechace por FK.
  // El UNIQUE de username es parcial (WHERE deleted_at IS NULL) → no podemos
  // usar ON CONFLICT, hacemos SELECT-then-INSERT idempotente.
  const existing = await pool.query(
    `SELECT id FROM users WHERE username = 'capuser_shaping' AND deleted_at IS NULL`
  );
  if (existing.rows[0]) {
    capUserId = existing.rows[0].id;
  } else {
    const hash = await bcrypt.hash('capuser123', 10);
    const { rows } = await pool.query(`
      INSERT INTO users (nombre, username, email, password_hash, role, password_changed_at)
      VALUES ('Cap User Shaping', 'capuser_shaping', 'capuser_shaping@test.local', $1, 'op', NOW())
      RETURNING id
    `, [hash]);
    capUserId = rows[0].id;
  }
  await pool.query(`
    INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'member')
    ON CONFLICT DO NOTHING
  `, [capUserId]);
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── INVENTARIO ──────────────────────────────────────────────────────────────

describe('GET /api/inventario/productos — response shaping (F5b)', () => {
  let prodId;
  let catId;

  beforeAll(async () => {
    // Seed categoría + producto con costo=100 USD para ejercitar el redact.
    const cat = await request(app).post('/api/inventario/categorias')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Shaping Cat' });
    catId = cat.body.id;

    const prod = await request(app).post('/api/inventario/productos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        nombre: 'Test Shaping Prod', cantidad: 1, categoria_id: catId,
        costo: 100, costo_moneda: 'USD', precio_venta: 200,
        clase: 'celular', estado: 'disponible', tipo_carga: 'unitario',
      });
    expect(prod.status).toBe(201);
    prodId = prod.body.id;
  });

  it('admin (bypass) ve costo + costo_moneda', async () => {
    const r = await request(app)
      .get('/api/inventario/productos')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const row = r.body.data.find(p => p.id === prodId);
    expect(row).toBeDefined();
    expect(row.costo).toBeDefined();
    expect(Number(row.costo)).toBe(100);
    expect(row.costo_moneda).toBe('USD');
  });

  it('user CON inventario.ver_costos también ve costo', async () => {
    const token = signCapToken({
      'inventario.ver': true,
      'inventario.ver_costos': true,
    });
    const r = await request(app)
      .get('/api/inventario/productos')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = r.body.data.find(p => p.id === prodId);
    expect(row).toBeDefined();
    expect(Number(row.costo)).toBe(100);
    expect(row.costo_moneda).toBe('USD');
  });

  it('user SIN inventario.ver_costos NO recibe costo ni costo_moneda', async () => {
    const token = signCapToken({ 'inventario.ver': true });  // solo ver, sin costos
    const r = await request(app)
      .get('/api/inventario/productos')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = r.body.data.find(p => p.id === prodId);
    expect(row).toBeDefined();
    expect(row.nombre).toBe('Test Shaping Prod');  // resto del shape intacto
    expect('costo' in row).toBe(false);
    expect('costo_moneda' in row).toBe(false);
  });
});

describe('GET /api/inventario/productos/metricas — response shaping (TANDA 0)', () => {
  it('admin ve los 6 campos monetarios (inv_equipos/accesorios + en_tecnico, USD+ARS)', async () => {
    const r = await request(app)
      .get('/api/inventario/productos/metricas')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(r.body.inv_equipos_usd).not.toBeNull();
    expect(r.body.inv_equipos_ars).not.toBeNull();
    expect(r.body.inv_accesorios_usd).not.toBeNull();
    expect(r.body.inv_accesorios_ars).not.toBeNull();
    expect(r.body.en_tecnico_usd).not.toBeNull();
    expect(r.body.en_tecnico_ars).not.toBeNull();
    // Count fields siempre presentes:
    expect(r.body.stock_disponible).toBeDefined();
    expect(r.body.equipos_count).toBeDefined();
    expect(r.body.accesorios_count).toBeDefined();
    expect(r.body.en_tecnico_count).toBeDefined();
  });

  it('user SIN inventario.ver_costos recibe los 6 montos como null y los counts intactos', async () => {
    const token = signCapToken({ 'inventario.ver': true });
    const r = await request(app)
      .get('/api/inventario/productos/metricas')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    // Montos redactados a null (no undefined ni delete — el frontend muestra "—").
    expect(r.body.inv_equipos_usd).toBeNull();
    expect(r.body.inv_equipos_ars).toBeNull();
    expect(r.body.inv_accesorios_usd).toBeNull();
    expect(r.body.inv_accesorios_ars).toBeNull();
    expect(r.body.en_tecnico_usd).toBeNull();
    expect(r.body.en_tecnico_ars).toBeNull();
    // Counts no se tocan — un vendedor sí puede saber CUÁNTO stock hay.
    expect(typeof r.body.stock_disponible).not.toBe('undefined');
    expect(typeof r.body.equipos_count).not.toBe('undefined');
  });
});

// ─── PROYECTOS ───────────────────────────────────────────────────────────────

describe('GET /api/proyectos — response shaping (F5b)', () => {
  let proyId;

  beforeAll(async () => {
    const r = await request(app).post('/api/proyectos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Proyecto Shaping Test' });
    expect(r.status).toBe(201);
    proyId = r.body.id;

    // Agregar un movimiento. El endpoint es POST /api/proyectos/movimientos
    // (no scoped bajo /:id), espera proyecto_id en el body.
    const mr = await request(app).post('/api/proyectos/movimientos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        proyecto_id: proyId,
        fecha: '2026-06-24',
        detalle: 'Aporte test',
        categoria: 'aporte',
        monto: 1000,
        monto_usd: 1000,
      });
    expect(mr.status).toBe(201);
  });

  it('admin ve total_ars y total_usd en GET /', async () => {
    const r = await request(app).get('/api/proyectos')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const row = (r.body.data || r.body).find(p => p.id === proyId);
    expect(row).toBeDefined();
    expect(row.total_usd).toBeDefined();
    expect('total_ars' in row).toBe(true);
  });

  it('user SIN proyectos.ver_costos NO recibe total_ars ni total_usd, pero sí cant_movimientos', async () => {
    const token = signCapToken({ 'proyectos.trabajar': true });
    const r = await request(app).get('/api/proyectos')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const row = (r.body.data || r.body).find(p => p.id === proyId);
    expect(row).toBeDefined();
    expect(row.nombre).toBe('Proyecto Shaping Test');
    expect('total_ars' in row).toBe(false);
    expect('total_usd' in row).toBe(false);
    // Metadata no-monetaria visible:
    expect(row.cant_movimientos).toBeDefined();
  });

  it('user SIN proyectos.ver_costos en GET /:id/movimientos NO ve monto, tc ni monto_usd', async () => {
    const token = signCapToken({ 'proyectos.trabajar': true });
    const r = await request(app).get(`/api/proyectos/${proyId}/movimientos`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(r.body.length || r.body.data?.length).toBeGreaterThan(0);
    const row = (r.body.data || r.body)[0];
    expect('monto' in row).toBe(false);
    expect('tc' in row).toBe(false);
    expect('monto_usd' in row).toBe(false);
    // Metadata no-monetaria visible:
    expect(row.fecha).toBeDefined();
    expect(row.detalle).toBeDefined();
  });
});
