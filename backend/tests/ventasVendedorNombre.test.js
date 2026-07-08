/**
 * Tests de integración — PATCH /api/ventas/:id/vendedor-nombre (#509).
 *
 * Edición focalizada del nombre del vendedor post-emisión del comprobante.
 * Ver ventas.js `router.patch('/:id/vendedor-nombre', ...)`.
 *
 * Cubre:
 *   - Update OK con string trimmed → 200 + audit log.
 *   - Null / '' → borra vendedor (persiste null).
 *   - Idempotencia: mismo valor no rompe (short-circuit).
 *   - Venta inexistente → 404.
 *   - Nombre > 120 chars → 400 (Zod).
 *   - Auth requerida → 401.
 *   - Body con campo extra → 400 (.strict()).
 *   - GET post-PATCH refleja el cambio.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, ventaId;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

beforeAll(async () => {
  pool = await setupTestDb();
  const login = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = login.body.token;
  // Categoría + producto + venta base con vendedor inicial.
  const cat = await request(app).post('/api/inventario/categorias').set(auth())
    .send({ nombre: 'VendedorTest' });
  const prod = await request(app).post('/api/inventario/productos').set(auth()).send({
    tipo_carga: 'unitario', clase: 'celular_sellado', categoria_id: cat.body.id,
    nombre: 'Test Phone', costo: 500, precio_venta: 800, cantidad: 1,
  });
  const venta = await request(app).post('/api/ventas').set(auth()).send({
    fecha: hoy,
    vendedor_nombre: 'Vendedor Original',
    items:  [{ producto_id: prod.body.id, descripcion: 'Test Phone', cantidad: 1, precio_vendido: 800, costo: 500, moneda: 'USD' }],
    pagos:  [{ metodo_nombre: 'Efectivo USD', monto: 800, moneda: 'USD' }],
  });
  ventaId = venta.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('PATCH /api/ventas/:id/vendedor-nombre — edición post-emisión (#509)', () => {
  it('actualiza el nombre del vendedor con string válido → 200 + persiste', async () => {
    const r = await request(app)
      .patch(`/api/ventas/${ventaId}/vendedor-nombre`)
      .set(auth())
      .send({ vendedor_nombre: 'Nuevo Vendedor' });
    expect(r.status).toBe(200);
    expect(r.body.vendedor_nombre).toBe('Nuevo Vendedor');
    expect(r.body.id).toBe(ventaId);
  });

  it('el GET del listado refleja el cambio', async () => {
    const r = await request(app).get('/api/ventas').set(auth());
    expect(r.status).toBe(200);
    const venta = r.body.data.find(v => v.id === ventaId);
    expect(venta.vendedor_nombre).toBe('Nuevo Vendedor');
  });

  it('trimea whitespace del input', async () => {
    const r = await request(app)
      .patch(`/api/ventas/${ventaId}/vendedor-nombre`)
      .set(auth())
      .send({ vendedor_nombre: '   Vendedor con Spaces   ' });
    expect(r.status).toBe(200);
    expect(r.body.vendedor_nombre).toBe('Vendedor con Spaces');
  });

  it('null borra el vendedor (persiste null)', async () => {
    const r = await request(app)
      .patch(`/api/ventas/${ventaId}/vendedor-nombre`)
      .set(auth())
      .send({ vendedor_nombre: null });
    expect(r.status).toBe(200);
    expect(r.body.vendedor_nombre).toBeNull();
  });

  it('string vacío normaliza a null (evita "" en DB)', async () => {
    // Seteamos algo primero.
    await request(app).patch(`/api/ventas/${ventaId}/vendedor-nombre`)
      .set(auth()).send({ vendedor_nombre: 'Temporal' });
    const r = await request(app)
      .patch(`/api/ventas/${ventaId}/vendedor-nombre`)
      .set(auth())
      .send({ vendedor_nombre: '' });
    expect(r.status).toBe(200);
    expect(r.body.vendedor_nombre).toBeNull();
  });

  it('idempotencia: enviar el mismo valor no rompe (short-circuit)', async () => {
    // Seteamos a "Idempotente".
    await request(app).patch(`/api/ventas/${ventaId}/vendedor-nombre`)
      .set(auth()).send({ vendedor_nombre: 'Idempotente' });
    // Reenviamos exactamente el mismo valor.
    const r = await request(app).patch(`/api/ventas/${ventaId}/vendedor-nombre`)
      .set(auth()).send({ vendedor_nombre: 'Idempotente' });
    expect(r.status).toBe(200);
    // El route indica sin_cambios cuando el valor coincide con el previo.
    expect(r.body.sin_cambios).toBe(true);
  });

  it('venta inexistente → 404', async () => {
    const r = await request(app).patch('/api/ventas/999999/vendedor-nombre')
      .set(auth()).send({ vendedor_nombre: 'X' });
    expect(r.status).toBe(404);
  });

  it('rechaza nombre > 120 chars → 400', async () => {
    const largo = 'A'.repeat(121);
    const r = await request(app).patch(`/api/ventas/${ventaId}/vendedor-nombre`)
      .set(auth()).send({ vendedor_nombre: largo });
    expect(r.status).toBe(400);
  });

  it('rechaza body con campo extra (.strict) → 400', async () => {
    const r = await request(app).patch(`/api/ventas/${ventaId}/vendedor-nombre`)
      .set(auth()).send({ vendedor_nombre: 'X', otro_campo: 'boom' });
    expect(r.status).toBe(400);
  });

  it('requiere auth → 401 sin token', async () => {
    const r = await request(app).patch(`/api/ventas/${ventaId}/vendedor-nombre`)
      .send({ vendedor_nombre: 'X' });
    expect(r.status).toBe(401);
  });
});
