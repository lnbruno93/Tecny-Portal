/**
 * Tests de integración — Inventario
 *
 * Cubre:
 *   categorías / depósitos — crear, listar, borrar (soft-delete), nombre duplicado
 *   productos              — crear, validar, listar con filtros/búsqueda, actualizar, borrar
 *   métricas               — agregados de stock e inversión por moneda y clase
 *   carga masiva           — bulk transaccional
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;
let catBase; // categoría compartida obligatoria al crear productos

const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'Base Test' });
  catBase = cat.body.id;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Catálogos ───────────────────────────────────────────────
describe('Categorías y depósitos', () => {
  let catId;

  it('crea una categoría → 201', async () => {
    const res = await request(app).post('/api/inventario/categorias')
      .set(auth()).send({ nombre: 'Celulares' });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Celulares');
    catId = res.body.id;
  });

  it('rechaza categoría duplicada (case-insensitive) → 409', async () => {
    const res = await request(app).post('/api/inventario/categorias')
      .set(auth()).send({ nombre: 'celulares' });
    expect(res.status).toBe(409);
  });

  it('rechaza categoría sin nombre → 400', async () => {
    const res = await request(app).post('/api/inventario/categorias')
      .set(auth()).send({ nombre: '' });
    expect(res.status).toBe(400);
  });

  it('crea un depósito y lo lista', async () => {
    const c = await request(app).post('/api/inventario/depositos')
      .set(auth()).send({ nombre: 'Local Centro' });
    expect(c.status).toBe(201);

    const res = await request(app).get('/api/inventario/depositos').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.map(d => d.nombre)).toContain('Local Centro');
  });

  it('borra (soft-delete) la categoría', async () => {
    const res = await request(app).delete(`/api/inventario/categorias/${catId}`).set(auth());
    expect(res.status).toBe(200);
    const list = await request(app).get('/api/inventario/categorias').set(auth());
    expect(list.body.map(c => c.id)).not.toContain(catId);
  });
});

// ─── Productos ───────────────────────────────────────────────
describe('Productos', () => {
  let prodId;

  it('crea un producto unitario → 201', async () => {
    const res = await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario',
      clase: 'celular',
      categoria_id: catBase,
      nombre: 'iPhone 15 Pro',
      imei: '356938035643809',
      gb: '256',
      color: 'Natural',
      bateria: 92,
      costo: 800,
      costo_moneda: 'USD',
      precio_venta: 950,
      precio_moneda: 'USD',
    });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('iPhone 15 Pro');
    expect(res.body.estado).toBe('disponible');
    expect(res.body.cantidad).toBe(1);
    prodId = res.body.id;
  });

  it('rechaza producto sin nombre → 400', async () => {
    const res = await request(app).post('/api/inventario/productos')
      .set(auth()).send({ clase: 'celular' });
    expect(res.status).toBe(400);
  });

  it('rechaza batería fuera de rango → 400', async () => {
    const res = await request(app).post('/api/inventario/productos')
      .set(auth()).send({ nombre: 'X', bateria: 150 });
    expect(res.status).toBe(400);
  });

  it('rechaza clase inválida → 400', async () => {
    const res = await request(app).post('/api/inventario/productos')
      .set(auth()).send({ nombre: 'X', clase: 'tablet' });
    expect(res.status).toBe(400);
  });

  it('busca el producto por IMEI', async () => {
    const res = await request(app).get('/api/inventario/productos?buscar=356938').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.map(p => p.id)).toContain(prodId);
    expect(res.body.pagination).toBeDefined();
  });

  it('filtra por clase accesorio (no incluye el celular)', async () => {
    await request(app).post('/api/inventario/productos').set(auth()).send({
      clase: 'accesorio', tipo_carga: 'lote', categoria_id: catBase, nombre: 'AirPods Pro 3', cantidad: 22, costo: 150,
    });
    const res = await request(app).get('/api/inventario/productos?clase=accesorio').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.every(p => p.clase === 'accesorio')).toBe(true);
    expect(res.body.data.map(p => p.id)).not.toContain(prodId);
  });

  it('actualiza el estado a en_tecnico', async () => {
    const res = await request(app).put(`/api/inventario/productos/${prodId}`)
      .set(auth()).send({ estado: 'en_tecnico' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('en_tecnico');
    // No debe haber pisado otros campos
    expect(res.body.nombre).toBe('iPhone 15 Pro');
  });

  it('PUT a producto inexistente → 404', async () => {
    const res = await request(app).put('/api/inventario/productos/999999')
      .set(auth()).send({ estado: 'disponible' });
    expect(res.status).toBe(404);
  });

  it('borra (soft-delete) el producto', async () => {
    const res = await request(app).delete(`/api/inventario/productos/${prodId}`).set(auth());
    expect(res.status).toBe(200);
    const list = await request(app).get('/api/inventario/productos?buscar=356938').set(auth());
    expect(list.body.data.map(p => p.id)).not.toContain(prodId);
  });
});

// ─── Fotos (lazy) ────────────────────────────────────────────
describe('Foto del producto (lazy load)', () => {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  it('el listado NO incluye foto_data pero marca tiene_foto', async () => {
    const c = await request(app).post('/api/inventario/productos').set(auth())
      .send({ nombre: 'Con Foto', clase: 'celular', categoria_id: catBase, foto_data: b64, foto_nombre: 'f.png', foto_tipo: 'image/png' });
    const list = await request(app).get('/api/inventario/productos?buscar=Con Foto').set(auth());
    const p = list.body.data.find(x => x.id === c.body.id);
    expect(p).toBeDefined();
    expect(p.foto_data).toBeUndefined();
    expect(p.tiene_foto).toBe(true);
    // la foto se trae on-demand
    const foto = await request(app).get(`/api/inventario/productos/${c.body.id}/foto`).set(auth());
    expect(foto.status).toBe(200);
    expect(foto.body.foto_data).toBe(b64);
  });

  it('producto sin foto → 404 en el endpoint de foto', async () => {
    const c = await request(app).post('/api/inventario/productos').set(auth()).send({ nombre: 'Sin Foto', clase: 'celular', categoria_id: catBase });
    const foto = await request(app).get(`/api/inventario/productos/${c.body.id}/foto`).set(auth());
    expect(foto.status).toBe(404);
  });
});

// ─── Métricas ────────────────────────────────────────────────
describe('GET /api/inventario/productos/metricas', () => {
  it('agrega inversión de accesorios disponibles en USD', async () => {
    // Tras los tests previos queda 1 accesorio (AirPods Pro 3, 22 u × 150 USD = 3300)
    const res = await request(app).get('/api/inventario/productos/metricas').set(auth());
    expect(res.status).toBe(200);
    expect(Number(res.body.accesorios_count)).toBe(22);
    expect(Number(res.body.inv_accesorios_usd)).toBe(3300);
  });
});

// ─── Conteo por categoría (insumo de Data Science) ───────────
describe('GET /api/inventario/categorias — productos_count', () => {
  it('devuelve el conteo de productos y stock disponible por categoría', async () => {
    const res = await request(app).get('/api/inventario/categorias').set(auth());
    expect(res.status).toBe(200);
    // 'Base Test' es la categoría que usaron casi todos los productos del archivo.
    // Filtrá por nombre para no depender del orden de creación.
    const base = res.body.find(c => c.nombre === 'Base Test');
    expect(base).toBeDefined();
    // Tras todos los tests previos hay productos asignados a 'Base Test'
    // (incluyendo el accesorio de 22 u, AirPods Pro 3, no borrado).
    expect(Number(base.productos_count)).toBeGreaterThan(0);
    // El stock_disponible incluye solo los productos con estado='disponible'.
    expect(Number(base.stock_disponible)).toBeGreaterThanOrEqual(22);
  });

  it('una categoría recién creada y sin productos tiene count 0', async () => {
    const c = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'Categoría Vacía' });
    expect(c.status).toBe(201);
    const list = await request(app).get('/api/inventario/categorias').set(auth());
    const vacia = list.body.find(x => x.id === c.body.id);
    expect(vacia).toBeDefined();
    expect(Number(vacia.productos_count)).toBe(0);
    expect(Number(vacia.stock_disponible)).toBe(0);
  });
});

// ─── Carga masiva ────────────────────────────────────────────
describe('POST /api/inventario/productos/bulk', () => {
  it('crea varios productos en una transacción', async () => {
    const res = await request(app).post('/api/inventario/productos/bulk').set(auth()).send({
      productos: [
        { nombre: 'iPhone 13', clase: 'celular', categoria_id: catBase, costo: 400, precio_venta: 500 },
        { nombre: 'iPhone 14', clase: 'celular', categoria_id: catBase, costo: 500, precio_venta: 620 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.creados).toBe(2);
  });

  it('rechaza bulk vacío → 400', async () => {
    const res = await request(app).post('/api/inventario/productos/bulk')
      .set(auth()).send({ productos: [] });
    expect(res.status).toBe(400);
  });
});
