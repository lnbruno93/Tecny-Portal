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
let catBase;

const hoy  = new Date().toISOString().split('T')[0];
const ayer = new Date(Date.now() - 86400000).toISOString().split('T')[0];

beforeAll(async () => {
  pool = await setupTestDb();

  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias')
    .set({ Authorization: `Bearer ${token}` }).send({ nombre: 'Base Test' });
  catBase = cat.body.id;
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

describe('Envío → Venta (registrar_venta)', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  let cajaArs;
  const saldoCaja = async () => Number((await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === cajaArs).saldo_actual);

  beforeAll(async () => {
    const c = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Envíos R', moneda: 'ARS', saldo_inicial: 0 });
    cajaArs = c.body.id;
  });

  it('si registrar_venta=true pero no hay productos, igual postea los pagos a caja', async () => {
    // 2026-06-10 — Edge case introducido cuando el frontend pasó a forzar
    // registrar_venta=true siempre. Si el envío llega sin productos
    // (caso raro: cobro suelto sin item linkeado), crearVentaDesdeEnvio
    // devuelve null y antes los pagos quedaban huérfanos.
    const antes = await saldoCaja();
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente Sin Productos', direccion: 'Calle 0', registrar_venta: true,
      items: [{ tipo: 'pago', monto: 12345, metodo_pago_id: cajaArs }],
    });
    expect(env.status).toBe(201);
    expect(env.body.venta_id).toBeFalsy(); // no se creó venta (sin productos)
    expect(await saldoCaja()).toBe(antes + 12345); // pero la caja sí subió
  });

  it('crea la venta asociada, no duplica la plata, y al borrar el envío se borra la venta', async () => {
    const antes = await saldoCaja();
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente Envío', direccion: 'Calle 1', registrar_venta: true,
      items: [{ tipo: 'producto', descripcion: 'iPhone', monto: 500000 }, { tipo: 'pago', monto: 500000, metodo_pago_id: cajaArs }],
    });
    expect(env.status).toBe(201);
    expect(env.body.venta_id).toBeTruthy();
    // La caja sube 500000 una sola vez (lo postea el envío, no la venta)
    expect(await saldoCaja()).toBe(antes + 500000);
    // La venta existe con el cliente del envío
    const ventas = await request(app).get('/api/ventas').set(auth());
    const v = ventas.body.data.find(x => x.id === env.body.venta_id);
    expect(v).toBeTruthy();
    expect(v.cliente_nombre).toBe('Cliente Envío');
    // Borrar el envío borra la venta asociada
    await request(app).delete(`/api/envios/${env.body.id}`).set(auth());
    const ventas2 = await request(app).get('/api/ventas').set(auth());
    expect(ventas2.body.data.some(x => x.id === env.body.venta_id)).toBe(false);
  });

  it('con tc + producto_id: la venta tiene total_usd real y descuenta stock', async () => {
    // Producto unitario para linkear desde el envío
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'iPhone Test', clase: 'celular', tipo_carga: 'unitario', categoria_id: catBase,
      costo: 600, costo_moneda: 'USD', precio_venta: 700, precio_moneda: 'USD', cantidad: 1,
    });
    expect(prod.status).toBe(201);
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente TC', direccion: 'Calle 2', registrar_venta: true, tc: 1000,
      items: [{ tipo: 'producto', descripcion: 'iPhone Test', monto: 700000, producto_id: prod.body.id }],
    });
    expect(env.status).toBe(201);
    expect(env.body.venta_id).toBeTruthy();
    // 700.000 ARS / 1000 = 700 USD; ganancia = 700 − 600 = 100 USD
    const v = (await request(app).get(`/api/ventas`).set(auth())).body.data.find(x => x.id === env.body.venta_id);
    expect(Number(v.total_usd)).toBe(700);
    expect(Number(v.ganancia_usd)).toBe(100);
    // El producto unitario quedó marcado como vendido (stock descontado)
    const pAfter = (await request(app).get(`/api/inventario/productos?buscar=iPhone Test`).set(auth())).body.data.find(x => x.id === prod.body.id);
    expect(pAfter.estado).toBe('vendido');
    // Al borrar el envío, se repone el stock
    await request(app).delete(`/api/envios/${env.body.id}`).set(auth());
    const pRestored = (await request(app).get(`/api/inventario/productos?buscar=iPhone Test`).set(auth())).body.data.find(x => x.id === prod.body.id);
    expect(pRestored.estado).toBe('disponible');
  });

  it('la venta nace en estado pendiente si el envío no está Entregado', async () => {
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente Pend', direccion: 'Calle P', registrar_venta: true,
      items: [{ tipo: 'producto', descripcion: 'Item P', monto: 100000 }, { tipo: 'pago', monto: 100000, metodo_pago_id: cajaArs }],
    });
    expect(env.status).toBe(201);
    expect(env.body.estado).toBe('Pendiente'); // default del schema
    const v = (await request(app).get('/api/ventas').set(auth())).body.data.find(x => x.id === env.body.venta_id);
    expect(v.estado).toBe('pendiente');
    // El listado de ventas expone envio.id y envio.estado en la fila retail.
    expect(v.envio).toBeTruthy();
    expect(v.envio.id).toBe(env.body.id);
    expect(v.envio.estado).toBe('Pendiente');
  });

  it('la venta nace acreditada si el envío se crea directamente como Entregado', async () => {
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente Entregado', direccion: 'Calle E', registrar_venta: true, estado: 'Entregado',
      items: [{ tipo: 'producto', descripcion: 'Item E', monto: 50000 }, { tipo: 'pago', monto: 50000, metodo_pago_id: cajaArs }],
    });
    expect(env.status).toBe(201);
    expect(env.body.estado).toBe('Entregado');
    const v = (await request(app).get('/api/ventas').set(auth())).body.data.find(x => x.id === env.body.venta_id);
    expect(v.estado).toBe('acreditado');
  });

  it('POST /envios/:id/confirmar-entrega marca envío Entregado y venta acreditada en una sola TX', async () => {
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente Conf', direccion: 'Calle C', registrar_venta: true,
      items: [{ tipo: 'producto', descripcion: 'Item C', monto: 80000 }, { tipo: 'pago', monto: 80000, metodo_pago_id: cajaArs }],
    });
    expect(env.body.estado).toBe('Pendiente');
    // Confirmar entrega
    const res = await request(app).post(`/api/envios/${env.body.id}/confirmar-entrega`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.envio.estado).toBe('Entregado');
    expect(res.body.venta.estado).toBe('acreditado');
    // Verificar persistencia
    const v = (await request(app).get('/api/ventas').set(auth())).body.data.find(x => x.id === env.body.venta_id);
    expect(v.estado).toBe('acreditado');
    expect(v.envio.estado).toBe('Entregado');
  });

  it('confirmar-entrega es idempotente: 200 aunque el envío ya esté Entregado', async () => {
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente Idem', direccion: 'Calle I', registrar_venta: true, estado: 'Entregado',
      items: [{ tipo: 'producto', descripcion: 'Item I', monto: 10000 }, { tipo: 'pago', monto: 10000, metodo_pago_id: cajaArs }],
    });
    const res = await request(app).post(`/api/envios/${env.body.id}/confirmar-entrega`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.envio.estado).toBe('Entregado');
    // La venta ya estaba acreditada, el endpoint no rompe
    const v = (await request(app).get('/api/ventas').set(auth())).body.data.find(x => x.id === env.body.venta_id);
    expect(v.estado).toBe('acreditado');
  });

  it('confirmar-entrega rechaza 400 si el envío está Cancelado', async () => {
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente Cncl', direccion: 'Calle X', registrar_venta: true,
      items: [{ tipo: 'producto', descripcion: 'Item X', monto: 30000 }, { tipo: 'pago', monto: 30000, metodo_pago_id: cajaArs }],
    });
    await request(app).put(`/api/envios/${env.body.id}`).set(auth()).send({ estado: 'Cancelado' });
    const res = await request(app).post(`/api/envios/${env.body.id}/confirmar-entrega`).set(auth());
    expect(res.status).toBe(400);
  });

  it('confirmar-entrega funciona en envíos sin venta asociada (registrar_venta=false)', async () => {
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente SinVenta', direccion: 'Calle SV',
      items: [{ tipo: 'pago', monto: 20000, metodo_pago_id: cajaArs }],
    });
    expect(env.body.venta_id).toBeFalsy();
    const res = await request(app).post(`/api/envios/${env.body.id}/confirmar-entrega`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.envio.estado).toBe('Entregado');
    expect(res.body.venta).toBeNull();
  });

  it('PUT que cambia el envío a Entregado también sincroniza la venta a acreditado', async () => {
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente Sync', direccion: 'Calle S', registrar_venta: true,
      items: [{ tipo: 'producto', descripcion: 'Item S', monto: 70000 }, { tipo: 'pago', monto: 70000, metodo_pago_id: cajaArs }],
    });
    let v = (await request(app).get('/api/ventas').set(auth())).body.data.find(x => x.id === env.body.venta_id);
    expect(v.estado).toBe('pendiente');
    // PUT cambia estado del envío a Entregado
    await request(app).put(`/api/envios/${env.body.id}`).set(auth()).send({ estado: 'Entregado' });
    v = (await request(app).get('/api/ventas').set(auth())).body.data.find(x => x.id === env.body.venta_id);
    expect(v.estado).toBe('acreditado');
    // Y al revés: volver a Pendiente devuelve la venta a pendiente
    await request(app).put(`/api/envios/${env.body.id}`).set(auth()).send({ estado: 'Pendiente' });
    v = (await request(app).get('/api/ventas').set(auth())).body.data.find(x => x.id === env.body.venta_id);
    expect(v.estado).toBe('pendiente');
  });

  it('cancelar el envío revierte los efectos de la venta y la marca cancelada', async () => {
    const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'iPhone Cancel', clase: 'celular', tipo_carga: 'unitario', categoria_id: catBase,
      costo: 400, costo_moneda: 'USD', precio_venta: 500, precio_moneda: 'USD', cantidad: 1,
    });
    const env = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente Cancel', direccion: 'Calle 3', registrar_venta: true, tc: 1000,
      items: [{ tipo: 'producto', descripcion: 'iPhone Cancel', monto: 500000, producto_id: prod.body.id }],
    });
    expect((await request(app).get(`/api/inventario/productos?buscar=iPhone Cancel`).set(auth())).body.data.find(x => x.id === prod.body.id).estado).toBe('vendido');
    // Cancelar el envío
    const upd = await request(app).put(`/api/envios/${env.body.id}`).set(auth()).send({ estado: 'Cancelado' });
    expect(upd.status).toBe(200);
    // El producto vuelve a disponible (stock repuesto)
    const pAfter = (await request(app).get(`/api/inventario/productos?buscar=iPhone Cancel`).set(auth())).body.data.find(x => x.id === prod.body.id);
    expect(pAfter.estado).toBe('disponible');
    // La venta sigue existiendo pero en estado 'cancelado'
    const v = (await request(app).get('/api/ventas').set(auth())).body.data.find(x => x.id === env.body.venta_id);
    expect(v.estado).toBe('cancelado');
  });
});
