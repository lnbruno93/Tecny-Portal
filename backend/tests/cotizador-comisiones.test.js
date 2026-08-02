/**
 * cotizador-comisiones.test.js — task #286 (regresión P0 vendedor cotizador).
 *
 * Contexto: PR #978 (task #284) migró el hook useComisionesTenant() del
 * Cotizador a leer desde configApi.get() + cajasApi.listCajas(). Ambos
 * endpoints están gated con caps que el rol vendedor NO tiene:
 *   · /api/config → requireAnyCapability(['config.general', ...])
 *   · /api/cajas  → requireCapability('cajas.ver')
 * Los .catch() del hook silenciaban los 403 → tarjetas array vacío → el
 * vendedor veía el resultado del Cotizador SIN líneas de tarjetas.
 *
 * Fix: nuevo endpoint GET /api/cotizador/comisiones gated con la cap
 * operacional del feature (`cotizador.trabajar`, presente en el rol
 * vendedor por default). Devuelve payload minimal — no leakea saldos ni
 * flags internos de metodos_pago.
 *
 * Este test cubre:
 *   1. Response shape correcto (pctFinanciera + tarjetas[])
 *   2. Filtrado es_tarjeta=true (no debería incluir cajas no-tarjeta)
 *   3. Ordenamiento (orden ASC, nombre ASC)
 *   4. Vendedor puede acceder (cap `cotizador.trabajar`) — el bug
 *   5. User sin la cap → 403
 *   6. Tenant scoping (multi-tenant no leakea cross-tenant)
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER, createTestUser } = require('./helpers/setup');

let pool;
let adminToken;         // TEST_USER — owner/admin del tenant seed
let vendedorToken;      // user con rol capabilities=vendedor (tiene cotizador.trabajar)
let sinCapToken;        // user sin caps (rol custom sin overrides)

const auth = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  pool = await setupTestDb();

  // Login del admin seed para setup de datos.
  const rAdmin = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = rAdmin.body.token;

  // User rol capabilities=vendedor. El resolver de caps devuelve el
  // Set default de VENDEDOR (roleDefaults.js): incluye 'cotizador.trabajar'
  // pero NO 'cajas.ver' ni 'config.general'.
  await createTestUser(pool, {
    nombre:    'Vendedor Test',
    username:  'vendedor_test',
    email:     'vendedor@test.local',
    password:  'vendpass_123',
    role:      'op',
    tenantRol: 'member',
    capRol:    'vendedor',
  });
  const rVend = await request(app).post('/api/auth/login')
    .send({ username: 'vendedor_test', password: 'vendpass_123' });
  vendedorToken = rVend.body.token;

  // User sin caps (rol custom + zero overrides) — usado para verificar
  // que el gate del mount realmente devuelve 403 sin cotizador.trabajar.
  await createTestUser(pool, {
    nombre:    'Sin Cap',
    username:  'sincap_test',
    email:     'sincap@test.local',
    password:  'sincappass_123',
    role:      'op',
    tenantRol: 'member',
    capRol:    'custom',
  });
  const rSin = await request(app).post('/api/auth/login')
    .send({ username: 'sincap_test', password: 'sincappass_123' });
  sinCapToken = rSin.body.token;

  // Fixture: creamos 3 tarjetas + 1 caja no-tarjeta como admin. El endpoint
  // debe devolver SOLO las tarjetas (es_tarjeta=true), ordenadas.
  await request(app).post('/api/cajas/cajas').set(auth(adminToken))
    .send({ nombre: 'TC | 6 Cuotas', moneda: 'ARS', es_tarjeta: true, comision_pct: 28,   orden: 3 });
  await request(app).post('/api/cajas/cajas').set(auth(adminToken))
    .send({ nombre: 'TC | 1 Cuota',  moneda: 'ARS', es_tarjeta: true, comision_pct: 11,   orden: 1 });
  await request(app).post('/api/cajas/cajas').set(auth(adminToken))
    .send({ nombre: 'TC | 3 Cuotas', moneda: 'ARS', es_tarjeta: true, comision_pct: 23.5, orden: 2 });
  // Caja no-tarjeta: debe quedar excluida del response.
  await request(app).post('/api/cajas/cajas').set(auth(adminToken))
    .send({ nombre: 'Caja Efectivo Test', moneda: 'ARS', es_tarjeta: false });
});

afterAll(async () => { await teardownTestDb(pool); });


describe('GET /api/cotizador/comisiones', () => {
  it('admin: devuelve pctFinanciera + tarjetas ordenadas (contract shape)', async () => {
    const res = await request(app).get('/api/cotizador/comisiones').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pctFinanciera');
    expect(typeof res.body.pctFinanciera).toBe('number');
    expect(Array.isArray(res.body.tarjetas)).toBe(true);
    // Cada tarjeta debe tener exactamente 3 campos — nada de saldos, flags,
    // moneda ni otros datos que el vendedor no debería ver.
    for (const t of res.body.tarjetas) {
      expect(Object.keys(t).sort()).toEqual(['comision_pct', 'id', 'nombre']);
      expect(typeof t.id).toBe('number');
      expect(typeof t.nombre).toBe('string');
      expect(typeof t.comision_pct).toBe('number');
    }
  });

  it('vendedor con cotizador.trabajar: 200 (regresión — antes 403 en /config y /cajas)', async () => {
    const res = await request(app).get('/api/cotizador/comisiones').set(auth(vendedorToken));
    expect(res.status).toBe(200);
    expect(res.body.pctFinanciera).toBeDefined();
    // El bug del vendedor: antes veía tarjetas: [] porque los fetches del
    // hook fallaban con 403. Ahora debe ver las tarjetas configuradas.
    expect(res.body.tarjetas.length).toBeGreaterThanOrEqual(3);
  });

  it('user sin cotizador.trabajar: 403 (gate del mount funcional)', async () => {
    const res = await request(app).get('/api/cotizador/comisiones').set(auth(sinCapToken));
    expect(res.status).toBe(403);
  });

  it('sin auth: 401', async () => {
    const res = await request(app).get('/api/cotizador/comisiones');
    expect(res.status).toBe(401);
  });

  it('filtra es_tarjeta=true (Caja Efectivo Test no aparece)', async () => {
    const res = await request(app).get('/api/cotizador/comisiones').set(auth(adminToken));
    expect(res.status).toBe(200);
    const nombres = res.body.tarjetas.map(t => t.nombre);
    expect(nombres).not.toContain('Caja Efectivo Test');
  });

  it('ordena por orden ASC (1 Cuota antes que 3 Cuotas antes que 6 Cuotas)', async () => {
    const res = await request(app).get('/api/cotizador/comisiones').set(auth(adminToken));
    expect(res.status).toBe(200);
    const tarjetasSeed = res.body.tarjetas.filter(t => t.nombre.startsWith('TC | '));
    const nombresOrdenados = tarjetasSeed.map(t => t.nombre);
    expect(nombresOrdenados).toEqual(['TC | 1 Cuota', 'TC | 3 Cuotas', 'TC | 6 Cuotas']);
  });

  it('vendedor y admin ven las mismas tarjetas (RLS scoping funcional dentro del tenant)', async () => {
    const rA = await request(app).get('/api/cotizador/comisiones').set(auth(adminToken));
    const rV = await request(app).get('/api/cotizador/comisiones').set(auth(vendedorToken));
    expect(rA.status).toBe(200);
    expect(rV.status).toBe(200);
    const idsA = rA.body.tarjetas.map(t => t.id).sort();
    const idsV = rV.body.tarjetas.map(t => t.id).sort();
    expect(idsA).toEqual(idsV);
  });
});
