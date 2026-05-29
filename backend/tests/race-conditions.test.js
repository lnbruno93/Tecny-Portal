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

// ─── Race conditions B2B (#T-01) ─────────────────────────────────────────
// Dos ventas B2B concurrentes sobre el mismo producto deben:
//   - dejar el stock consistente (no negativo, no contadas dos veces)
//   - una sale 201, la otra 409 'Stock insuficiente' si no hay stock para
//     ambas
// Antes de TANDA 2/B-06 esto podía romper con CHECK violation o deadlock.
describe('Race condition — venta B2B con producto_id (#T-01)', () => {
  it('2 ventas B2B simultáneas sobre stock=1 → 1 OK + 1 stock-insuficiente', async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set(auth())
      .send({ nombre: 'B2B Race ' + Math.random(), categoria: 'A+' });
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase,
      nombre: 'iPhone B2B Race', imei: '350777' + Math.floor(Math.random() * 1e9),
      costo: 500, costo_moneda: 'USD', precio_venta: 800, precio_moneda: 'USD', cantidad: 1,
    });
    expect(prod.status).toBe(201);

    const mkVenta = () => request(app).post('/api/cuentas/movimientos').set(auth()).send({
      cliente_cc_id: cli.body.id, fecha: hoy, tipo: 'compra', monto_total: 800,
      items: [{ producto_id: prod.body.id, cantidad: 1, valor: 800 }],
    });

    const [r1, r2] = await Promise.all([mkVenta(), mkVenta()]);
    const ok = [r1, r2].filter(r => r.status === 201).length;
    const conflict = [r1, r2].filter(r => r.status === 409).length;
    expect(ok).toBe(1);
    expect(conflict).toBe(1);

    const after = (await request(app)
      .get(`/api/inventario/productos?buscar=${prod.body.imei}&vista=todos_ocultos`)
      .set(auth())).body.data;
    expect(after[0].cantidad).toBe(0);
    expect(after[0].estado).toBe('vendido');
  });

  it('5 ventas B2B simultáneas sobre lote cantidad=3 → 3 OK + 2 stock-insuficiente', async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set(auth())
      .send({ nombre: 'B2B Race Lote ' + Math.random(), categoria: 'A-' });
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'lote', clase: 'accesorio', categoria_id: catBase,
      nombre: 'Funda B2B Race', costo: 5, costo_moneda: 'USD',
      precio_venta: 10, precio_moneda: 'USD', cantidad: 3,
    });

    const mkVenta = () => request(app).post('/api/cuentas/movimientos').set(auth()).send({
      cliente_cc_id: cli.body.id, fecha: hoy, tipo: 'compra', monto_total: 10,
      items: [{ producto_id: prod.body.id, cantidad: 1, valor: 10 }],
    });

    const results = await Promise.all([mkVenta(), mkVenta(), mkVenta(), mkVenta(), mkVenta()]);
    const ok = results.filter(r => r.status === 201).length;
    const conflict = results.filter(r => r.status === 409).length;
    expect(ok).toBe(3);
    expect(conflict).toBe(2);

    const after = (await request(app)
      .get(`/api/inventario/productos?buscar=Funda B2B Race&vista=todos_ocultos`)
      .set(auth())).body.data;
    const p = after.find(x => x.id === prod.body.id);
    expect(p.cantidad).toBe(0);
  });

  it('B2B + venta minorista concurrentes sobre mismo producto: stock consistente', async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set(auth())
      .send({ nombre: 'B2B Race Mix ' + Math.random(), categoria: 'VIP' });
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      tipo_carga: 'lote', clase: 'accesorio', categoria_id: catBase,
      nombre: 'Cargador B2B+B2C Race', costo: 2, costo_moneda: 'USD',
      precio_venta: 5, precio_moneda: 'USD', cantidad: 2,
    });

    const mkB2C = () => request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Cliente B2C', estado: 'acreditado',
      items: [{ producto_id: prod.body.id, descripcion: 'Cargador', cantidad: 1, precio_vendido: 5, costo: 2, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 5, moneda: 'USD' }],
    });
    const mkB2B = () => request(app).post('/api/cuentas/movimientos').set(auth()).send({
      cliente_cc_id: cli.body.id, fecha: hoy, tipo: 'compra', monto_total: 5,
      items: [{ producto_id: prod.body.id, cantidad: 1, valor: 5 }],
    });

    // 4 concurrentes (2 B2C + 2 B2B) sobre 2 unidades disponibles
    const results = await Promise.all([mkB2C(), mkB2B(), mkB2C(), mkB2B()]);
    const ok = results.filter(r => r.status === 201).length;
    expect(ok).toBe(2);

    const after = (await request(app)
      .get(`/api/inventario/productos?buscar=Cargador B2B`)
      .set(auth())).body.data;
    const p = after.find(x => x.id === prod.body.id);
    expect(Number(p.cantidad)).toBe(0); // sin negativos
  });
});
