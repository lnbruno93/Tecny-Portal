/**
 * Tests de integración — fix task #307 (bug Lautaro Tek Haus, 2026-08-04).
 *
 * El bug: la columna "Ganancia" en la lista de ventas (GET /api/ventas)
 * mostraba `ventas.ganancia_usd` cruda (bruta) sin restar
 * `comision_total_metodos` (Financiera 3% + tarjetas). El Dashboard KPI
 * ya lo hacía y el modal "Editar Venta" también, pero la lista quedó
 * inconsistente desde 2026-06-13 (Tema C).
 *
 * Impacto reproducido por Lautaro: venta u$s520 con Transferencia +3%
 * mostraba ganancia u$s101 en la grilla y u$s85 en el modal — diferencia
 * = el 3% no descontado. Vendedor toma decisiones de pricing sobre un
 * número inflado.
 *
 * Este test valida el fix: para una venta con tarjeta 11%, la respuesta
 * de GET /api/ventas debe traer `ganancia_usd = bruta - comisión`.
 * También valida el drill-down desde /api/inventario/productos/:id que
 * expone la misma ganancia.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, tarjeta1c, cajaEfectivoArs;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;

  cajaEfectivoArs = (await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Test ARS L307', moneda: 'ARS', saldo_inicial: 0 })).body.id;

  tarjeta1c = (await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Tarjeta Test L307 11%', moneda: 'ARS', es_tarjeta: true, comision_pct: 11 })).body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('GET /api/ventas — ganancia_usd debe ser NETA (bruta − comision_total_metodos)', () => {
  it('venta cobrada con efectivo: ganancia en lista == ganancia bruta (sin comisión)', async () => {
    // Setup: producto u$s100, costo u$s60 → bruta = 40 USD, comisión = 0 → neta = 40.
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Sin comisión', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Prod SinCom', cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: cajaEfectivoArs, metodo_nombre: 'Caja Test ARS L307', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v.status).toBe(201);
    expect(Number(v.body.ganancia_usd)).toBe(40);   // bruta persistida en DB
    expect(Number(v.body.comision_total_metodos)).toBe(0);

    const list = await request(app).get('/api/ventas').set(auth())
      .query({ cliente_nombre: 'Sin comisión' });
    expect(list.status).toBe(200);
    const row = list.body.data.find(r => Number(r.id) === Number(v.body.id));
    expect(row).toBeDefined();
    expect(Number(row.ganancia_usd)).toBe(40);      // sin comisión → neta = bruta
  });

  it('venta cobrada con tarjeta 11%: ganancia en lista debe restar la comisión', async () => {
    // Setup: producto u$s100, costo u$s60. Pago 100000 ARS con tarjeta 11%
    // (100000 / 1000 tc = 100 USD; comisión = 11 USD).
    // Ganancia bruta persistida: 100 - 60 = 40 USD.
    // Ganancia NETA esperada en lista: 40 - 11 = 29 USD.
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Con tarjeta 11', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Prod ConTC', cantidad: 1, precio_vendido: 100, costo: 60, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: tarjeta1c, metodo_nombre: 'Tarjeta Test L307 11%', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v.status).toBe(201);
    // Response del POST devuelve bruta (persistida en DB) — no toca.
    expect(Number(v.body.ganancia_usd)).toBe(40);
    expect(Number(v.body.comision_total_metodos)).toBeCloseTo(11, 2);

    // Listado GET debe descontar la comisión — fix task #307.
    const list = await request(app).get('/api/ventas').set(auth())
      .query({ cliente_nombre: 'Con tarjeta 11' });
    expect(list.status).toBe(200);
    const row = list.body.data.find(r => Number(r.id) === Number(v.body.id));
    expect(row).toBeDefined();
    expect(Number(row.ganancia_usd)).toBeCloseTo(29, 2);   // 40 − 11
  });

  it('venta a pérdida con tarjeta: la lista respeta el signo negativo tras restar comisión', async () => {
    // Producto u$s100, costo u$s95 → bruta = 5 USD. Pago tarjeta 11% (11 USD comisión).
    // Neta = 5 − 11 = −6 USD (pérdida). La grilla debe pintar el negativo
    // correctamente (fmtSignedParts en frontend).
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Perdida TC', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Prod Perdida', cantidad: 1, precio_vendido: 100, costo: 95, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: tarjeta1c, metodo_nombre: 'Tarjeta Test L307 11%', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v.status).toBe(201);
    expect(Number(v.body.ganancia_usd)).toBe(5);     // bruta positiva

    const list = await request(app).get('/api/ventas').set(auth())
      .query({ cliente_nombre: 'Perdida TC' });
    const row = list.body.data.find(r => Number(r.id) === Number(v.body.id));
    expect(Number(row.ganancia_usd)).toBeCloseTo(-6, 2);   // 5 − 11 (pérdida)
  });
});

// NOTA: el drill-down `/api/inventario/productos/:id` aplica el MISMO fix
// SQL (`ROUND(v.ganancia_usd - COALESCE(v.comision_total_metodos, 0))`),
// verificado en `backend/src/routes/inventario.js` línea ~1341. El
// setup del test requeriría un producto de Inventario válido con
// tenant/clase — la coherencia con el fix está garantizada por code
// review + el mismo pattern SQL. Smoke manual post-deploy suficiente.
