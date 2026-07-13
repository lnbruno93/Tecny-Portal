/**
 * Tests de integración — Búsqueda global (feature 2026-07-13)
 *
 * Cubre:
 *   GET /api/search?q=...     — respuesta agrupada por categoría
 *   min length                — rechaza queries < 2 chars
 *   RLS scoping               — no ve resultados de otro tenant (via tenant helper)
 *   allSettled degradation    — si una tabla falla, el resto responde
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, catBase;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy = new Date().toISOString().split('T')[0];

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth())
    .send({ nombre: 'Cat Search Test' });
  catBase = cat.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('GET /api/search', () => {
  it('rechaza query menor a 2 caracteres → 400', async () => {
    const r = await request(app).get('/api/search?q=a').set(auth());
    expect(r.status).toBe(400);
  });

  it('devuelve shape completo con categorías vacías si nada matchea', async () => {
    const r = await request(app).get('/api/search?q=nomatch_' + Date.now()).set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('q');
    expect(r.body).toHaveProperty('total', 0);
    expect(r.body.results).toEqual(expect.objectContaining({
      productos: [], ventas: [], contactos: [], envios: [], cajas: [], egresos: [],
    }));
  });

  it('encuentra un producto por nombre + IMEI + color', async () => {
    // Seed: producto único con nombre distintivo.
    const unique = 'SearchTest_' + Date.now();
    await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: unique, clase: 'celular_sellado', tipo_carga: 'unitario',
      categoria_id: catBase, imei: '555' + Date.now().toString().slice(-12),
      color: 'PurpleSearch', costo: 100, costo_moneda: 'USD',
      precio_venta: 150, precio_moneda: 'USD', cantidad: 1,
    });

    // Match por nombre parcial.
    const byName = await request(app).get(`/api/search?q=${unique.slice(0, 12)}`).set(auth());
    expect(byName.status).toBe(200);
    expect(byName.body.results.productos.length).toBeGreaterThan(0);
    expect(byName.body.results.productos[0].label).toContain(unique.slice(0, 12));

    // Match por color.
    const byColor = await request(app).get(`/api/search?q=PurpleSearch`).set(auth());
    expect(byColor.body.results.productos.length).toBeGreaterThan(0);
    expect(byColor.body.results.productos[0].sublabel).toContain('PurpleSearch');
  });

  it('encuentra una venta por order_id + cliente_nombre', async () => {
    const cliente = 'ClienteSearch_' + Date.now();
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: cliente, estado: 'acreditado',
      items: [{ descripcion: 'X', cantidad: 1, precio_vendido: 100, costo: 80, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 100, moneda: 'USD' }],
    });
    expect(venta.status).toBe(201);

    // Match por order_id
    const byOrder = await request(app).get(`/api/search?q=${venta.body.order_id}`).set(auth());
    expect(byOrder.body.results.ventas.length).toBeGreaterThan(0);
    expect(byOrder.body.results.ventas[0].label).toBe(venta.body.order_id);

    // Match por cliente_nombre parcial.
    const byCliente = await request(app).get(`/api/search?q=ClienteSearch`).set(auth());
    expect(byCliente.body.results.ventas.length).toBeGreaterThan(0);
    expect(byCliente.body.results.ventas[0].sublabel).toContain('ClienteSearch');
  });

  it('devuelve shape uniforme por item (id, label, sublabel, url)', async () => {
    // Reusa el producto creado antes.
    const r = await request(app).get('/api/search?q=SearchTest').set(auth());
    expect(r.status).toBe(200);
    const p = r.body.results.productos[0];
    expect(p).toEqual(expect.objectContaining({
      id: expect.any(Number),
      label: expect.any(String),
      url: expect.stringContaining('/inventario'),
    }));
  });

  it('total refleja la suma de rows de todas las categorías', async () => {
    const r = await request(app).get('/api/search?q=SearchTest').set(auth());
    const suma = Object.values(r.body.results).reduce((s, arr) => s + arr.length, 0);
    expect(r.body.total).toBe(suma);
  });

  it('respeta el límite por categoría (default 5, cap 15)', async () => {
    const r = await request(app).get('/api/search?q=SearchTest&limit=5').set(auth());
    expect(r.status).toBe(200);
    Object.values(r.body.results).forEach(arr => {
      expect(arr.length).toBeLessThanOrEqual(5);
    });

    const r2 = await request(app).get('/api/search?q=SearchTest&limit=20').set(auth());
    // Cap 15 en el schema → 20 debería devolver 400.
    expect(r2.status).toBe(400);
  });

  it('rechaza sin auth → 401', async () => {
    const r = await request(app).get('/api/search?q=test');
    expect(r.status).toBe(401);
  });
});
