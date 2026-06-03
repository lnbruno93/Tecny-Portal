/**
 * Tests de integración — Tarjetas de Crédito (modelo por método de pago).
 * La comisión vive en el método de pago (es_tarjeta + comision_pct). Los cobros
 * se generan solos al vender con ese método; la liquidación ingresa el neto a una
 * caja real y baja el saldo. No se configura nada dentro de Tarjetas.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, cajaArs, metodoTarjeta;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];
const saldoCaja = async (id) => Number((await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === id).saldo_actual);
const movimientos = async (id) => (await request(app).get(`/api/tarjetas/${id}/movimientos`).set(auth())).body.data;
const tarjetas = async () => (await request(app).get('/api/tarjetas').set(auth())).body;

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const ca = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Pesos', moneda: 'ARS', saldo_inicial: 0 });
  cajaArs = ca.body.id;
  // El método "tarjeta" se crea en Cajas, con su % de comisión
  const mt = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Tarjeta de Crédito | 3 Cuotas', moneda: 'ARS', es_tarjeta: true, comision_pct: 23.5 });
  metodoTarjeta = mt.body.id;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Tarjetas — método de pago con comisión', () => {
  it('crear el método guarda es_tarjeta + comision_pct y aparece como tarjeta', async () => {
    const list = await tarjetas();
    const t = list.find(x => x.id === metodoTarjeta);
    expect(t).toBeTruthy();
    expect(Number(t.comision_pct)).toBe(23.5);
    expect(Number(t.saldo)).toBe(0);
  });
});

describe('Tarjetas — cobro automático desde Ventas', () => {
  it('una venta con el método tarjeta genera el cobro con la comisión, sin tocar la caja', async () => {
    const saldoTarAntes = await saldoCaja(metodoTarjeta);
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Cliente Tarjeta', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 100000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: metodoTarjeta, metodo_nombre: 'Tarjeta de Crédito | 3 Cuotas', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(venta.status).toBe(201);
    // la "caja tarjeta" no recibe el ingreso (entra en la liquidación)
    expect(await saldoCaja(metodoTarjeta)).toBe(saldoTarAntes);
    // cobro automático con 23,5%
    const movs = await movimientos(metodoTarjeta);
    const cobro = movs.find(m => m.tipo === 'cobro' && m.venta_id === venta.body.id);
    expect(cobro).toBeTruthy();
    expect(Number(cobro.monto_bruto)).toBe(100000);
    expect(Number(cobro.monto_comision)).toBe(23500);
    expect(Number(cobro.monto_neto)).toBe(76500);
    // saldo de la tarjeta = neto pendiente
    const t = (await tarjetas()).find(x => x.id === metodoTarjeta);
    expect(Number(t.saldo)).toBe(76500);
  });

  it('el estado de cuenta unificado (GET /movimientos) lista los cobros', async () => {
    const res = await request(app).get('/api/tarjetas/movimientos').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toHaveProperty('total');
    const cobro = res.body.data.find(m => m.tipo === 'cobro' && m.metodo_pago_id === metodoTarjeta);
    expect(cobro).toBeTruthy();
    expect(cobro.metodo_nombre).toBe('Tarjeta de Crédito | 3 Cuotas');
  });

  it('cancelar la venta revierte el cobro automático', async () => {
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Cancelable', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'P', cantidad: 1, precio_vendido: 50000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: metodoTarjeta, metodo_nombre: 'Tarjeta de Crédito | 3 Cuotas', monto: 50000, moneda: 'ARS', tc: 1000 }],
    });
    expect((await movimientos(metodoTarjeta)).some(m => m.venta_id === venta.body.id)).toBe(true);
    await request(app).delete(`/api/ventas/${venta.body.id}`).set(auth());
    expect((await movimientos(metodoTarjeta)).some(m => m.venta_id === venta.body.id)).toBe(false);
  });
});

describe('Tarjetas — liquidación', () => {
  it('liquidar ingresa el neto a la caja y baja el saldo de la tarjeta', async () => {
    const saldoTarjeta = Number((await tarjetas()).find(x => x.id === metodoTarjeta).saldo); // 76500
    const saldoCajaAntes = await saldoCaja(cajaArs);
    const l = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: metodoTarjeta, fecha: hoy, monto: 50000, caja_id: cajaArs });
    expect(l.status).toBe(201);
    expect(await saldoCaja(cajaArs)).toBe(saldoCajaAntes + 50000);
    const t = (await tarjetas()).find(x => x.id === metodoTarjeta);
    expect(Number(t.saldo)).toBe(saldoTarjeta - 50000); // 26500
  });

  it('rechaza liquidar en una caja de otra moneda (R1)', async () => {
    const cajaUsd = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja USD tarj', moneda: 'USD', saldo_inicial: 0 });
    const l = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: metodoTarjeta, fecha: hoy, monto: 100, caja_id: cajaUsd.body.id });
    expect(l.status).toBe(400); // tarjeta ARS, caja USD
  });

  it('no permite borrar un cobro autogenerado por una venta (R4)', async () => {
    const cobro = (await movimientos(metodoTarjeta)).find(m => m.tipo === 'cobro');
    const del = await request(app).delete(`/api/tarjetas/movimientos/${cobro.id}`).set(auth());
    expect(del.status).toBe(400);
  });

  it('borrar la liquidación revierte la caja', async () => {
    const liq = (await movimientos(metodoTarjeta)).find(m => m.tipo === 'liquidacion');
    const saldoCajaAntes = await saldoCaja(cajaArs);
    await request(app).delete(`/api/tarjetas/movimientos/${liq.id}`).set(auth());
    expect(await saldoCaja(cajaArs)).toBe(saldoCajaAntes - 50000);
  });
});

describe('Tarjetas — A4: liquidaciones bloquean cancelación de venta', () => {
  // Tarjeta aislada solo para estos tests, para no acoplarnos al saldo dejado
  // por los tests anteriores (que ya tienen un saldo positivo grande).
  let tarjetaAislada;
  beforeAll(async () => {
    const mt = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Tarjeta A4 Aislada', moneda: 'ARS', es_tarjeta: true, comision_pct: 0 });
    tarjetaAislada = mt.body.id;
  });

  it('si el cobro fue 100% liquidado, cancelar la venta → 400', async () => {
    // Venta con cobro de 80000 (sin comisión, monto_bruto = monto_neto = 80000)
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Pre-Liquidado', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'X', cantidad: 1, precio_vendido: 80000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: tarjetaAislada, metodo_nombre: 'Tarjeta A4 Aislada', monto: 80000, moneda: 'ARS', tc: 1000 }],
    });
    expect(venta.status).toBe(201);
    // Liquidamos los 80000 enteros → saldo de tarjeta = 0
    const liq = await request(app).post('/api/tarjetas/liquidaciones').set(auth()).send({
      metodo_pago_id: tarjetaAislada, fecha: hoy, monto: 80000, caja_id: cajaArs,
    });
    expect(liq.status).toBe(201);
    // Revertir el cobro dejaría el saldo en -80000 → bloquea
    const del = await request(app).delete(`/api/ventas/${venta.body.id}`).set(auth());
    expect(del.status).toBe(400);
    expect(del.body.error).toMatch(/liquid/i);
    // Y la venta sigue viva (rollback completo de la tx)
    const dbCheck = await request(app).get(`/api/ventas?desde=${hoy}&hasta=${hoy}`).set(auth());
    expect(dbCheck.body.data.some(v => v.id === venta.body.id)).toBe(true);
  });

  it('si hay liquidación pero el saldo queda positivo, cancelar funciona', async () => {
    // Tarjeta NUEVA con dos cobros y una liquidación parcial.
    // Diseño del test: saldo previo a la reversión = (100+50) − 30 = 120.
    // Revertir el cobro de 100 deja saldo en 20 (positivo) → no bloquea.
    const mt = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Tarjeta A4 Liquidacion Parcial', moneda: 'ARS', es_tarjeta: true, comision_pct: 0 });
    // Venta 1: 100
    const v1 = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'V1', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'A', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: mt.body.id, metodo_nombre: 'Tarjeta A4 Liquidacion Parcial', monto: 100, moneda: 'ARS', tc: 1000 }],
    });
    // Venta 2: 50 (para que quede saldo)
    await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'V2', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'B', cantidad: 1, precio_vendido: 50, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: mt.body.id, metodo_nombre: 'Tarjeta A4 Liquidacion Parcial', monto: 50, moneda: 'ARS', tc: 1000 }],
    });
    // Liquidamos 30
    await request(app).post('/api/tarjetas/liquidaciones').set(auth()).send({
      metodo_pago_id: mt.body.id, fecha: hoy, monto: 30, caja_id: cajaArs,
    });
    // Cancelar V1 (cobro 100): saldo queda 20 → permitido
    const del = await request(app).delete(`/api/ventas/${v1.body.id}`).set(auth());
    expect(del.status).toBe(200);
  });

  it('cancelar una venta sin liquidación posterior funciona normal', async () => {
    const mt = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Tarjeta A4 Sin Liq', moneda: 'ARS', es_tarjeta: true, comision_pct: 0 });
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Sin Liq', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Y', cantidad: 1, precio_vendido: 30000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: mt.body.id, metodo_nombre: 'Tarjeta A4 Sin Liq', monto: 30000, moneda: 'ARS', tc: 1000 }],
    });
    expect(venta.status).toBe(201);
    const del = await request(app).delete(`/api/ventas/${venta.body.id}`).set(auth());
    expect(del.status).toBe(200);
  });
});

// ─── Cobros previos (saldos pendientes pre-sistema) ─────────────────────────
// Para cargar saldos de ventas que existieron antes del portal. No genera
// venta, solo agrega saldo pendiente a la tarjeta. venta_id=NULL es el marker.
describe('Tarjetas — cobro previo (sin venta)', () => {
  let tarjetaPrevia;
  beforeAll(async () => {
    const mt = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Tarjeta Previa Test', moneda: 'ARS', es_tarjeta: true, comision_pct: 10 });
    tarjetaPrevia = mt.body.id;
  });

  it('POST /cobros-iniciales crea movimiento tipo=cobro con venta_id=NULL', async () => {
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({
        metodo_pago_id: tarjetaPrevia,
        fecha: hoy,
        monto_bruto: 10000,
        pct: 10, // 10% → comisión 1000, neto 9000
        comentarios: 'Ventas previas al sistema',
      });
    expect(r.status).toBe(201);
    expect(r.body.tipo).toBe('cobro');
    expect(r.body.venta_id).toBeNull();
    expect(r.body.caja_id).toBeNull();
    expect(Number(r.body.monto_bruto)).toBe(10000);
    expect(Number(r.body.monto_comision)).toBe(1000);
    expect(Number(r.body.monto_neto)).toBe(9000);
    // El saldo de la tarjeta sube en 9000 (neto pendiente).
    const list = await tarjetas();
    const t = list.find(x => x.id === tarjetaPrevia);
    expect(Number(t.saldo)).toBe(9000);
  });

  it('pct omitido → usa el comision_pct del método', async () => {
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaPrevia, fecha: hoy, monto_bruto: 5000 });
    expect(r.status).toBe(201);
    expect(Number(r.body.pct)).toBe(10); // del método
    expect(Number(r.body.monto_comision)).toBe(500); // 5000 * 10%
    expect(Number(r.body.monto_neto)).toBe(4500);
  });

  it('cobro previo SÍ se puede borrar manualmente (venta_id=NULL)', async () => {
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaPrevia, fecha: hoy, monto_bruto: 3000 });
    expect(r.status).toBe(201);
    const del = await request(app).delete(`/api/tarjetas/movimientos/${r.body.id}`).set(auth());
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
  });

  it('cobro de venta NO se puede borrar manualmente (venta_id != NULL)', async () => {
    // Crear una venta con tarjeta — genera un cobro automático con venta_id seteado.
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Test No-Borrar', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'X', cantidad: 1, precio_vendido: 8000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: tarjetaPrevia, metodo_nombre: 'Tarjeta Previa Test', monto: 8000, moneda: 'ARS', tc: 1000 }],
    });
    expect(venta.status).toBe(201);
    const movs = await movimientos(tarjetaPrevia);
    const cobroVenta = movs.find(m => m.tipo === 'cobro' && m.venta_id != null);
    expect(cobroVenta).toBeTruthy();
    // Intentar borrarlo → 400.
    const del = await request(app).delete(`/api/tarjetas/movimientos/${cobroVenta.id}`).set(auth());
    expect(del.status).toBe(400);
    expect(del.body.error).toMatch(/venta/i);
  });

  it('rechaza monto_bruto <= 0', async () => {
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaPrevia, fecha: hoy, monto_bruto: 0 });
    expect(r.status).toBe(400);
  });

  it('rechaza tarjeta inexistente', async () => {
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: 999999, fecha: hoy, monto_bruto: 1000 });
    expect(r.status).toBe(404);
  });
});

// ─── PATCH /movimientos/:id (editar cobro previo o liquidación) ─────────────
// Refleja la misma política del DELETE: cobros de venta NO se tocan acá.
// Cobros previos: recalcular comisión/neto desde bruto + pct.
// Liquidaciones: revertir caja vieja + postear nueva (mismo helper que DELETE).
describe('Tarjetas — PATCH /movimientos/:id (editar)', () => {
  let tarjetaEdit;
  beforeAll(async () => {
    const mt = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Tarjeta Edit Test', moneda: 'ARS', es_tarjeta: true, comision_pct: 20 });
    tarjetaEdit = mt.body.id;
  });

  it('edita un cobro previo y recalcula comisión + neto desde bruto + pct', async () => {
    const create = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaEdit, fecha: hoy, monto_bruto: 10000, pct: 10 });
    expect(create.status).toBe(201);
    // Edición: bruto pasa de 10000 a 20000, pct de 10 a 15 → comisión 3000, neto 17000.
    const r = await request(app).patch(`/api/tarjetas/movimientos/${create.body.id}`).set(auth())
      .send({ monto_bruto: 20000, pct: 15, comentarios: 'corregido' });
    expect(r.status).toBe(200);
    expect(Number(r.body.monto_bruto)).toBe(20000);
    expect(Number(r.body.pct)).toBe(15);
    expect(Number(r.body.monto_comision)).toBe(3000);
    expect(Number(r.body.monto_neto)).toBe(17000);
    expect(r.body.comentarios).toBe('corregido');
  });

  it('edita una liquidación: revierte la caja vieja y postea en la nueva', async () => {
    // Generamos un cobro previo grande para tener saldo a liquidar.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaEdit, fecha: hoy, monto_bruto: 100000, pct: 0 });
    // Caja origen + caja destino (ambas ARS).
    const cajaA = (await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Edit A', moneda: 'ARS', saldo_inicial: 0 })).body;
    const cajaB = (await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Edit B', moneda: 'ARS', saldo_inicial: 0 })).body;
    // Liquidación de 30000 a cajaA.
    const liq = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaEdit, fecha: hoy, monto: 30000, caja_id: cajaA.id });
    expect(liq.status).toBe(201);
    expect(await saldoCaja(cajaA.id)).toBe(30000);
    expect(await saldoCaja(cajaB.id)).toBe(0);
    // Edición: ahora va a cajaB y por 25000.
    const r = await request(app).patch(`/api/tarjetas/movimientos/${liq.body.id}`).set(auth())
      .send({ monto: 25000, caja_id: cajaB.id });
    expect(r.status).toBe(200);
    // cajaA vuelve a 0; cajaB pasa a 25000.
    expect(await saldoCaja(cajaA.id)).toBe(0);
    expect(await saldoCaja(cajaB.id)).toBe(25000);
    // Saldo del movimiento en tarjeta_movimientos: monto_bruto = monto_neto = 25000.
    expect(Number(r.body.monto_neto)).toBe(25000);
    expect(Number(r.body.monto_bruto)).toBe(25000);
    expect(r.body.caja_id).toBe(cajaB.id);
  });

  it('rechaza editar un cobro proveniente de una venta (venta_id != NULL)', async () => {
    // Crear una venta para generar un cobro auto con venta_id.
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Edit No-Tocar', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'X', cantidad: 1, precio_vendido: 5000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: tarjetaEdit, metodo_nombre: 'Tarjeta Edit Test', monto: 5000, moneda: 'ARS', tc: 1000 }],
    });
    expect(venta.status).toBe(201);
    const movs = await movimientos(tarjetaEdit);
    const cobroDeVenta = movs.find(m => m.tipo === 'cobro' && m.venta_id != null);
    expect(cobroDeVenta).toBeTruthy();
    const r = await request(app).patch(`/api/tarjetas/movimientos/${cobroDeVenta.id}`).set(auth())
      .send({ monto_bruto: 999 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/venta/i);
  });

  it('rechaza editar liquidación con caja de otra moneda', async () => {
    // Cobro previo + liquidación en ARS, luego intentar editar a caja USD.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaEdit, fecha: hoy, monto_bruto: 10000, pct: 0 });
    const liq = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaEdit, fecha: hoy, monto: 5000, caja_id: cajaArs });
    const cajaUsd = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja USD Edit', moneda: 'USD', saldo_inicial: 0 });
    const r = await request(app).patch(`/api/tarjetas/movimientos/${liq.body.id}`).set(auth())
      .send({ caja_id: cajaUsd.body.id });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/moneda/i);
  });

  it('rechaza editar movimiento inexistente (404)', async () => {
    const r = await request(app).patch('/api/tarjetas/movimientos/999999').set(auth())
      .send({ monto_bruto: 100 });
    expect(r.status).toBe(404);
  });

  it('rechaza monto_bruto <= 0 al editar', async () => {
    const create = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaEdit, fecha: hoy, monto_bruto: 5000, pct: 0 });
    const r = await request(app).patch(`/api/tarjetas/movimientos/${create.body.id}`).set(auth())
      .send({ monto_bruto: 0 });
    expect(r.status).toBe(400);
  });
});
