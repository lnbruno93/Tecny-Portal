/**
 * Tests de integración — Inventario (huecos de cobertura)
 *
 * Cubre el endpoint de foto on-demand (lazy) y el DELETE de catálogos
 * (categorías y depósitos), que inventario.test.js no toca.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, catBase;
const auth = () => ({ Authorization: `Bearer ${token}` });

async function crearProducto(over = {}) {
  const res = await request(app).post('/api/inventario/productos').set(auth()).send({
    tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: catBase, nombre: 'iPhone Foto',
    costo: 800, precio_venta: 950, cantidad: 1, ...over,
  });
  return res.body;
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'Base Test' });
  catBase = cat.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

/* ═══════════ FOTO ON-DEMAND ═══════════ */
describe('GET /productos/:id/foto', () => {
  it('devuelve la foto de un producto que la tiene', async () => {
    const prod = await crearProducto({ foto_data: 'iVBORw0KGgo=', foto_nombre: 'f.png', foto_tipo: 'image/png' });
    const res = await request(app).get(`/api/inventario/productos/${prod.id}/foto`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.foto_data).toBe('iVBORw0KGgo=');

    // El listado NO debe traer el blob (lazy)
    const list = await request(app).get('/api/inventario/productos?buscar=iPhone Foto').set(auth());
    expect(list.body.data[0]).not.toHaveProperty('foto_data');
  });

  it('devuelve 404 si el producto no tiene foto', async () => {
    const prod = await crearProducto({ nombre: 'Sin Foto' });
    const res = await request(app).get(`/api/inventario/productos/${prod.id}/foto`).set(auth());
    expect(res.status).toBe(404);
  });

  it('devuelve 400 con ID inválido', async () => {
    const res = await request(app).get('/api/inventario/productos/abc/foto').set(auth());
    expect(res.status).toBe(400);
  });
});

/* ═══════════ CATÁLOGOS: CATEGORÍAS ═══════════ */
describe('Categorías — DELETE', () => {
  it('crea y borra una categoría, y devuelve 404/400 según corresponda', async () => {
    const created = await request(app).post('/api/inventario/categorias').set(auth())
      .send({ nombre: 'Fundas' });
    expect(created.status).toBe(201);

    const del = await request(app).delete(`/api/inventario/categorias/${created.body.id}`).set(auth());
    expect(del.status).toBe(200);

    const del2 = await request(app).delete(`/api/inventario/categorias/${created.body.id}`).set(auth());
    expect(del2.status).toBe(404);

    const badId = await request(app).delete('/api/inventario/categorias/abc').set(auth());
    expect(badId.status).toBe(400);
  });
});

/* ═══════════ CATÁLOGOS: DEPÓSITOS ═══════════ */
describe('Depósitos — DELETE', () => {
  it('crea y borra un depósito, y devuelve 404/400 según corresponda', async () => {
    const created = await request(app).post('/api/inventario/depositos').set(auth())
      .send({ nombre: 'Sucursal Centro' });
    expect(created.status).toBe(201);

    const del = await request(app).delete(`/api/inventario/depositos/${created.body.id}`).set(auth());
    expect(del.status).toBe(200);

    const del2 = await request(app).delete(`/api/inventario/depositos/${created.body.id}`).set(auth());
    expect(del2.status).toBe(404);

    const badId = await request(app).delete('/api/inventario/depositos/abc').set(auth());
    expect(badId.status).toBe(400);
  });
});
