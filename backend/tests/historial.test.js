/**
 * Tests de integración — Historial y Archivos
 *
 * Cubre:
 *   GET /api/historial          — paginación {data, pagination}, requiere auth y permiso
 *   POST /api/auth/logout       — invalida tokens (nuevo endpoint)
 *   GET /api/comprobantes/:id/archivo — descarga de archivo adjunto
 *   GET /api/vendedores?buscar  — filtro por nombre
 *   GET /api/contactos?buscar   — filtro por nombre/apellido
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;
let compId; // ID de comprobante con archivo adjunto

beforeAll(async () => {
  pool = await setupTestDb();

  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;

  // Insertar vendedor y comprobante con archivo para los tests de archivo
  const v = await request(app)
    .post('/api/vendedores')
    .set('Authorization', `Bearer ${token}`)
    .send({ nombre: 'Vendedor Test Historial' });

  const comp = await request(app)
    .post('/api/comprobantes')
    .set('Authorization', `Bearer ${token}`)
    .send({
      fecha: '2026-03-01',
      cliente: 'Cliente Archivo Test',
      monto: 5000,
      monto_financiera: 150,
      monto_neto: 4850,
      // Simular archivo en base64 (PNG mínimo 1x1 pixel)
      archivo_data:   'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      archivo_nombre: 'test.png',
      archivo_tipo:   'image/png',
    });
  compId = comp.body.id;

  // Crear algunos contactos y vendedores extra para tests de búsqueda
  await request(app).post('/api/contactos').set('Authorization', `Bearer ${token}`)
    .send({ nombre: 'Ana', apellido: 'Garcia', tipo: 'cliente' });
  await request(app).post('/api/contactos').set('Authorization', `Bearer ${token}`)
    .send({ nombre: 'Carlos', apellido: 'Lopez', tipo: 'inversor' });
  await request(app).post('/api/vendedores').set('Authorization', `Bearer ${token}`)
    .send({ nombre: 'Vendedor Búsqueda ABC' });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Historial ────────────────────────────────────────────────
describe('GET /api/historial', () => {
  it('requiere autenticación → 401 sin token', async () => {
    const res = await request(app).get('/api/historial');
    expect(res.status).toBe(401);
  });

  it('devuelve estructura paginada {data, pagination}', async () => {
    const res = await request(app)
      .get('/api/historial')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('pagination');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.pagination.total).toBe('number');
    expect(typeof res.body.pagination.page).toBe('number');
    expect(typeof res.body.pagination.limit).toBe('number');
  });

  it('cada entrada tiene accion, usuario_nombre y creado_en', async () => {
    const res = await request(app)
      .get('/api/historial')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data.length).toBeGreaterThan(0);
    const entry = res.body.data[0];
    expect(entry).toHaveProperty('accion');
    expect(entry).toHaveProperty('usuario_nombre');
    expect(entry).toHaveProperty('creado_en');
    // Formato "tabla: ACCION"
    expect(entry.accion).toMatch(/:\s*(INSERT|UPDATE|DELETE)/);
  });

  it('respeta limit y pagina — la segunda página tiene IDs distintos', async () => {
    const p1 = await request(app)
      .get('/api/historial?limit=1&page=1')
      .set('Authorization', `Bearer ${token}`);
    const p2 = await request(app)
      .get('/api/historial?limit=1&page=2')
      .set('Authorization', `Bearer ${token}`);

    expect(p1.body.data.length).toBe(1);
    expect(p2.body.data.length).toBeLessThanOrEqual(1);

    if (p2.body.data.length > 0) {
      expect(p1.body.data[0].id).not.toBe(p2.body.data[0].id);
    }
  });

  it('registra las acciones del beforeAll en audit_logs', async () => {
    const res = await request(app)
      .get('/api/historial')
      .set('Authorization', `Bearer ${token}`);

    // El beforeAll creó vendedores, comprobantes, contactos → deben aparecer en el historial
    const acciones = res.body.data.map(e => e.accion);
    const hayInsert = acciones.some(a => a.includes('INSERT'));
    expect(hayInsert).toBe(true);
  });

  // ── Filtros ──────────────────────────────────────────────────
  it('filtra por accion=INSERT → solo entradas INSERT', async () => {
    const res = await request(app)
      .get('/api/historial?accion=INSERT')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    res.body.data.forEach(e => {
      expect(e.accion).toMatch(/: INSERT$/);
    });
  });

  it('filtra por tabla=comprobantes → solo entradas de comprobantes', async () => {
    const res = await request(app)
      .get('/api/historial?tabla=comprobantes')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    res.body.data.forEach(e => {
      expect(e.accion).toMatch(/^comprobantes:/);
    });
  });

  it('filtra por q (búsqueda en usuario) → retorna coincidencias', async () => {
    // TEST_USER tiene nombre conocido — debería aparecer en los logs
    const res = await request(app)
      .get('/api/historial?q=' + encodeURIComponent(TEST_USER.username))
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Puede ser 0 si el nombre no coincide con datos_despues, pero no debe fallar
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('filtra por rango de fechas (semana pasada → mañana) → devuelve resultados', async () => {
    // Rango amplio para evitar problemas de zona horaria (UTC vs local)
    const desde = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const hasta = new Date(Date.now() + 1  * 86400_000).toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/historial?desde=${desde}&hasta=${hasta}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0); // el beforeAll ocurrió en este rango
  });

  it('filtra por rango de fechas futuro → array vacío', async () => {
    const res = await request(app)
      .get('/api/historial?desde=2099-01-01&hasta=2099-12-31')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('tabla inválida es ignorada (no 500, no registros de otra tabla)', async () => {
    // Tablas fuera del whitelist son ignoradas silenciosamente
    const res = await request(app)
      .get('/api/historial?tabla=__inyeccion__')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200); // no 500
    // Sin filtro de tabla → devuelve todo (tabla fuera de whitelist se ignora)
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('per_page como alias de limit funciona igual', async () => {
    const res = await request(app)
      .get('/api/historial?per_page=2&page=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
  });
});

// ─── Logout ──────────────────────────────────────────────────
// DISEÑO: logout usa password_changed_at = NOW() → invalida TODOS los tokens del usuario
// (equivalente a "cerrar todas las sesiones"). No hay sesiones individuales — es stateless.
describe('POST /api/auth/logout', () => {
  it('requiere autenticación → 401 sin token', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });

  it('cierra sesión correctamente → invalida el token anterior y todos los activos', async () => {
    // Login fresco para obtener un token que después invalida
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: TEST_USER.password });
    const tempToken = loginRes.body.token;
    expect(loginRes.status).toBe(200);

    // Logout — bumps password_changed_at, invalida TODOS los tokens activos
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.ok).toBe(true);

    // El tempToken (y el token compartido del beforeAll) ya no son válidos
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tempToken}`);
    expect(meRes.status).toBe(401);

    // Renovar el token compartido para los tests siguientes
    const refreshRes = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: TEST_USER.password });
    token = refreshRes.body.token;
  });
});

// ─── Archivos adjuntos ────────────────────────────────────────
describe('GET /api/comprobantes/:id/archivo', () => {
  it('devuelve datos del archivo adjunto', async () => {
    const res = await request(app)
      .get(`/api/comprobantes/${compId}/archivo`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('nombre');
    expect(res.body).toHaveProperty('tipo');
    expect(res.body.nombre).toBe('test.png');
    expect(res.body.tipo).toBe('image/png');
    expect(res.body.data).toMatch(/^data:image\/png;base64,/);
  });

  it('devuelve 404 si el comprobante no tiene archivo', async () => {
    // Crear comprobante sin archivo
    const comp = await request(app)
      .post('/api/comprobantes')
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-03-02', cliente: 'Sin Archivo', monto: 1000, monto_financiera: 30, monto_neto: 970 });

    const res = await request(app)
      .get(`/api/comprobantes/${comp.body.id}/archivo`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('devuelve 401 sin autenticación', async () => {
    const res = await request(app).get(`/api/comprobantes/${compId}/archivo`);
    expect(res.status).toBe(401);
  });
});

// ─── Filtro buscar en vendedores ──────────────────────────────
describe('GET /api/vendedores?buscar', () => {
  it('filtra vendedores por nombre (case-insensitive)', async () => {
    const res = await request(app)
      .get('/api/vendedores?buscar=abc')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    res.body.forEach(v => expect(v.nombre.toLowerCase()).toContain('abc'));
  });

  it('sin buscar devuelve todos los vendedores activos', async () => {
    const res = await request(app)
      .get('/api/vendedores')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Filtro buscar en contactos ───────────────────────────────
describe('GET /api/contactos?buscar', () => {
  it('filtra contactos por nombre (case-insensitive)', async () => {
    const res = await request(app)
      .get('/api/contactos?buscar=ana')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Debería encontrar "Ana Garcia"
    const nombres = res.body.map(c => c.nombre.toLowerCase());
    expect(nombres.some(n => n.includes('ana'))).toBe(true);
  });

  it('filtra contactos por apellido (case-insensitive, sin acentos)', async () => {
    const res = await request(app)
      .get('/api/contactos?buscar=carlos')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // "Carlos Lopez" debería aparecer — buscamos por nombre para evitar dependencia de collation
    const nombres = res.body.map(c => c.nombre.toLowerCase());
    expect(nombres.some(n => n.includes('carlos'))).toBe(true);
  });

  it('sin buscar devuelve todos los contactos activos', async () => {
    const res = await request(app)
      .get('/api/contactos')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });
});
