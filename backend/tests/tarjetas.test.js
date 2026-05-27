/**
 * Tests de integración — Tarjetas de Crédito.
 * Entidades + planes (comisiones), cobro manual, liquidación (ingreso a caja),
 * saldo, y cobro automático desde una venta pagada con método tarjeta.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, entidadId, planId, cajaArs;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];
const saldoDe = async (id) => Number((await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === id).saldo_actual);
const movimientos = async (id) => (await request(app).get(`/api/tarjetas/entidades/${id}/movimientos`).set(auth())).body;

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const ca = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Pesos', moneda: 'ARS', saldo_inicial: 0 });
  cajaArs = ca.body.id;
  const e = await request(app).post('/api/tarjetas/entidades').set(auth()).send({ nombre: 'Visa' });
  entidadId = e.body.id;
  const p = await request(app).post('/api/tarjetas/planes').set(auth()).send({ entidad_id: entidadId, nombre: '3 cuotas', pct: 10 });
  planId = p.body.id;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Tarjetas — cobro manual y liquidación', () => {
  it('cobro manual calcula comisión y neto desde el plan', async () => {
    const c = await request(app).post('/api/tarjetas/cobros').set(auth())
      .send({ entidad_id: entidadId, plan_id: planId, fecha: hoy, moneda: 'ARS', monto_bruto: 100000 });
    expect(c.status).toBe(201);
    expect(Number(c.body.monto_comision)).toBe(10000); // 10%
    expect(Number(c.body.monto_neto)).toBe(90000);
  });

  it('liquidación ingresa el neto a la caja', async () => {
    const saldoAntes = await saldoDe(cajaArs);
    const l = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ entidad_id: entidadId, fecha: hoy, monto: 50000, caja_id: cajaArs });
    expect(l.status).toBe(201);
    expect(await saldoDe(cajaArs)).toBe(saldoAntes + 50000);
  });

  it('saldo = neto de cobros − liquidaciones', async () => {
    const det = await request(app).get(`/api/tarjetas/entidades/${entidadId}`).set(auth());
    expect(Number(det.body.resumen.saldo_ars)).toBe(40000); // 90000 cobrado - 50000 liquidado
  });

  it('borrar la liquidación revierte la caja', async () => {
    const movs = await movimientos(entidadId);
    const liq = movs.find(m => m.tipo === 'liquidacion');
    const saldoAntes = await saldoDe(cajaArs);
    await request(app).delete(`/api/tarjetas/movimientos/${liq.id}`).set(auth());
    expect(await saldoDe(cajaArs)).toBe(saldoAntes - 50000);
  });
});

describe('Tarjetas — cobro automático desde Ventas', () => {
  it('una venta con método tarjeta genera el cobro con su comisión, sin tocar la caja', async () => {
    // Caja marcada como tarjeta (Visa / 3 cuotas)
    const cajaTar = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Visa 3 cuotas', moneda: 'ARS', saldo_inicial: 0, es_tarjeta: true, tarjeta_entidad_id: entidadId, tarjeta_plan_id: planId });
    const saldoTarAntes = await saldoDe(cajaTar.body.id);

    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Cliente Tarjeta', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 200000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: cajaTar.body.id, metodo_nombre: 'Visa 3 cuotas', monto: 200000, moneda: 'ARS', tc: 1000 }],
    });
    expect(venta.status).toBe(201);

    // La caja-tarjeta NO recibe el ingreso (el dinero llega en la liquidación)
    expect(await saldoDe(cajaTar.body.id)).toBe(saldoTarAntes);

    // Aparece un cobro automático con la comisión del plan
    const movs = await movimientos(entidadId);
    const auto = movs.find(m => m.tipo === 'cobro' && m.venta_id === venta.body.id);
    expect(auto).toBeTruthy();
    expect(Number(auto.monto_bruto)).toBe(200000);
    expect(Number(auto.monto_comision)).toBe(20000); // 10%
    expect(Number(auto.monto_neto)).toBe(180000);
  });

  it('cancelar la venta revierte el cobro automático', async () => {
    const cajaTarId = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.nombre === 'Visa 3 cuotas').id;
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Cancelable', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'P', cantidad: 1, precio_vendido: 100000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: cajaTarId, metodo_nombre: 'Visa 3 cuotas', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    let movs = await movimientos(entidadId);
    expect(movs.some(m => m.venta_id === venta.body.id)).toBe(true);
    await request(app).delete(`/api/ventas/${venta.body.id}`).set(auth());
    movs = await movimientos(entidadId);
    expect(movs.some(m => m.venta_id === venta.body.id)).toBe(false);
  });
});
