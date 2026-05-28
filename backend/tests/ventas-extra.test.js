/**
 * Tests de integración — Ventas (sub-recursos: ventas-extra.js)
 *
 * Cubre etiquetas, métodos de pago, plantillas de garantía, egresos,
 * comprobantes de venta y ventas rápidas: happy paths + errores (409/404/400).
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

/* ═══════════ ETIQUETAS ═══════════ */
describe('Etiquetas', () => {
  it('crea una etiqueta (201) y rechaza duplicado (409)', async () => {
    const r1 = await request(app).post('/api/ventas/etiquetas').set(auth())
      .send({ nombre: 'Mayorista', color: '#ff0000' });
    expect(r1.status).toBe(201);
    expect(r1.body.nombre).toBe('Mayorista');

    const r2 = await request(app).post('/api/ventas/etiquetas').set(auth())
      .send({ nombre: 'Mayorista' });
    expect(r2.status).toBe(409);
  });

  it('lista, borra (soft-delete) y devuelve 404 al borrar inexistente', async () => {
    const created = await request(app).post('/api/ventas/etiquetas').set(auth())
      .send({ nombre: 'Promo' });
    const id = created.body.id;

    const list = await request(app).get('/api/ventas/etiquetas').set(auth());
    expect(list.body.some(e => e.id === id)).toBe(true);

    const del = await request(app).delete(`/api/ventas/etiquetas/${id}`).set(auth());
    expect(del.status).toBe(200);

    const del2 = await request(app).delete(`/api/ventas/etiquetas/${id}`).set(auth());
    expect(del2.status).toBe(404);
  });

  it('rechaza ID inválido con 400', async () => {
    const res = await request(app).delete('/api/ventas/etiquetas/abc').set(auth());
    expect(res.status).toBe(400);
  });
});

/* ═══════════ MÉTODOS DE PAGO ═══════════ */
describe('Métodos de pago', () => {
  it('devuelve la lista de métodos activos', async () => {
    const res = await request(app).get('/api/ventas/metodos-pago').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

/* ═══════════ PLANTILLAS DE GARANTÍA ═══════════ */
describe('Garantías', () => {
  it('crea una garantía default y desmarca la default anterior', async () => {
    const g1 = await request(app).post('/api/ventas/garantias').set(auth())
      .send({ nombre: 'Garantía A', texto: 'Texto A', es_default: true });
    expect(g1.status).toBe(201);
    expect(g1.body.es_default).toBe(true);

    const g2 = await request(app).post('/api/ventas/garantias').set(auth())
      .send({ nombre: 'Garantía B', texto: 'Texto B', es_default: true });
    expect(g2.status).toBe(201);

    // La A ya no debe ser default (solo puede haber una)
    const list = await request(app).get('/api/ventas/garantias').set(auth());
    const a = list.body.find(g => g.nombre === 'Garantía A');
    expect(a.es_default).toBe(false);
  });

  it('rechaza nombre duplicado (409)', async () => {
    await request(app).post('/api/ventas/garantias').set(auth())
      .send({ nombre: 'Garantía Dup', texto: 'x' });
    const dup = await request(app).post('/api/ventas/garantias').set(auth())
      .send({ nombre: 'Garantía Dup', texto: 'y' });
    expect(dup.status).toBe(409);
  });

  it('actualiza (PUT), y devuelve 404/400 según corresponda', async () => {
    const created = await request(app).post('/api/ventas/garantias').set(auth())
      .send({ nombre: 'Garantía Edit', texto: 'original' });
    const id = created.body.id;

    const upd = await request(app).put(`/api/ventas/garantias/${id}`).set(auth())
      .send({ texto: 'modificado' });
    expect(upd.status).toBe(200);
    expect(upd.body.texto).toBe('modificado');

    const notFound = await request(app).put('/api/ventas/garantias/999999').set(auth())
      .send({ texto: 'x' });
    expect(notFound.status).toBe(404);

    const badId = await request(app).put('/api/ventas/garantias/abc').set(auth())
      .send({ texto: 'x' });
    expect(badId.status).toBe(400);
  });

  it('borra (soft-delete) y devuelve 404 al reintentar', async () => {
    const created = await request(app).post('/api/ventas/garantias').set(auth())
      .send({ nombre: 'Garantía Del', texto: 'x' });
    const del = await request(app).delete(`/api/ventas/garantias/${created.body.id}`).set(auth());
    expect(del.status).toBe(200);
    const del2 = await request(app).delete(`/api/ventas/garantias/${created.body.id}`).set(auth());
    expect(del2.status).toBe(404);
  });
});

/* Egresos: ahora viven en su propio módulo → tests/egresos.test.js */

/* ═══════════ COMPROBANTES DE VENTA ═══════════ */
describe('Comprobantes de venta', () => {
  let ventaId;

  beforeAll(async () => {
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      estado: 'acreditado',
      items: [{ descripcion: 'Item suelto', cantidad: 1, precio_vendido: 100, costo: 50, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 100, moneda: 'USD' }],
    });
    ventaId = venta.body.id;
  });

  it('sube un comprobante a una venta (201) y lo lista', async () => {
    const res = await request(app).post(`/api/ventas/${ventaId}/comprobantes`).set(auth())
      .send({ archivo_data: 'iVBORw0KGgoAAAANSUhEUg==', archivo_nombre: 'recibo.png', archivo_tipo: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.archivo_nombre).toBe('recibo.png');

    const list = await request(app).get(`/api/ventas/${ventaId}/comprobantes`).set(auth());
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);

    // GET por cid devuelve el archivo_data
    const cid = list.body[0].id;
    const one = await request(app).get(`/api/ventas/comprobantes/${cid}`).set(auth());
    expect(one.status).toBe(200);
    expect(one.body.archivo_data).toBeTruthy();
  });

  it('rechaza comprobante de venta inexistente (404) e ID inválido (400)', async () => {
    const notFound = await request(app).post('/api/ventas/999999/comprobantes').set(auth())
      .send({ archivo_data: 'abc' });
    expect(notFound.status).toBe(404);

    const badId = await request(app).post('/api/ventas/abc/comprobantes').set(auth())
      .send({ archivo_data: 'abc' });
    expect(badId.status).toBe(400);
  });

  it('devuelve 404 al pedir un comprobante inexistente', async () => {
    const res = await request(app).get('/api/ventas/comprobantes/999999').set(auth());
    expect(res.status).toBe(404);
  });

  // A3: archivos adjuntos quedan soft-deleted al cancelar/borrar la venta.
  // Antes de mayo-2026 los venta_comprobantes seguían vivos y accesibles
  // (riesgo de leak y storage sin tope).
  it('A3: al borrar la venta, los comprobantes adjuntos quedan inaccesibles', async () => {
    // Venta nueva con un comprobante adjunto
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, estado: 'acreditado',
      items: [{ descripcion: 'X', cantidad: 1, precio_vendido: 100, costo: 50, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'USD | Efectivo', monto: 100, moneda: 'USD' }],
    });
    const c = await request(app).post(`/api/ventas/${venta.body.id}/comprobantes`).set(auth())
      .send({ archivo_data: 'iVBORw0KGgo=', archivo_nombre: 'r.png', archivo_tipo: 'image/png' });
    expect(c.status).toBe(201);
    const cid = c.body.id;
    // Borramos la venta
    await request(app).delete(`/api/ventas/${venta.body.id}`).set(auth());
    // Listado por venta → vacío (ya está borrada + comprobantes soft-deleted)
    const listAfter = await request(app).get(`/api/ventas/${venta.body.id}/comprobantes`).set(auth());
    expect(listAfter.body.length).toBe(0);
    // GET por cid → 404 (deleted_at IS NULL filtra la fila)
    const one = await request(app).get(`/api/ventas/comprobantes/${cid}`).set(auth());
    expect(one.status).toBe(404);
  });
});

/* ═══════════ VENTAS RÁPIDAS ═══════════ */
describe('Ventas rápidas', () => {
  it('crea, lista (con filtro de estado), actualiza y borra', async () => {
    const created = await request(app).post('/api/ventas/ventas-rapidas').set(auth())
      .send({ detalle: 'iPhone usado x cliente', cliente_texto: 'Pedro', fecha: hoy });
    expect(created.status).toBe(201);
    expect(created.body.estado).toBe('pendiente');
    const id = created.body.id;

    const list = await request(app).get('/api/ventas/ventas-rapidas?estado=pendiente').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.some(v => v.id === id)).toBe(true);

    const upd = await request(app).put(`/api/ventas/ventas-rapidas/${id}`).set(auth())
      .send({ estado: 'procesada' });
    expect(upd.status).toBe(200);
    expect(upd.body.estado).toBe('procesada');

    const del = await request(app).delete(`/api/ventas/ventas-rapidas/${id}`).set(auth());
    expect(del.status).toBe(200);
  });

  it('devuelve 404 al actualizar/borrar una venta rápida inexistente', async () => {
    const upd = await request(app).put('/api/ventas/ventas-rapidas/999999').set(auth())
      .send({ estado: 'procesada' });
    expect(upd.status).toBe(404);

    const del = await request(app).delete('/api/ventas/ventas-rapidas/999999').set(auth());
    expect(del.status).toBe(404);
  });
});
