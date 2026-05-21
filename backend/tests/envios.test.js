/**
 * Tests de integración — Envíos
 *
 * Cubre:
 *   POST   /api/envios          — crear con items
 *   GET    /api/envios          — filtro por fecha, items incluidos
 *   PUT    /api/envios/:id      — cambiar estado SIN borrar items (bug crítico)
 *   DELETE /api/envios/:id      — soft-delete
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;
let envioId;

const hoy  = new Date().toISOString().split('T')[0];
const ayer = new Date(Date.now() - 86400000).toISOString().split('T')[0];

beforeAll(async () => {
  pool = await setupTestDb();

  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Crear ───────────────────────────────────────────────────
describe('POST /api/envios', () => {
  it('crea un envío con items y devuelve 201', async () => {
    const res = await request(app)
      .post('/api/envios')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha:         hoy,
        cliente:       'Cliente Test',
        direccion:     'Av. Siempre Viva 742',
        costo_envio:   500,
        total_cobrado: 15000,
        estado:        'Pendiente',
        items: [
          { tipo: 'producto', descripcion: 'iPhone 15 Pro', monto: 0 },
          { tipo: 'pago', descripcion: null, monto: 15000, metodo_pago: 'Efectivo ARS' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.cliente).toBe('Cliente Test');
    expect(res.body.estado).toBe('Pendiente');
    envioId = res.body.id;
  });

  it('rechaza envío sin cliente → 400', async () => {
    const res = await request(app)
      .post('/api/envios')
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: hoy, direccion: 'Algo 123' });

    expect(res.status).toBe(400);
  });

  it('rechaza envío sin dirección → 400', async () => {
    const res = await request(app)
      .post('/api/envios')
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: hoy, cliente: 'Alguien' });

    expect(res.status).toBe(400);
  });

  it('rechaza estado inválido → 400', async () => {
    const res = await request(app)
      .post('/api/envios')
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: hoy, cliente: 'X', direccion: 'Y', estado: 'Perdido' });

    expect(res.status).toBe(400);
  });
});

// ─── Listar con filtro de fecha ───────────────────────────────
describe('GET /api/envios con filtro de fecha', () => {
  it('devuelve el envío de hoy al filtrar por hoy', async () => {
    const res = await request(app)
      .get(`/api/envios?desde=${hoy}&hasta=${hoy}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const ids = res.body.data.map(e => e.id);
    expect(ids).toContain(envioId);
  });

  it('no devuelve el envío de hoy al filtrar por ayer', async () => {
    const res = await request(app)
      .get(`/api/envios?desde=${ayer}&hasta=${ayer}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.map(e => e.id);
    expect(ids).not.toContain(envioId);
  });

  it('incluye los 2 items del envío en la respuesta', async () => {
    const res = await request(app)
      .get(`/api/envios?desde=${hoy}&hasta=${hoy}`)
      .set('Authorization', `Bearer ${token}`);

    const envio = res.body.data.find(e => e.id === envioId);
    expect(envio).toBeDefined();
    expect(Array.isArray(envio.items)).toBe(true);
    expect(envio.items.length).toBe(2);

    const tipos = envio.items.map(i => i.tipo).sort();
    expect(tipos).toEqual(['pago', 'producto']);
  });
});

// ─── PUT — cambiar estado sin borrar items ────────────────────
describe('PUT /api/envios/:id — cambio de estado', () => {
  it('actualiza el estado a "En camino"', async () => {
    const res = await request(app)
      .put(`/api/envios/${envioId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ estado: 'En camino' });

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('En camino');
  });

  it('los items se preservan tras el cambio de estado (bug crítico)', async () => {
    const res = await request(app)
      .get(`/api/envios?desde=${hoy}&hasta=${hoy}`)
      .set('Authorization', `Bearer ${token}`);

    const envio = res.body.data.find(e => e.id === envioId);
    expect(envio).toBeDefined();
    // Los 2 items deben seguir intactos
    expect(envio.items.length).toBe(2);
  });

  it('rechaza estado inexistente → 400', async () => {
    const res = await request(app)
      .put(`/api/envios/${envioId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ estado: 'Volando' });

    expect(res.status).toBe(400);
  });

  it('devuelve 404 para ID inexistente', async () => {
    const res = await request(app)
      .put('/api/envios/999999')
      .set('Authorization', `Bearer ${token}`)
      .send({ estado: 'Entregado' });

    expect(res.status).toBe(404);
  });
});

// ─── DELETE ──────────────────────────────────────────────────
describe('DELETE /api/envios/:id', () => {
  it('elimina (soft-delete) el envío', async () => {
    const res = await request(app)
      .delete(`/api/envios/${envioId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('el envío eliminado ya no aparece en GET', async () => {
    const res = await request(app)
      .get(`/api/envios?desde=${hoy}&hasta=${hoy}`)
      .set('Authorization', `Bearer ${token}`);

    const ids = res.body.data.map(e => e.id);
    expect(ids).not.toContain(envioId);
  });

  it('intentar eliminar de nuevo devuelve 404', async () => {
    const res = await request(app)
      .delete(`/api/envios/${envioId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
