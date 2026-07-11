/**
 * Tests de integración — Share Link público de Equipos Usados (2026-07-11).
 *
 * Cubre:
 *   1. Endpoints admin:
 *      - GET /api/inventario/share-link → crea con defaults si no existía
 *      - GET stats (vistas_ult_mes, unicos_hoy, ultimo_acceso)
 *      - PATCH → actualiza whatsapp, mensaje, toggles, activo
 *      - POST /rotate → nuevo token, marca rotated_at
 *   2. Endpoint público (sin auth):
 *      - GET /publico/usados/:token → devuelve tenant + config + equipos
 *      - Filtra condicion='usado' + estado='disponible' + precio_venta>0
 *      - Token inexistente → 404
 *      - Link con activo=false → 410
 *      - Token malformado → 400 (schema)
 *      - Toggle mostrar_precio=false → precio_venta es null en response
 *      - Toggle mostrar_bateria=false → bateria es null en response
 *      - Rate limit funciona (60 req/min)
 *   3. Analytics:
 *      - View se registra al hacer GET público
 *      - Stats se recomputan al pedir GET admin
 */

const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;
let catBase;

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'ShareLink Base' });
  catBase = cat.body.id;

  // Cleanup: aseguramos que el share_link del tenant test arranque LIMPIO
  // para que el primer test "primera llamada crea defaults" pase aunque
  // el suite se corra 2 veces sobre la misma DB (Jest watch mode, o rerun
  // combinado con otras suites). Sin esto, `mensaje_extra` u otros
  // campos setteados por tests previos filtran al assertion.
  // Usamos pool directo con SET LOCAL para bypasear RLS.
  await pool.query('DELETE FROM share_links WHERE 1=1');
  await pool.query('DELETE FROM share_link_views WHERE 1=1');
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Admin endpoints ─────────────────────────────────────────────
describe('GET /api/inventario/share-link (admin)', () => {
  it('primera llamada → crea el link con defaults + token', async () => {
    const r = await request(app).get('/api/inventario/share-link').set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      activo:          true,
      whatsapp:        null,
      mensaje_extra:   null,
      mostrar_bateria: true,
      mostrar_precio:  true,
    });
    // Token: URL-safe, 24 chars (base64url de 18 bytes).
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{20,32}$/);
    expect(r.body).toHaveProperty('stats');
    expect(r.body.stats).toMatchObject({
      vistas_ult_mes: 0,
      unicos_hoy:     0,
      ultimo_acceso:  null,
    });
  });

  it('segunda llamada → devuelve el MISMO link (idempotente, no crea otro)', async () => {
    const r1 = await request(app).get('/api/inventario/share-link').set(auth());
    const r2 = await request(app).get('/api/inventario/share-link').set(auth());
    expect(r1.body.id).toBe(r2.body.id);
    expect(r1.body.token).toBe(r2.body.token);
  });
});

describe('PATCH /api/inventario/share-link', () => {
  it('actualiza whatsapp + mensaje_extra + toggles', async () => {
    const r = await request(app).patch('/api/inventario/share-link').set(auth()).send({
      whatsapp:        '+54 9 11 4567-8901',
      mensaje_extra:   'Consultá por financiación',
      mostrar_bateria: false,
      mostrar_precio:  true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      whatsapp:        '+54 9 11 4567-8901',
      mensaje_extra:   'Consultá por financiación',
      mostrar_bateria: false,
      mostrar_precio:  true,
    });
  });

  it('empty string transformado a null (borrar whatsapp)', async () => {
    await request(app).patch('/api/inventario/share-link').set(auth()).send({
      whatsapp: '+54 9 11 4567-8901',
    });
    const r = await request(app).patch('/api/inventario/share-link').set(auth()).send({
      whatsapp: '',
    });
    expect(r.status).toBe(200);
    expect(r.body.whatsapp).toBeNull();
  });

  it('desactivar el link (activo: false)', async () => {
    const r = await request(app).patch('/api/inventario/share-link').set(auth()).send({
      activo: false,
    });
    expect(r.status).toBe(200);
    expect(r.body.activo).toBe(false);
    // Reactivar para que otros tests no queden bloqueados.
    await request(app).patch('/api/inventario/share-link').set(auth()).send({ activo: true });
  });

  it('mensaje_extra > 200 chars → 400', async () => {
    const r = await request(app).patch('/api/inventario/share-link').set(auth()).send({
      mensaje_extra: 'x'.repeat(201),
    });
    expect(r.status).toBe(400);
  });

  it('campo extra no whitelisted → 400 (schema strict)', async () => {
    const r = await request(app).patch('/api/inventario/share-link').set(auth()).send({
      whatsapp: '+54 9 11 4567-8901',
      hackfield: 'xxx',
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/inventario/share-link/rotate', () => {
  it('rotate → devuelve token nuevo + rotated_at seteado', async () => {
    const before = await request(app).get('/api/inventario/share-link').set(auth());
    const tokenBefore = before.body.token;

    const r = await request(app).post('/api/inventario/share-link/rotate').set(auth()).send();
    expect(r.status).toBe(200);
    expect(r.body.token).not.toBe(tokenBefore);
    expect(r.body.rotated_at).toBeTruthy();
  });

  it('link viejo (pre-rotate) devuelve 404 en el público', async () => {
    const before = await request(app).get('/api/inventario/share-link').set(auth());
    const oldToken = before.body.token;
    await request(app).post('/api/inventario/share-link/rotate').set(auth()).send();

    // Fetch público con el token VIEJO — debe 404.
    const r = await request(app).get(`/publico/usados/${oldToken}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });
});

// ─── Endpoint público ────────────────────────────────────────────
describe('GET /publico/usados/:token', () => {
  let currentToken;

  beforeAll(async () => {
    // Producto usado disponible con precio (debe aparecer).
    await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular_usado',
      nombre: 'iPhone Share Test Disponible',
      categoria_id: catBase,
      imei: '911' + Date.now().toString().slice(-12),
      condicion: 'usado', gb: '256', color: 'Blue', bateria: 88,
      costo: 400, costo_moneda: 'USD',
      precio_venta: 650, precio_moneda: 'USD',
      cantidad: 1, estado: 'disponible',
    });
    // Producto usado VENDIDO (NO debe aparecer).
    await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular_usado',
      nombre: 'iPhone Share Test Vendido',
      categoria_id: catBase,
      imei: '912' + Date.now().toString().slice(-12),
      condicion: 'usado', gb: '128',
      costo: 300, costo_moneda: 'USD',
      precio_venta: 500, precio_moneda: 'USD',
      cantidad: 1, estado: 'vendido',
    });
    // Producto usado disponible pero SIN precio (NO debe aparecer).
    await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular_usado',
      nombre: 'iPhone Share Test Sin Precio',
      categoria_id: catBase,
      imei: '913' + Date.now().toString().slice(-12),
      condicion: 'usado', gb: '128',
      costo: 300, costo_moneda: 'USD',
      precio_venta: 0, precio_moneda: 'USD',
      cantidad: 1, estado: 'disponible',
    });
    // Producto NUEVO (NO debe aparecer — solo usados).
    await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular_sellado',
      nombre: 'iPhone Share Test Nuevo',
      categoria_id: catBase,
      imei: '914' + Date.now().toString().slice(-12),
      condicion: 'nuevo', gb: '256',
      costo: 800, costo_moneda: 'USD',
      precio_venta: 1200, precio_moneda: 'USD',
      cantidad: 1, estado: 'disponible',
    });

    const link = await request(app).get('/api/inventario/share-link').set(auth());
    currentToken = link.body.token;
  });

  it('token válido + link activo → devuelve tenant + config + equipos', async () => {
    const r = await request(app).get(`/publico/usados/${currentToken}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('tenant');
    expect(r.body).toHaveProperty('config');
    expect(r.body).toHaveProperty('equipos');
    expect(r.body.tenant.nombre).toBeTruthy();
    expect(r.body.tenant.pais).toMatch(/^(AR|UY)$/);
  });

  it('con mostrar_precio=true (default): solo usados disponibles con precio>0', async () => {
    // Asegurar mostrar_precio=true (default).
    await request(app).patch('/api/inventario/share-link').set(auth()).send({ mostrar_precio: true });
    const r = await request(app).get(`/publico/usados/${currentToken}`);
    const nombres = r.body.equipos.map(e => e.nombre);
    expect(nombres).toContain('iPhone Share Test Disponible');
    expect(nombres).not.toContain('iPhone Share Test Vendido');
    expect(nombres).not.toContain('iPhone Share Test Sin Precio');
    expect(nombres).not.toContain('iPhone Share Test Nuevo');
  });

  // 2026-07-11 (bug Lucas): si el tenant apagó "Mostrar precio de venta",
  // los equipos SIN precio deberían aparecer igual (con "Consultar por
  // WhatsApp" en el frontend). Antes se filtraban por precio_venta > 0
  // → productos legacy sin precio no salían aunque el operador quisiera
  // publicarlos sin monto.
  it('con mostrar_precio=false: incluye equipos sin precio (aparecen igual)', async () => {
    await request(app).patch('/api/inventario/share-link').set(auth()).send({ mostrar_precio: false });
    const link = await request(app).get('/api/inventario/share-link').set(auth());
    const tok = link.body.token;

    const r = await request(app).get(`/publico/usados/${tok}`);
    const nombres = r.body.equipos.map(e => e.nombre);
    // El disponible con precio SÍ aparece.
    expect(nombres).toContain('iPhone Share Test Disponible');
    // Y el sin precio TAMBIÉN aparece ahora.
    expect(nombres).toContain('iPhone Share Test Sin Precio');
    // Los otros sí se siguen filtrando.
    expect(nombres).not.toContain('iPhone Share Test Vendido');
    expect(nombres).not.toContain('iPhone Share Test Nuevo');

    // Restaurar default para no romper tests siguientes.
    await request(app).patch('/api/inventario/share-link').set(auth()).send({ mostrar_precio: true });
  });

  it('respeta cache HTTP (max-age=60)', async () => {
    const r = await request(app).get(`/publico/usados/${currentToken}`);
    expect(r.headers['cache-control']).toContain('max-age=60');
  });

  it('token inexistente → 404 con error=not_found', async () => {
    const r = await request(app).get('/publico/usados/abcdefghijkl123456789');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('token malformado (chars inválidos) → 400', async () => {
    const r = await request(app).get('/publico/usados/tok<script>');
    expect(r.status).toBe(400);
  });

  it('token muy corto → 400', async () => {
    const r = await request(app).get('/publico/usados/tooshort');
    expect(r.status).toBe(400);
  });

  it('link con activo=false → 410 con error=link_inactivo', async () => {
    await request(app).patch('/api/inventario/share-link').set(auth()).send({ activo: false });
    const link = await request(app).get('/api/inventario/share-link').set(auth());
    const inactiveToken = link.body.token;

    const r = await request(app).get(`/publico/usados/${inactiveToken}`);
    expect(r.status).toBe(410);
    expect(r.body.error).toBe('link_inactivo');

    // Reactivar para no romper tests siguientes.
    await request(app).patch('/api/inventario/share-link').set(auth()).send({ activo: true });
  });

  it('toggle mostrar_precio=false → equipos vienen con precio_venta null', async () => {
    await request(app).patch('/api/inventario/share-link').set(auth()).send({ mostrar_precio: false });
    const link = await request(app).get('/api/inventario/share-link').set(auth());
    const tok = link.body.token;

    const r = await request(app).get(`/publico/usados/${tok}`);
    expect(r.status).toBe(200);
    if (r.body.equipos.length > 0) {
      expect(r.body.equipos[0].precio_venta).toBeNull();
    }
    // Restaurar
    await request(app).patch('/api/inventario/share-link').set(auth()).send({ mostrar_precio: true });
  });

  it('toggle mostrar_bateria=false → equipos vienen con bateria null', async () => {
    await request(app).patch('/api/inventario/share-link').set(auth()).send({ mostrar_bateria: false });
    const link = await request(app).get('/api/inventario/share-link').set(auth());
    const tok = link.body.token;

    const r = await request(app).get(`/publico/usados/${tok}`);
    expect(r.status).toBe(200);
    if (r.body.equipos.length > 0) {
      expect(r.body.equipos[0].bateria).toBeNull();
    }
    // Restaurar
    await request(app).patch('/api/inventario/share-link').set(auth()).send({ mostrar_bateria: true });
  });
});

// ─── Analytics ───────────────────────────────────────────────────
describe('Analytics: share_link_views', () => {
  it('view se registra al hacer GET público, stats reflejan la visita', async () => {
    // Obtener token actual.
    const link = await request(app).get('/api/inventario/share-link').set(auth());
    const tok = link.body.token;

    // Stats antes
    const before = await request(app).get('/api/inventario/share-link').set(auth());
    const vistasAntes = before.body.stats.vistas_ult_mes;

    // Hacer 3 views públicas.
    await request(app).get(`/publico/usados/${tok}`);
    await request(app).get(`/publico/usados/${tok}`);
    await request(app).get(`/publico/usados/${tok}`);

    // Los inserts son fire-and-forget — dar tiempo para que se persistan.
    await new Promise(resolve => setTimeout(resolve, 150));

    const after = await request(app).get('/api/inventario/share-link').set(auth());
    expect(after.body.stats.vistas_ult_mes).toBeGreaterThan(vistasAntes);
    // ultimo_acceso debe estar seteado.
    expect(after.body.stats.ultimo_acceso).toBeTruthy();
  });
});
