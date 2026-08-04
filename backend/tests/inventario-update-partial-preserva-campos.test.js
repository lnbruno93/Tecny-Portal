/**
 * Tests de integración — fix task #308 (bug Lucas P0 data corruption, 2026-08-04).
 *
 * El bug: `PATCH /api/inventario/productos/:id` con body parcial `{ costo: 80 }`
 * reseteaba `precio_venta` a 0 (y viceversa). Root cause: `baseProducto` en
 * `schemas/inventario.js` tenía `.default(0)` en `costo`, `precio_venta`,
 * `cantidad`, etc. `updateProductoSchema` era `.partial()` pero Zod aplicaba
 * los defaults ANTES del partial → el body llegaba con TODOS los campos + 0.
 * El handler hace `SET precio_venta = COALESCE(0, precio_venta)` → 0 gana.
 *
 * Fix: mover los defaults a `CREATE_DEFAULTS` y aplicarlos solo en
 * `createProductoSchema` (y en `productoEnBulk`, `productoEnCompraSchema`,
 * `productoEnEntregaSchema` — todos son CREATE derivados).
 * `updateProductoSchema` ya no popula esos campos → COALESCE preserva DB.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, productoId;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;

  // Producto con costo=70, precio_venta=100 (el caso del screenshot de Lucas).
  const p = await request(app).post('/api/inventario/productos').set(auth()).send({
    nombre: 'Test 308 Producto',
    imei: 'IMEI-308-BASE-001',
    tipo_carga: 'unitario',
    costo: 70, costo_moneda: 'USD',
    precio_venta: 100, precio_moneda: 'USD',
    cantidad: 1, estado: 'disponible',
  });
  expect(p.status).toBe(201);
  expect(Number(p.body.costo)).toBe(70);
  expect(Number(p.body.precio_venta)).toBe(100);
  productoId = p.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

async function getFresh() {
  const { rows } = await pool.query(
    'SELECT costo, precio_venta, cantidad, costo_moneda, precio_moneda, estado, tipo_carga, trackear_stock FROM productos WHERE id = $1',
    [productoId]
  );
  return rows[0];
}

describe('PUT /api/inventario/productos/:id — body parcial NO borra otros campos', () => {
  it('PATCH { costo: 80 } preserva precio_venta, cantidad y demás', async () => {
    const r = await request(app).put(`/api/inventario/productos/${productoId}`)
      .set(auth()).send({ costo: 80 });
    expect(r.status).toBe(200);
    const fresh = await getFresh();
    expect(Number(fresh.costo)).toBe(80);          // se modificó ✓
    expect(Number(fresh.precio_venta)).toBe(100);  // NO se tocó ✓ (era el bug)
    expect(Number(fresh.cantidad)).toBe(1);
    expect(fresh.costo_moneda).toBe('USD');
    expect(fresh.precio_moneda).toBe('USD');
    expect(fresh.estado).toBe('disponible');
    expect(fresh.tipo_carga).toBe('unitario');
    expect(fresh.trackear_stock).toBe(true);
  });

  it('PATCH { precio_venta: 150 } preserva costo (regresión inversa)', async () => {
    const r = await request(app).put(`/api/inventario/productos/${productoId}`)
      .set(auth()).send({ precio_venta: 150 });
    expect(r.status).toBe(200);
    const fresh = await getFresh();
    expect(Number(fresh.precio_venta)).toBe(150);  // se modificó ✓
    expect(Number(fresh.costo)).toBe(80);          // NO se tocó ✓ (era el bug simétrico)
    expect(Number(fresh.cantidad)).toBe(1);
  });

  it('PATCH { color: "azul" } preserva costo, precio_venta y cantidad', async () => {
    const r = await request(app).put(`/api/inventario/productos/${productoId}`)
      .set(auth()).send({ color: 'azul' });
    expect(r.status).toBe(200);
    const fresh = await getFresh();
    expect(Number(fresh.costo)).toBe(80);
    expect(Number(fresh.precio_venta)).toBe(150);
    expect(Number(fresh.cantidad)).toBe(1);
  });

  it('PATCH { costo: 0 } sí puede setear costo a 0 explícitamente (edge case)', async () => {
    // El fix no debe romper el escenario legítimo "quiero setear costo=0"
    // (ej: item manual sin costo). El endpoint debe respetar el 0 explícito.
    const r = await request(app).put(`/api/inventario/productos/${productoId}`)
      .set(auth()).send({ costo: 0 });
    expect(r.status).toBe(200);
    const fresh = await getFresh();
    expect(Number(fresh.costo)).toBe(0);           // sí, 0 explícito respetado
    expect(Number(fresh.precio_venta)).toBe(150);  // sigue preservado
  });

  it('POST /productos con body mínimo aplica defaults (no rompe create)', async () => {
    // Regresión defensiva: al mover defaults a CREATE_DEFAULTS, el POST
    // sigue funcionando cuando el body omite campos con default.
    const p = await request(app).post('/api/inventario/productos').set(auth()).send({
      nombre: 'Test 308 Defaults Create',
      imei: 'IMEI-308-DEFAULTS-001',
      costo: 50, costo_moneda: 'USD',
      // Sin: tipo_carga, precio_venta, precio_moneda, cantidad, estado, trackear_stock
    });
    expect(p.status).toBe(201);
    // Los defaults se aplican correctamente
    expect(p.body.tipo_carga).toBe('unitario');
    expect(Number(p.body.precio_venta)).toBe(0);
    expect(p.body.precio_moneda).toBe('USD');
    expect(Number(p.body.cantidad)).toBe(1);
    expect(p.body.estado).toBe('disponible');
    expect(p.body.trackear_stock).toBe(true);
  });
});
