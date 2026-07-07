/**
 * Tests de integración — Fix #4 audit 2026-07-07 Fase A forward-only:
 * validación de moneda pago vs caja + conversión en syncVentaCaja.
 *
 * Nota: en el setup de test el TEST_USER es de tenant AR (default), y hay
 * validación país-moneda que restringe UYU en cajas de tenants AR. Usamos
 * USD↔ARS que es exactamente el mismo bug estructural que reportó el
 * tenant UY con USD↔UYU — el helper `convertirMonto` trata ambos igual.
 *
 * Cubre 3 escenarios críticos:
 *   1. Misma moneda: passthrough (comportamiento pre-fix conservado).
 *   2. Mismatch sin tc: POST venta → 400.
 *   3. Mismatch con tc: POST venta → 201 y caja_movimiento en moneda de caja.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, catBase;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

async function crearProducto(over = {}) {
  const res = await request(app).post('/api/inventario/productos').set(auth()).send({
    tipo_carga: 'unitario', clase: 'celular', categoria_id: catBase, nombre: 'iPhone Test ' + Math.random(),
    costo: 100, precio_venta: 200, cantidad: 1, ...over,
  });
  return res.body;
}

async function crearCaja(over = {}) {
  const res = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Test ' + Math.random().toString(36).slice(2, 7), moneda: 'USD', saldo_inicial: 0, ...over });
  return res.body;
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const cat = await request(app).post('/api/inventario/categorias').set(auth()).send({ nombre: 'Base #4 Test' });
  catBase = cat.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Fix #4: validación moneda pago vs caja', () => {
  it('OK: pago y caja tienen misma moneda (comportamiento pre-fix)', async () => {
    const caja = await crearCaja({ moneda: 'USD' });
    const prod = await crearProducto({ precio_venta: 100 });
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Test Same Currency', estado: 'acreditado',
      items: [{ producto_id: prod.id, descripcion: 'X', cantidad: 1, precio_vendido: 100, costo: 100, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: caja.id, metodo_nombre: caja.nombre, monto: 100, moneda: 'USD' }],
    });
    expect(res.status).toBe(201);
    // Saldo de la caja: 0 + 100 = 100 USD (nativo).
    const list = await request(app).get('/api/cajas/cajas').set(auth());
    const row = list.body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(100);
  });

  it('FAIL 400: pago USD contra caja ARS sin tc → mismatch rechazado', async () => {
    const caja = await crearCaja({ moneda: 'ARS' });
    const prod = await crearProducto({ precio_venta: 100 });
    // Pago USD contra caja ARS sin tc → NO se puede convertir → rechazar.
    // Nota: NO seteamos `tc_venta` de la venta tampoco — solo así el fallback
    // del validador no consigue tc y rechaza.
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Test Mismatch No TC', estado: 'acreditado',
      items: [{ producto_id: prod.id, descripcion: 'X', cantidad: 1, precio_vendido: 100, costo: 100, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: caja.id, metodo_nombre: caja.nombre, monto: 100, moneda: 'USD' }],
    });
    expect(res.status).toBe(400);
    // La caja NO debe recibir ningún movimiento (rollback).
    const list = await request(app).get('/api/cajas/cajas').set(auth());
    const row = list.body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(0);
  });

  it('OK: pago USD contra caja ARS con tc → convierte y saldo caja en ARS', async () => {
    const caja = await crearCaja({ moneda: 'ARS' });
    const prod = await crearProducto({ precio_venta: 100 });
    // Pago 100 USD, tc=1400 (ARS/USD) → caja recibe 140000 ARS.
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Test Mismatch With TC', estado: 'acreditado',
      tc_venta: 1400,
      items: [{ producto_id: prod.id, descripcion: 'X', cantidad: 1, precio_vendido: 100, costo: 100, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: caja.id, metodo_nombre: caja.nombre, monto: 100, moneda: 'USD', tc: 1400 }],
    });
    expect(res.status).toBe(201);
    const list = await request(app).get('/api/cajas/cajas').set(auth());
    const row = list.body.find(c => c.id === caja.id);
    // Saldo esperado: 0 + 140000 ARS (100 × 1400) = 140000 ARS. La caja
    // agregada al saldo demuestra que la conversión (100 USD × 1400 = 140000)
    // se aplicó correctamente; sin el fix el saldo quedaría en 100 crudo.
    expect(Number(row.saldo_actual)).toBe(140000);
    // Mov guardado con monto ya convertido a la moneda de la caja (ARS).
    // Nota: la tabla `caja_movimientos` no tiene columna `moneda` — la moneda
    // es intrínsecamente la de la caja (metodos_pago.moneda), por eso el
    // check clave es que el `monto` esté ya convertido (no 100 sino 140000).
    const movs = await request(app).get(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth());
    const venta = movs.body.data.find(m => m.origen === 'venta');
    expect(venta).toBeDefined();
    expect(Number(venta.monto)).toBe(140000);
  });

  it('OK: pagos CC (es_cuenta_corriente=true) NO validan moneda vs caja', async () => {
    const cli = await request(app).post('/api/cuentas/clientes').set(auth())
      .send({ nombre: 'Cliente CC ' + Math.random(), categoria: 'A+' });
    // Sanity: el cliente se creó. Si falla, el 400 en el POST venta era por
    // /clientes, no por nuestra validación de moneda.
    expect(cli.status).toBe(201);
    const prod = await crearProducto({ precio_venta: 100 });
    const res = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Test CC', cliente_cc_id: cli.body.id, estado: 'pendiente',
      items: [{ producto_id: prod.id, descripcion: 'X', cantidad: 1, precio_vendido: 100, costo: 100, moneda: 'USD' }],
      pagos: [{ metodo_nombre: 'Cuenta Corriente', monto: 100, moneda: 'USD', es_cuenta_corriente: true }],
    });
    if (res.status !== 201) {
      // Debug: si el CC falla, mostrar el error para diagnosticar (no lo
      // silenciamos con expect genérico).
      // eslint-disable-next-line no-console
      console.error('[test CC] POST venta falló:', res.status, res.body);
    }
    expect(res.status).toBe(201);
  });
});
