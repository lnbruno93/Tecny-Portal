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

// 2026-07-25: POST /depositos/bulk — resolve-or-create batch usado por
// el import XLSX. Reemplaza el requerimiento de "ID DEPÓSITO (SÓLO NÚMERO)"
// en la planilla — el operador puede escribir nombres y se auto-crean si
// no existen (mismo patrón que POST /clases/bulk).
describe('Depósitos — POST /depositos/bulk', () => {
  it('crea múltiples depósitos nuevos y devuelve mapping completo', async () => {
    const nombres = ['BulkDep A', 'BulkDep B', 'BulkDep C'];
    const r = await request(app).post('/api/inventario/depositos/bulk').set(auth())
      .send({ nombres });
    expect(r.status).toBe(200);
    expect(r.body.map).toBeDefined();
    expect(Object.keys(r.body.map).sort()).toEqual(nombres.map(n => n.toLowerCase()).sort());
    // Todos los ids son integers positivos (depositos usa SERIAL PK).
    for (const id of Object.values(r.body.map)) {
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    }
    // Aparecen en el listado.
    const list = await request(app).get('/api/inventario/depositos').set(auth());
    for (const n of nombres) {
      expect(list.body.some(d => d.nombre === n)).toBe(true);
    }
  });

  it('es idempotente: bulk con nombres ya existentes devuelve los mismos ids', async () => {
    const nombres = ['BulkDep Idem 1', 'BulkDep Idem 2'];
    const r1 = await request(app).post('/api/inventario/depositos/bulk').set(auth())
      .send({ nombres });
    expect(r1.status).toBe(200);
    const map1 = r1.body.map;

    const r2 = await request(app).post('/api/inventario/depositos/bulk').set(auth())
      .send({ nombres });
    expect(r2.status).toBe(200);
    expect(r2.body.map).toEqual(map1);

    // Sin duplicados en el listado.
    const list = await request(app).get('/api/inventario/depositos').set(auth());
    for (const n of nombres) {
      const matches = list.body.filter(d => d.nombre.toLowerCase() === n.toLowerCase());
      expect(matches.length).toBe(1);
    }
  });

  it('dedup case-insensitive en el input', async () => {
    const r = await request(app).post('/api/inventario/depositos/bulk').set(auth())
      .send({ nombres: ['BulkDep Case', 'bulkdep case', 'BULKDEP CASE'] });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.map)).toEqual(['bulkdep case']);
    const list = await request(app).get('/api/inventario/depositos').set(auth());
    const matches = list.body.filter(d => d.nombre.toLowerCase() === 'bulkdep case');
    expect(matches.length).toBe(1);
  });

  it('resolve-or-create mixto: 1 existente + 1 nuevo → devuelve ambos', async () => {
    await request(app).post('/api/inventario/depositos').set(auth())
      .send({ nombre: 'BulkDep Mixto Existente' });
    const r = await request(app).post('/api/inventario/depositos/bulk').set(auth())
      .send({ nombres: ['BulkDep Mixto Existente', 'BulkDep Mixto Nuevo'] });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.map).sort()).toEqual(['bulkdep mixto existente', 'bulkdep mixto nuevo']);
  });

  it('lista vacía → { map: {} } (no-op)', async () => {
    const r = await request(app).post('/api/inventario/depositos/bulk').set(auth())
      .send({ nombres: [] });
    expect(r.status).toBe(200);
    expect(r.body.map).toEqual({});
  });

  it('rechaza más de 500 nombres (guard)', async () => {
    const nombres = Array.from({ length: 501 }, (_, i) => `BulkDep Overflow ${i}`);
    const r = await request(app).post('/api/inventario/depositos/bulk').set(auth())
      .send({ nombres });
    expect(r.status).toBe(400);
  });

  it('sin auth → 401', async () => {
    const r = await request(app).post('/api/inventario/depositos/bulk')
      .send({ nombres: ['x'] });
    expect(r.status).toBe(401);
  });
});
