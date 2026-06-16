/**
 * Tests de integración — Catálogo Usados
 *
 * Cubre:
 *   GET    /api/usados            — lista, filtro ?buscar
 *   GET    /api/usados/:id        — detalle
 *   POST   /api/usados            — crear, validación
 *   PUT    /api/usados/bulk       — transacción atómica múltiples IDs
 *   PUT    /api/usados/:id        — actualización parcial
 *   DELETE /api/usados/:id        — soft-delete
 *
 *   Permisos: 403 sin permiso "usados"
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const bcrypt  = require('bcrypt');

let pool;
let adminToken;
let opToken;    // sin permiso usados
let usadoId1;
let usadoId2;
let usadoId3;

beforeAll(async () => {
  pool = await setupTestDb();

  // Admin
  const r1 = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = r1.body.token;

  // Op sin permisos
  const hash = await bcrypt.hash('op_usados_pass123', 10);
  await pool.query(
    'INSERT INTO users (nombre, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5)',
    ['Op Usados', 'opusados', 'opusados@test.local', hash, 'op']
  );
  const r2 = await request(app)
    .post('/api/auth/login')
    .send({ username: 'opusados', password: 'op_usados_pass123' });
  opToken = r2.body.token;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ═══════════════════════════════════════════════════════════════
// CREAR
// ═══════════════════════════════════════════════════════════════
describe('POST /api/usados', () => {
  it('crea producto con campos obligatorios → 201', async () => {
    const res = await request(app)
      .post('/api/usados')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ equipo: 'iPhone 15 Pro', precio_usd: 850 });

    expect(res.status).toBe(201);
    expect(res.body.equipo).toBe('iPhone 15 Pro');
    expect(parseFloat(res.body.precio_usd)).toBe(850);
    expect(res.body.id).toBeDefined();
    usadoId1 = res.body.id;
  });

  it('crea producto con todos los campos → 201', async () => {
    const res = await request(app)
      .post('/api/usados')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        equipo:      'Samsung S24 Ultra',
        capacidad:   '512GB',
        pct_bateria: '92%',
        precio_usd:  700,
        comentarios: 'Sin rayones, completo',
      });

    expect(res.status).toBe(201);
    expect(res.body.capacidad).toBe('512GB');
    expect(res.body.pct_bateria).toBe('92%');
    usadoId2 = res.body.id;
  });

  it('tercer producto para tests de bulk → 201', async () => {
    const res = await request(app)
      .post('/api/usados')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ equipo: 'iPhone 14', precio_usd: 600 });

    expect(res.status).toBe(201);
    usadoId3 = res.body.id;
  });

  it('rechaza precio_usd negativo → 400', async () => {
    const res = await request(app)
      .post('/api/usados')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ equipo: 'Producto Test', precio_usd: -100 });

    expect(res.status).toBe(400);
  });

  it('rechaza equipo vacío → 400', async () => {
    const res = await request(app)
      .post('/api/usados')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ equipo: '', precio_usd: 100 });

    expect(res.status).toBe(400);
  });

  it('sin permiso "usados" → 403', async () => {
    const res = await request(app)
      .post('/api/usados')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ equipo: 'Test', precio_usd: 100 });

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════
// LISTAR
// ═══════════════════════════════════════════════════════════════
describe('GET /api/usados', () => {
  it('devuelve todos los productos activos', async () => {
    const res = await request(app)
      .get('/api/usados')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(3);

    const ids = res.body.map(u => u.id);
    expect(ids).toContain(usadoId1);
    expect(ids).toContain(usadoId2);
    expect(ids).toContain(usadoId3);
  });

  it('ordena por equipo ASC (locale-aware)', async () => {
    const res = await request(app)
      .get('/api/usados')
      .set('Authorization', `Bearer ${adminToken}`);

    const nombres = res.body.map(u => u.equipo);
    // PostgreSQL usa collation locale-aware (≠ ASCII sort de JS).
    // Verificamos con localeCompare que el orden respeta el collation.
    for (let i = 1; i < nombres.length; i++) {
      expect(nombres[i - 1].localeCompare(nombres[i], undefined, { sensitivity: 'base' }))
        .toBeLessThanOrEqual(0);
    }
  });

  it('filtra por buscar (case-insensitive)', async () => {
    const res = await request(app)
      .get('/api/usados?buscar=iphone')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2); // iPhone 15 Pro + iPhone 14
    res.body.forEach(u => {
      const coincide =
        u.equipo.toLowerCase().includes('iphone') ||
        (u.capacidad     && u.capacidad.toLowerCase().includes('iphone')) ||
        (u.comentarios   && u.comentarios.toLowerCase().includes('iphone'));
      expect(coincide).toBe(true);
    });
  });

  it('buscar sin resultados → array vacío', async () => {
    const res = await request(app)
      .get('/api/usados?buscar=nokia_inexistente_xyz')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// DETALLE
// ═══════════════════════════════════════════════════════════════
describe('GET /api/usados/:id', () => {
  it('devuelve el producto por ID', async () => {
    const res = await request(app)
      .get(`/api/usados/${usadoId2}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(usadoId2);
    expect(res.body.equipo).toBe('Samsung S24 Ultra');
    expect(res.body.capacidad).toBe('512GB');
  });

  it('ID inexistente → 404', async () => {
    const res = await request(app)
      .get('/api/usados/999999')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// PUT /:id — actualización parcial
// ═══════════════════════════════════════════════════════════════
describe('PUT /api/usados/:id', () => {
  it('actualiza precio_usd parcialmente', async () => {
    const res = await request(app)
      .put(`/api/usados/${usadoId1}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ precio_usd: 820 });

    expect(res.status).toBe(200);
    expect(parseFloat(res.body.precio_usd)).toBe(820);
    expect(res.body.equipo).toBe('iPhone 15 Pro'); // no cambió
  });

  it('actualiza comentarios y capacidad', async () => {
    const res = await request(app)
      .put(`/api/usados/${usadoId1}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ capacidad: '256GB', comentarios: 'Batería al 88%' });

    expect(res.status).toBe(200);
    expect(res.body.capacidad).toBe('256GB');
    expect(res.body.comentarios).toBe('Batería al 88%');
  });

  it('ID inexistente → 404', async () => {
    const res = await request(app)
      .put('/api/usados/999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ precio_usd: 500 });

    expect(res.status).toBe(404);
  });

  it('sin campos → 400', async () => {
    const res = await request(app)
      .put(`/api/usados/${usadoId1}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// PUT /bulk — transacción atómica
// ═══════════════════════════════════════════════════════════════
describe('PUT /api/usados/bulk', () => {
  it('actualiza múltiples productos en una sola transacción', async () => {
    const res = await request(app)
      .put('/api/usados/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        updates: [
          { id: usadoId1, precio_usd: 799, comentarios: 'Precio actualizado bulk' },
          { id: usadoId2, precio_usd: 680 },
          { id: usadoId3, precio_usd: 580, comentarios: 'Stock reducido' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(3); // los 3 fueron actualizados
  });

  it('verifica que los precios se actualizaron correctamente', async () => {
    const [r1, r2, r3] = await Promise.all([
      request(app).get(`/api/usados/${usadoId1}`).set('Authorization', `Bearer ${adminToken}`),
      request(app).get(`/api/usados/${usadoId2}`).set('Authorization', `Bearer ${adminToken}`),
      request(app).get(`/api/usados/${usadoId3}`).set('Authorization', `Bearer ${adminToken}`),
    ]);

    expect(parseFloat(r1.body.precio_usd)).toBe(799);
    expect(r1.body.comentarios).toBe('Precio actualizado bulk');
    expect(parseFloat(r2.body.precio_usd)).toBe(680);
    expect(parseFloat(r3.body.precio_usd)).toBe(580);
    expect(r3.body.comentarios).toBe('Stock reducido');
  });

  it('IDs inexistentes → updated = 0 (no falla, retorna 200)', async () => {
    const res = await request(app)
      .put('/api/usados/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        updates: [
          { id: 999991, precio_usd: 100 },
          { id: 999992, precio_usd: 200 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });

  it('lista vacía → 400 (schema requiere al menos 1 item)', async () => {
    const res = await request(app)
      .put('/api/usados/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ updates: [] });

    expect(res.status).toBe(400);
  });

  it('precio negativo en bulk → 400 (valida schema)', async () => {
    const res = await request(app)
      .put('/api/usados/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        updates: [{ id: usadoId1, precio_usd: -50 }],
      });

    expect(res.status).toBe(400);
  });

  it('sin permiso "usados" → 403', async () => {
    const res = await request(app)
      .put('/api/usados/bulk')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ updates: [{ id: usadoId1, precio_usd: 100 }] });

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════
// ELIMINAR
// ═══════════════════════════════════════════════════════════════
describe('DELETE /api/usados/:id', () => {
  it('elimina el producto (soft-delete) → 200', async () => {
    const res = await request(app)
      .delete(`/api/usados/${usadoId3}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('producto eliminado ya no aparece en GET /', async () => {
    const res = await request(app)
      .get('/api/usados')
      .set('Authorization', `Bearer ${adminToken}`);

    const ids = res.body.map(u => u.id);
    expect(ids).not.toContain(usadoId3);
  });

  it('producto eliminado → 404 en GET /:id', async () => {
    const res = await request(app)
      .get(`/api/usados/${usadoId3}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it('eliminar de nuevo → 404', async () => {
    const res = await request(app)
      .delete(`/api/usados/${usadoId3}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it('sin permiso "usados" → 403', async () => {
    const res = await request(app)
      .delete(`/api/usados/${usadoId1}`)
      .set('Authorization', `Bearer ${opToken}`);

    expect(res.status).toBe(403);
  });
});
