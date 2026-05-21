/**
 * Tests de integración — Financiera
 *
 * Cubre:
 *   POST /api/comprobantes              — crear comprobante
 *   GET  /api/comprobantes              — paginación (data, pagination)
 *   GET  /api/comprobantes/totales      — agregados globales
 *   POST /api/pagos                     — crear pago
 *   GET  /api/pagos                     — paginación
 *   GET  /api/pagos/totales             — agregados globales
 *   POST /api/auth/change-password      — cambio de contraseña
 *   GET  /health                        — health check con DB
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;

beforeAll(async () => {
  pool = await setupTestDb();

  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;

  // Crear 3 comprobantes para probar paginación y totales
  await request(app).post('/api/comprobantes').set('Authorization', `Bearer ${token}`)
    .send({ fecha: '2026-01-10', cliente: 'Cliente A', monto: 10000, monto_financiera: 300, monto_neto: 9700 });
  await request(app).post('/api/comprobantes').set('Authorization', `Bearer ${token}`)
    .send({ fecha: '2026-01-15', cliente: 'Cliente B', monto: 20000, monto_financiera: 600, monto_neto: 19400 });
  await request(app).post('/api/comprobantes').set('Authorization', `Bearer ${token}`)
    .send({ fecha: '2026-01-20', cliente: 'Cliente C', monto: 5000,  monto_financiera: 150, monto_neto: 4850 });

  // Crear 2 pagos
  await request(app).post('/api/pagos').set('Authorization', `Bearer ${token}`)
    .send({ fecha: '2026-01-12', monto: 5000,  referencia: 'Pago 1' });
  await request(app).post('/api/pagos').set('Authorization', `Bearer ${token}`)
    .send({ fecha: '2026-01-22', monto: 10000, referencia: 'Pago 2' });
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Health check ─────────────────────────────────────────────
describe('GET /health', () => {
  it('devuelve 200 con DB conectada', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db.status).toBe('ok');
    expect(typeof res.body.db.latency_ms).toBe('number');
    expect(res.body.db.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('incluye uptime, memoria y versión', async () => {
    const res = await request(app).get('/health');

    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.memory).toHaveProperty('rss_mb');
    expect(res.body.memory).toHaveProperty('heap_used_mb');
    expect(res.body.memory).toHaveProperty('heap_total_mb');
    expect(res.body).toHaveProperty('version');
  });
});

// ─── Comprobantes — paginación ────────────────────────────────
describe('GET /api/comprobantes — paginación', () => {
  it('devuelve estructura paginada {data, pagination}', async () => {
    const res = await request(app)
      .get('/api/comprobantes')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('pagination');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('respeta el parámetro limit', async () => {
    const res = await request(app)
      .get('/api/comprobantes?limit=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.pagination.limit).toBe(1);
    expect(res.body.pagination.total).toBeGreaterThanOrEqual(3);
    expect(res.body.pagination.pages).toBeGreaterThanOrEqual(3);
  });

  it('navega a la segunda página correctamente', async () => {
    const p1 = await request(app)
      .get('/api/comprobantes?limit=2&page=1')
      .set('Authorization', `Bearer ${token}`);
    const p2 = await request(app)
      .get('/api/comprobantes?limit=2&page=2')
      .set('Authorization', `Bearer ${token}`);

    expect(p1.body.data.length).toBe(2);
    expect(p2.body.data.length).toBeGreaterThanOrEqual(1);

    // Los IDs de cada página son distintos
    const ids1 = p1.body.data.map(c => c.id);
    const ids2 = p2.body.data.map(c => c.id);
    ids2.forEach(id => expect(ids1).not.toContain(id));
  });

  it('filtra por fecha y pagina correctamente', async () => {
    const res = await request(app)
      .get('/api/comprobantes?desde=2026-01-10&hasta=2026-01-15&limit=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(2); // solo A y B
    res.body.data.forEach(c => {
      const fecha = c.fecha.substring(0, 10);
      expect(fecha >= '2026-01-10').toBe(true);
      expect(fecha <= '2026-01-15').toBe(true);
    });
  });
});

// ─── Comprobantes — totales ───────────────────────────────────
describe('GET /api/comprobantes/totales', () => {
  it('devuelve count, total_monto, total_financiera, total_neto', async () => {
    const res = await request(app)
      .get('/api/comprobantes/totales')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('count');
    expect(res.body).toHaveProperty('total_monto');
    expect(res.body).toHaveProperty('total_financiera');
    expect(res.body).toHaveProperty('total_neto');
  });

  it('los totales son correctos (suma de los 3 comprobantes)', async () => {
    const res = await request(app)
      .get('/api/comprobantes/totales')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.count).toBe(3);
    expect(res.body.total_monto).toBe(35000);       // 10000 + 20000 + 5000
    expect(res.body.total_financiera).toBe(1050);   // 300 + 600 + 150
    expect(res.body.total_neto).toBe(33950);         // 9700 + 19400 + 4850
  });
});

// ─── Pagos — paginación ───────────────────────────────────────
describe('GET /api/pagos — paginación', () => {
  it('devuelve estructura paginada {data, pagination}', async () => {
    const res = await request(app)
      .get('/api/pagos')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('pagination');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('respeta el parámetro limit', async () => {
    const res = await request(app)
      .get('/api/pagos?limit=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.data.length).toBe(1);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.pagination.pages).toBe(2);
  });

  it('ordena por fecha DESC — el más reciente primero', async () => {
    const res = await request(app)
      .get('/api/pagos?limit=10')
      .set('Authorization', `Bearer ${token}`);

    const fechas = res.body.data.map(p => p.fecha.substring(0, 10));
    const sorted = [...fechas].sort().reverse();
    expect(fechas).toEqual(sorted);
  });
});

// ─── Pagos — totales ─────────────────────────────────────────
describe('GET /api/pagos/totales', () => {
  it('devuelve count y total_monto', async () => {
    const res = await request(app)
      .get('/api/pagos/totales')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('count');
    expect(res.body).toHaveProperty('total_monto');
  });

  it('los totales son correctos (suma de los 2 pagos)', async () => {
    const res = await request(app)
      .get('/api/pagos/totales')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.count).toBe(2);
    expect(res.body.total_monto).toBe(15000); // 5000 + 10000
  });
});

// ─── Cambio de contraseña ─────────────────────────────────────
describe('POST /api/auth/change-password', () => {
  it('cambia la contraseña con credenciales correctas', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: TEST_USER.password, newPassword: 'nuevaPass456' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('puede loguearse con la nueva contraseña', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: 'nuevaPass456' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('rechaza contraseña actual incorrecta → 401', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'wrongpass', newPassword: 'otraPass789' });

    expect(res.status).toBe(401);
  });

  it('rechaza nueva contraseña menor a 8 caracteres → 400', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'nuevaPass456', newPassword: 'corta' });

    expect(res.status).toBe(400);
  });

  it('requiere token → 401 sin autenticación', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: 'cualquiera', newPassword: 'nuevaPass456' });

    expect(res.status).toBe(401);
  });
});
