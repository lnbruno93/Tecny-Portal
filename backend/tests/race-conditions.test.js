/**
 * Tests de race conditions (E4 de la auditoría ultra).
 *
 * Disparamos N requests en paralelo contra el mismo recurso y verificamos
 * que el invariante se mantiene (stock atómico, idempotencia de cobros, etc.).
 * Sin estos tests, un refactor de descontarStock que rompa el FOR UPDATE
 * pasa CI silenciosamente y solo lo detectamos en producción.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, catBase;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

beforeAll(async () => {
  pool = await setupTestDb();
  const r = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = r.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'Race Test' });
  catBase = cat.body.id;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Race condition — stock unitario', () => {
  it('dos ventas concurrentes del mismo producto unitario: solo una gana', async () => {
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'iPhone Race', clase: 'celular', tipo_carga: 'unitario',
      categoria_id: catBase, costo: 500, precio_venta: 700, cantidad: 1,
    });
    expect(prod.status).toBe(201);

    const mkVenta = () => request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Race', estado: 'acreditado',
      items: [{ producto_id: prod.body.id, descripcion: 'iPhone Race', cantidad: 1, precio_vendido: 700, costo: 500, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 700, moneda: 'USD' }],
    });

    const [v1, v2] = await Promise.all([mkVenta(), mkVenta()]);
    // Una de las dos debería tener éxito (201) y la otra rebote (400 stock / 400 vendido)
    const statuses = [v1.status, v2.status].sort();
    expect(statuses).toEqual([201, 400]);
    // El producto queda en 'vendido' (lo que ganó)
    const after = (await request(app).get('/api/inventario/productos?buscar=iPhone Race').set(auth())).body.data;
    const p = after.find(x => x.id === prod.body.id);
    expect(p.estado).toBe('vendido');
    expect(p.cantidad).toBe(0);
  });
});

describe('Race condition — lote con cantidad limitada', () => {
  it('cinco ventas simultáneas de 1u sobre un lote de 3u: solo 3 ganan', async () => {
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'AirPods Race', clase: 'accesorio', tipo_carga: 'lote',
      categoria_id: catBase, costo: 100, precio_venta: 200, cantidad: 3,
    });
    expect(prod.status).toBe(201);

    const mkVenta = () => request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Race lote', estado: 'acreditado',
      items: [{ producto_id: prod.body.id, descripcion: 'AirPods Race', cantidad: 1, precio_vendido: 200, costo: 100, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 200, moneda: 'USD' }],
    });

    const results = await Promise.all([mkVenta(), mkVenta(), mkVenta(), mkVenta(), mkVenta()]);
    const ok = results.filter(r => r.status === 201).length;
    const bad = results.filter(r => r.status === 400).length;
    expect(ok).toBe(3);
    expect(bad).toBe(2);
    // El producto queda en 0 (no en negativo)
    const after = (await request(app).get('/api/inventario/productos?buscar=AirPods Race').set(auth())).body.data;
    const p = after.find(x => x.id === prod.body.id);
    expect(p.cantidad).toBe(0);
  });
});
