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
  it('una venta con el método tarjeta genera el cobro Y +ingreso por monto_neto en la caja-tarjeta', async () => {
    const saldoTarAntes = await saldoCaja(metodoTarjeta);
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Cliente Tarjeta', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 100000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: metodoTarjeta, metodo_nombre: 'Tarjeta de Crédito | 3 Cuotas', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(venta.status).toBe(201);
    // Trazabilidad junio 2026: la caja-tarjeta AHORA refleja el cobro pendiente.
    // Antes el saldo de la caja-tarjeta solo cambiaba al liquidar; ahora cada
    // cobro (de venta o previo) suma el monto_neto al saldo de la caja.
    expect(await saldoCaja(metodoTarjeta)).toBe(saldoTarAntes + 76500);
    // cobro automático con 23,5%
    const movs = await movimientos(metodoTarjeta);
    const cobro = movs.find(m => m.tipo === 'cobro' && m.venta_id === venta.body.id);
    expect(cobro).toBeTruthy();
    expect(Number(cobro.monto_bruto)).toBe(100000);
    expect(Number(cobro.monto_comision)).toBe(23500);
    expect(Number(cobro.monto_neto)).toBe(76500);
    // saldo virtual del módulo = neto pendiente, coincide con caja-tarjeta.
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

// Endpoint consumido por 360 & Capital — agrega los netos pendientes (cobros −
// liquidaciones) por moneda en un solo número. Permite sumar al patrimonio
// total lo que la financiera todavía nos debe depositar.
describe('Tarjetas — GET /saldos-resumen', () => {
  it('devuelve saldo_ars y saldo_usd numéricos', async () => {
    const r = await request(app).get('/api/tarjetas/saldos-resumen').set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('saldo_ars');
    expect(r.body).toHaveProperty('saldo_usd');
    expect(typeof r.body.saldo_ars).toBe('number');
    expect(typeof r.body.saldo_usd).toBe('number');
  });

  it('saldo_ars = suma de netos pendientes de todas las tarjetas ARS', async () => {
    // El saldo agregado tiene que coincidir con SUM(saldo) sobre todas las
    // tarjetas ARS devueltas por GET /api/tarjetas. Si difiere, hay un bug
    // de coherencia entre los dos endpoints — y Capital mentiría.
    const lista = (await request(app).get('/api/tarjetas').set(auth())).body;
    const esperadoArs = lista.filter(t => t.moneda === 'ARS').reduce((s, t) => s + Number(t.saldo || 0), 0);
    const r = await request(app).get('/api/tarjetas/saldos-resumen').set(auth());
    expect(r.body.saldo_ars).toBeCloseTo(esperadoArs, 2);
  });

  it('una liquidación parcial baja el saldo agregado por su neto', async () => {
    // Crear una tarjeta nueva con saldo conocido + liquidar parte → verificar
    // que el agregado baja exactamente por el neto liquidado.
    const mt = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC Resumen Test', moneda: 'ARS', es_tarjeta: true, comision_pct: 0 });
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: mt.body.id, fecha: hoy, monto_bruto: 1000, pct: 0 });
    const antes = (await request(app).get('/api/tarjetas/saldos-resumen').set(auth())).body.saldo_ars;
    await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: mt.body.id, fecha: hoy, monto: 400, caja_id: cajaArs });
    const despues = (await request(app).get('/api/tarjetas/saldos-resumen').set(auth())).body.saldo_ars;
    expect(despues).toBeCloseTo(antes - 400, 2);
  });

  // Tests post-auditoría TANDA 2: saldos-resumen filtra correctamente tarjetas
  // soft-deleted. Sin este test, un cambio en el WHERE rompía Capital silencioso.
  it('ignora tarjetas soft-deleted (deleted_at IS NOT NULL)', async () => {
    const mt = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC Soft Delete Test', moneda: 'ARS', es_tarjeta: true, comision_pct: 0 });
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: mt.body.id, fecha: hoy, monto_bruto: 7500, pct: 0 });
    const conTarjeta = (await request(app).get('/api/tarjetas/saldos-resumen').set(auth())).body.saldo_ars;
    // Soft-delete la tarjeta directo en DB (no hay endpoint de delete de tarjeta
    // en el módulo Tarjetas — la baja se hace desde Config Cajas).
    await pool.query('UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1', [mt.body.id]);
    const sinTarjeta = (await request(app).get('/api/tarjetas/saldos-resumen').set(auth())).body.saldo_ars;
    expect(sinTarjeta).toBeCloseTo(conTarjeta - 7500, 2);
  });
});

// Tests post-auditoría TANDA 2 (BLOCKER de cobertura): el path "editar
// liquidación cuyo dinero ya fue usado en otra caja" tira 409 vía
// reverseCajaMovimientos. Sin test, un bug ahí desincronizaba el ledger
// silenciosamente. También: PATCH parciales (solo un campo) sin test.
describe('Tarjetas — PATCH /movimientos/:id casos límite', () => {
  let tarjetaCasos;
  beforeAll(async () => {
    const mt = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC Casos Patch', moneda: 'ARS', es_tarjeta: true, comision_pct: 5 });
    tarjetaCasos = mt.body.id;
  });

  it('BLOCKER: editar liquidación que dejaría caja en negativo → 409', async () => {
    // Setup: una caja USD chica con saldo inicial 200. Una liquidación de 200
    // ingresa a esa caja → saldo = 200 (la liquidación es exactamente lo que
    // hay). Si después se gasta esa plata (egreso a 0) y luego edito la
    // liquidación para que vaya a OTRA caja, reverseCajaMovimientos quiere
    // revertir el ingreso de 200 a la caja original — pero la caja quedaría
    // en -200 (porque el egreso vació la caja). reverseCajaMovimientos
    // throwea 409.
    const tarUsd = (await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC USD Negative', moneda: 'USD', es_tarjeta: true, comision_pct: 0 })).body.id;
    const cajaA = (await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja A USD neg', moneda: 'USD', saldo_inicial: 0 })).body.id;
    const cajaB = (await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja B USD neg', moneda: 'USD', saldo_inicial: 0 })).body.id;
    // Cobro previo de USD 200 para tener saldo a liquidar.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarUsd, fecha: hoy, monto_bruto: 200, pct: 0 });
    // Liquidamos los 200 a cajaA.
    const liq = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarUsd, fecha: hoy, monto: 200, caja_id: cajaA });
    expect(liq.status).toBe(201);
    expect(await saldoCaja(cajaA)).toBe(200);
    // Gastamos los 200 de cajaA con un ajuste/egreso → saldo = 0.
    await request(app).post(`/api/cajas/cajas/${cajaA}/movimientos`).set(auth())
      .send({ fecha: hoy, tipo: 'egreso', monto: 200, concepto: 'gasto' });
    expect(await saldoCaja(cajaA)).toBe(0);
    // Ahora editar la liquidación para que vaya a cajaB.
    // reverseCajaMovimientos quiere quitar 200 de cajaA → quedaría en -200.
    // Tira 409.
    const r = await request(app).patch(`/api/tarjetas/movimientos/${liq.body.id}`).set(auth())
      .send({ caja_id: cajaB });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/negativo/i);
    // cajaA NO se modificó (rollback completo). cajaB tampoco.
    expect(await saldoCaja(cajaA)).toBe(0);
    expect(await saldoCaja(cajaB)).toBe(0);
    // La liquidación original sigue intacta.
    const movs = await movimientos(tarUsd);
    const sigue = movs.find(m => m.id === liq.body.id);
    expect(Number(sigue.monto_neto)).toBe(200);
    expect(sigue.caja_id).toBe(cajaA);
  });

  it('PATCH parcial: solo fecha en cobro previo (sin tocar monto_bruto ni pct)', async () => {
    const create = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaCasos, fecha: hoy, monto_bruto: 1000, pct: 10 });
    expect(create.status).toBe(201);
    const r = await request(app).patch(`/api/tarjetas/movimientos/${create.body.id}`).set(auth())
      .send({ fecha: '2026-05-15' });
    expect(r.status).toBe(200);
    expect(r.body.fecha).toBe('2026-05-15');
    // monto_bruto y pct intactos (fallback ?? mov.X).
    expect(Number(r.body.monto_bruto)).toBe(1000);
    expect(Number(r.body.pct)).toBe(10);
    expect(Number(r.body.monto_neto)).toBe(900); // 1000 * (1 - 10%)
  });

  it('PATCH parcial: solo comentarios en cobro previo', async () => {
    const create = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaCasos, fecha: hoy, monto_bruto: 500, pct: 0 });
    const r = await request(app).patch(`/api/tarjetas/movimientos/${create.body.id}`).set(auth())
      .send({ comentarios: 'solo comentario' });
    expect(r.status).toBe(200);
    expect(r.body.comentarios).toBe('solo comentario');
    expect(Number(r.body.monto_bruto)).toBe(500); // no se tocó
  });

  it('PATCH parcial: solo monto en liquidación (misma caja) → caja se reajusta', async () => {
    // Cobro previo para tener saldo.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaCasos, fecha: hoy, monto_bruto: 2000, pct: 0 });
    const liq = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaCasos, fecha: hoy, monto: 500, caja_id: cajaArs });
    expect(liq.status).toBe(201);
    const saldoAntes = await saldoCaja(cajaArs);
    // Editar SOLO el monto (700 en vez de 500). La caja debería subir 200 neto.
    const r = await request(app).patch(`/api/tarjetas/movimientos/${liq.body.id}`).set(auth())
      .send({ monto: 700 });
    expect(r.status).toBe(200);
    expect(Number(r.body.monto_neto)).toBe(700);
    expect(r.body.caja_id).toBe(cajaArs); // sigue siendo la misma caja
    expect(await saldoCaja(cajaArs)).toBe(saldoAntes + 200);
  });

  it('PATCH con body vacío {} → 400 (refine "al menos un campo")', async () => {
    const create = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaCasos, fecha: hoy, monto_bruto: 100, pct: 0 });
    const r = await request(app).patch(`/api/tarjetas/movimientos/${create.body.id}`).set(auth())
      .send({});
    expect(r.status).toBe(400);
  });

  it('audit_log se escribe correctamente en PATCH liquidación (UPDATE)', async () => {
    // Cobro previo + liquidar.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaCasos, fecha: hoy, monto_bruto: 2500, pct: 0 });
    const liq = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaCasos, fecha: hoy, monto: 600, caja_id: cajaArs });
    expect(liq.status).toBe(201);
    // Editar (cambia monto de 600 a 700).
    const r = await request(app).patch(`/api/tarjetas/movimientos/${liq.body.id}`).set(auth())
      .send({ monto: 700 });
    expect(r.status).toBe(200);
    // Buscar el audit_log más reciente para tarjeta_movimientos UPDATE con este id.
    const { rows } = await pool.query(
      `SELECT datos_antes, datos_despues
         FROM audit_logs
        WHERE tabla='tarjeta_movimientos' AND accion='UPDATE' AND registro_id=$1
        ORDER BY id DESC LIMIT 1`, [liq.body.id]
    );
    expect(rows[0]).toBeTruthy();
    expect(Number(rows[0].datos_antes.monto_neto)).toBe(600);
    expect(Number(rows[0].datos_despues.monto_neto)).toBe(700);
  });

  it('audit_log se escribe correctamente en POST /cobros-iniciales (INSERT)', async () => {
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaCasos, fecha: hoy, monto_bruto: 333, pct: 0, comentarios: 'audit test' });
    expect(r.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT datos_despues FROM audit_logs
        WHERE tabla='tarjeta_movimientos' AND accion='INSERT' AND registro_id=$1
        ORDER BY id DESC LIMIT 1`, [r.body.id]
    );
    expect(rows[0]).toBeTruthy();
    // audit.js mergea el extra (tipo: 'cobro_inicial') sobre despues (rows[0]) →
    // tipo termina siendo 'cobro_inicial' (pisa el tipo='cobro' de la columna).
    // Los demás campos del row quedan accesibles al nivel raíz.
    expect(rows[0].datos_despues.tipo).toBe('cobro_inicial');
    expect(Number(rows[0].datos_despues.monto_bruto)).toBe(333);
    expect(rows[0].datos_despues.comentarios).toBe('audit test');
  });
});

// H1 (auditoría 2026-06-06): cuando una liquidación se registró con conversión
// USD (tc IS NOT NULL en el row), el PATCH actual NO sabe cómo editarla — el
// código repostaba a caja con monto=ARS y tc=null, lo que en una caja USD
// rompe por mismatch de moneda. La defensa rechaza el PATCH con mensaje
// operativo hasta que se implemente edición completa.
describe('Tarjetas — PATCH de liquidación USD-convertida (H1 defensa)', () => {
  let tarjetaUSDTest, cajaUsdTest;
  beforeAll(async () => {
    const mt = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC USD Patch Defensa', moneda: 'ARS', es_tarjeta: true, comision_pct: 0 });
    tarjetaUSDTest = mt.body.id;
    const cu = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja USD Patch Defensa', moneda: 'USD', saldo_inicial: 0 });
    cajaUsdTest = cu.body.id;
    // Cargar saldo ARS para tener algo que liquidar.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaUSDTest, fecha: hoy, monto_bruto: 110000, pct: 0 });
  });

  it('PATCH cualquier campo de una liquidación USD-convertida → 400 con mensaje operativo', async () => {
    // Crear liquidación múltiple con conversión USD.
    const liq = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsdTest,
        convertir_usd: true, tc: 1100, total_usd_efectivo: 100,
        repartos: [{ metodo_pago_id: tarjetaUSDTest, monto: 110000 }],
      });
    expect(liq.status).toBe(201);
    const movId = liq.body.movimientos[0].id;
    // Intentar editar SOLO el comentario (un edit "inofensivo") → 400.
    const r = await request(app).patch(`/api/tarjetas/movimientos/${movId}`).set(auth())
      .send({ comentarios: 'arreglo' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/conversión USD/i);
    expect(r.body.error).toMatch(/eliminala/i);
  });

  it('PATCH a liquidación NO convertida sigue funcionando (no rompe el flujo viejo)', async () => {
    // Cobro previo + liquidación simple en ARS (sin conversión).
    const cobro = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaUSDTest, fecha: hoy, monto_bruto: 5000, pct: 0 });
    expect(cobro.status).toBe(201);
    const liq = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaUSDTest, fecha: hoy, monto: 5000, caja_id: cajaArs });
    expect(liq.status).toBe(201);
    const r = await request(app).patch(`/api/tarjetas/movimientos/${liq.body.id}`).set(auth())
      .send({ comentarios: 'edit ok' });
    expect(r.status).toBe(200);
    expect(r.body.comentarios).toBe('edit ok');
  });
});

// Tests para GET /api/tarjetas?desde=&hasta= y GET /api/tarjetas/:id?desde=&hasta=
// — el resumen agregado por tarjeta filtra TODO por rango (incluido el saldo).
// Decisión operativa 2026-06-05: el operador quiere consistencia visual entre
// todos los KPIs. saldo del período = cobros del rango − liqs del rango. Si
// rango = NULL/NULL coincide con el histórico real. Si filtrás, puede dar
// negativo (período donde se liquidaron más cobros que los que entraron).
describe('Tarjetas — GET resumen filtrado por rango (desde/hasta)', () => {
  let tarjetaRango;
  beforeAll(async () => {
    const mt = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC Rango Test', moneda: 'ARS', es_tarjeta: true, comision_pct: 10 });
    tarjetaRango = mt.body.id;
    // Tres cobros previos en fechas distintas. Bruto/Comision/Neto por cobro:
    //   2026-01-10 → 1000 / 100 / 900
    //   2026-03-15 → 2000 / 200 / 1800
    //   2026-05-20 → 3000 / 300 / 2700
    // Total histórico: bruto 6000, com 600, saldo 5400, movs 3.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaRango, fecha: '2026-01-10', monto_bruto: 1000, pct: 10 });
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaRango, fecha: '2026-03-15', monto_bruto: 2000, pct: 10 });
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaRango, fecha: '2026-05-20', monto_bruto: 3000, pct: 10 });
    // Una liquidación en febrero (parcial: solo 500 del cobro de enero).
    // Histórico final: 5400 cobros − 500 liq = 4900.
    await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaRango, fecha: '2026-02-05', monto: 500, caja_id: cajaArs });
  });

  it('GET /:id sin rango → totales históricos completos (saldo = histórico real)', async () => {
    const r = await request(app).get(`/api/tarjetas/${tarjetaRango}`).set(auth());
    expect(r.status).toBe(200);
    const { resumen } = r.body;
    expect(Number(resumen.saldo)).toBe(4900);            // 5400 cobros - 500 liq
    expect(Number(resumen.bruto_total)).toBe(6000);
    expect(Number(resumen.comision_total)).toBe(600);
    expect(Number(resumen.liquidado_total)).toBe(500);
    expect(Number(resumen.movimientos)).toBe(4);
  });

  it('GET /:id con rango Marzo-Abril → saldo del período = solo cobro de Marzo (1800)', async () => {
    const r = await request(app).get(`/api/tarjetas/${tarjetaRango}?desde=2026-03-01&hasta=2026-04-30`).set(auth());
    expect(r.status).toBe(200);
    const { resumen } = r.body;
    // Saldo del período = cobros del rango (1800 de marzo) − liqs del rango (0). Filtra igual que el resto.
    expect(Number(resumen.saldo)).toBe(1800);
    expect(Number(resumen.bruto_total)).toBe(2000);
    expect(Number(resumen.comision_total)).toBe(200);
    expect(Number(resumen.liquidado_total)).toBe(0);
    expect(Number(resumen.movimientos)).toBe(1);
  });

  it('GET /:id con rango Febrero → saldo del período NEGATIVO (-500): solo la liq, sin cobros', async () => {
    const r = await request(app).get(`/api/tarjetas/${tarjetaRango}?desde=2026-02-01&hasta=2026-02-28`).set(auth());
    expect(r.status).toBe(200);
    const { resumen } = r.body;
    // Sin cobros en febrero (0) menos liq de febrero (500) = -500.
    // Caso operativo: "este mes le devolví neto $500 a mi caja, sin generar saldo nuevo".
    expect(Number(resumen.saldo)).toBe(-500);
    expect(Number(resumen.bruto_total)).toBe(0);
    expect(Number(resumen.comision_total)).toBe(0);
    expect(Number(resumen.liquidado_total)).toBe(500);
    expect(Number(resumen.movimientos)).toBe(1);
  });

  it('GET / (lista) con rango Marzo-Abril → mismas reglas que /:id', async () => {
    const r = await request(app).get('/api/tarjetas?desde=2026-03-01&hasta=2026-04-30').set(auth());
    expect(r.status).toBe(200);
    const t = r.body.find(x => x.id === tarjetaRango);
    expect(t).toBeTruthy();
    expect(Number(t.saldo)).toBe(1800);
    expect(Number(t.bruto_total)).toBe(2000);
    expect(Number(t.comision_total)).toBe(200);
    expect(Number(t.liquidado_total)).toBe(0);
    expect(Number(t.movimientos)).toBe(1);
  });

  it('GET /:id con rango sin movimientos (futuro) → todo en cero (incluido el saldo)', async () => {
    const r = await request(app).get(`/api/tarjetas/${tarjetaRango}?desde=2030-01-01&hasta=2030-12-31`).set(auth());
    expect(r.status).toBe(200);
    const { resumen } = r.body;
    // Sin movs en el rango: saldo del período = 0. Consistente con el resto.
    expect(Number(resumen.saldo)).toBe(0);
    expect(Number(resumen.bruto_total)).toBe(0);
    expect(Number(resumen.comision_total)).toBe(0);
    expect(Number(resumen.liquidado_total)).toBe(0);
    expect(Number(resumen.movimientos)).toBe(0);
  });

  it('saldos-resumen (consumido por 360) SIGUE siendo histórico — ese endpoint no usa rango', async () => {
    // Defensa contra regresión: el cambio de semántica afecta a /api/tarjetas y
    // /api/tarjetas/:id (vista operativa con filtro), pero 360 & Capital lee
    // /saldos-resumen para sumar al patrimonio HOY. Ese endpoint NO acepta
    // desde/hasta y devuelve el saldo histórico real, independiente del rango.
    const lista = (await request(app).get('/api/tarjetas?desde=2030-01-01&hasta=2030-12-31').set(auth())).body;
    const t = lista.find(x => x.id === tarjetaRango);
    expect(Number(t.saldo)).toBe(0); // saldo del período (futuro) → 0
    const r = await request(app).get('/api/tarjetas/saldos-resumen').set(auth());
    // saldos-resumen debe incluir los 4900 históricos de esta tarjeta (entre los demás).
    expect(r.body.saldo_ars).toBeGreaterThanOrEqual(4900);
  });
});

// POST /api/tarjetas/liquidaciones-multiples — un depósito de la financiera
// que cubre cupones de varias modalidades (1c + 3c + 6c). Crea N liquidaciones
// + N ingresos a la caja destino en UNA tx. Si una falla → rollback completo.
describe('Tarjetas — POST /liquidaciones-multiples', () => {
  let tarjetaA, tarjetaB, tarjetaC, cajaMult;
  beforeAll(async () => {
    const a = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC Mult A', moneda: 'ARS', es_tarjeta: true, comision_pct: 10 });
    const b = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC Mult B', moneda: 'ARS', es_tarjeta: true, comision_pct: 20 });
    const c = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC Mult C', moneda: 'ARS', es_tarjeta: true, comision_pct: 30 });
    tarjetaA = a.body.id; tarjetaB = b.body.id; tarjetaC = c.body.id;
    const cj = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Mult ARS', moneda: 'ARS', saldo_inicial: 0 });
    cajaMult = cj.body.id;
    // Cargamos saldo holgado en las 3 tarjetas para poder liquidar incluso
    // los casos con override USD (~1.3M ARS). Trazabilidad junio 2026: ahora
    // la caja-tarjeta valida saldo no negativo al egresar (postCajaMovimiento
    // Tarjeta) — antes no había check y se podía liquidar más de lo cobrado.
    // Los tests dependían del comportamiento viejo; ahora pre-cargamos el
    // saldo necesario.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaA, fecha: hoy, monto_bruto: 5_000_000, pct: 0 });
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaB, fecha: hoy, monto_bruto: 5_000_000, pct: 0 });
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaC, fecha: hoy, monto_bruto: 5_000_000, pct: 0 });
  });

  it('happy path: 3 repartos → 3 movs + 3 ingresos a caja en una tx', async () => {
    const cajaAntes = await saldoCaja(cajaMult);
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult,
        repartos: [
          { metodo_pago_id: tarjetaA, monto: 10000 },
          { metodo_pago_id: tarjetaB, monto: 5000 },
          { metodo_pago_id: tarjetaC, monto: 3000 },
        ],
      });
    expect(r.status).toBe(201);
    expect(r.body.movimientos).toHaveLength(3);
    expect(Number(r.body.total)).toBe(18000);
    // Caja sube por la suma de los 3 ingresos.
    expect(await saldoCaja(cajaMult)).toBe(cajaAntes + 18000);
    // Cada tarjeta baja su saldo por el neto liquidado.
    const a = (await tarjetas()).find(x => x.id === tarjetaA);
    const b = (await tarjetas()).find(x => x.id === tarjetaB);
    const c = (await tarjetas()).find(x => x.id === tarjetaC);
    // Setup precarga 5M en cada tarjeta (era 50k/30k/20k antes del cambio a
    // saldo holgado para los tests de USD override que requieren más fondos).
    expect(Number(a.saldo)).toBe(5_000_000 - 10000);
    expect(Number(b.saldo)).toBe(5_000_000 - 5000);
    expect(Number(c.saldo)).toBe(5_000_000 - 3000);
  });

  it('una sola tarjeta también funciona (degenera al caso simple)', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult,
        repartos: [{ metodo_pago_id: tarjetaA, monto: 1000 }],
      });
    expect(r.status).toBe(201);
    expect(r.body.movimientos).toHaveLength(1);
  });

  it('rechaza tarjeta soft-deleted → 404 con rollback (caja intacta)', async () => {
    const ghost = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC Ghost Mult', moneda: 'ARS', es_tarjeta: true, comision_pct: 0 });
    await pool.query('UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1', [ghost.body.id]);
    const cajaAntes = await saldoCaja(cajaMult);
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult,
        repartos: [
          { metodo_pago_id: tarjetaA, monto: 500 },
          { metodo_pago_id: ghost.body.id, monto: 500 },
        ],
      });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no existe o no está activa/);
    // Rollback: la caja NO cambió, ni siquiera por el reparto válido de tarjetaA.
    expect(await saldoCaja(cajaMult)).toBe(cajaAntes);
  });

  it('rechaza repartos con tarjetas de distintas monedas → 400 con rollback', async () => {
    const tarUsd = (await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC USD Mult', moneda: 'USD', es_tarjeta: true, comision_pct: 0 })).body.id;
    const cajaAntes = await saldoCaja(cajaMult);
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult, // ARS
        repartos: [
          { metodo_pago_id: tarjetaA, monto: 100 }, // ARS
          { metodo_pago_id: tarUsd,   monto: 50 },  // USD — mezcla
        ],
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/mezclar/i);
    expect(await saldoCaja(cajaMult)).toBe(cajaAntes);
  });

  it('rechaza caja de moneda distinta a las tarjetas (sin conversión) → 400 con rollback', async () => {
    const cajaUsd = (await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja USD Mult', moneda: 'USD', saldo_inicial: 0 })).body.id;
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsd, // USD
        repartos: [{ metodo_pago_id: tarjetaA, monto: 100 }], // ARS — no coincide
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no coincide/);
  });

  it('rechaza repartos con tarjetas duplicadas (refine)', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult,
        repartos: [
          { metodo_pago_id: tarjetaA, monto: 100 },
          { metodo_pago_id: tarjetaA, monto: 200 }, // misma tarjeta repetida
        ],
      });
    expect(r.status).toBe(400);
    // validate() devuelve { error: 'Datos inválidos', fields: [{ field, error }] }
    // El mensaje del refine vive en fields[0].error.
    expect(r.body.fields?.some(f => /repetir/.test(f.error))).toBe(true);
  });

  it('rechaza repartos vacíos (.min(1))', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({ fecha: hoy, caja_id: cajaMult, repartos: [] });
    expect(r.status).toBe(400);
  });

  it('rechaza monto cero o negativo en algún reparto (.positive())', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult,
        repartos: [
          { metodo_pago_id: tarjetaA, monto: 100 },
          { metodo_pago_id: tarjetaB, monto: 0 }, // inválido
        ],
      });
    expect(r.status).toBe(400);
  });

  // ── Conversión a USD (junio 2026) ──
  // Caso operativo: la financiera deposita el neto ARS y se convierte a USD
  // con el TC del día. Las liquidaciones se siguen registrando en ARS en
  // tarjeta_movimientos (bajan el pendiente correcto), pero la caja USD
  // recibe el equivalente en USD.

  it('convertir_usd: caja USD recibe ARS total / TC, distribuido entre N repartos', async () => {
    const cajaUsd = (await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja USD Liq', moneda: 'USD', saldo_inicial: 0 })).body.id;
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsd,
        convertir_usd: true,
        tc: 1100,
        repartos: [
          { metodo_pago_id: tarjetaA, monto: 1100 },   // → USD 1.00
          { metodo_pago_id: tarjetaB, monto: 2200 },   // → USD 2.00
        ],
        // Sin override: USD total = 3300/1100 = 3.00 distribuido proporcional.
      });
    expect(r.status).toBe(201);
    expect(r.body.total_usd).toBeCloseTo(3, 2);
    // Caja USD subió por la suma USD (3.00).
    expect(await saldoCaja(cajaUsd)).toBeCloseTo(3, 2);
    // En tarjeta_movimientos los netos siguen en ARS (1100 y 2200).
    const movs = r.body.movimientos;
    expect(Number(movs[0].monto_neto)).toBe(1100);
    expect(Number(movs[1].monto_neto)).toBe(2200);
    // El TC quedó persistido en cada mov.
    expect(Number(movs[0].tc)).toBe(1100);
    expect(Number(movs[1].tc)).toBe(1100);
  });

  it('convertir_usd con override total_usd_efectivo: caja recibe exactamente el override', async () => {
    const cajaUsd = (await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja USD Override', moneda: 'USD', saldo_inicial: 0 })).body.id;
    // ARS 1.332.588,40 a TC 1100 → calculo da 1211.4440. La financiera
    // depositó 1211.40 por redondeo distinto → cargamos ese override.
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsd,
        convertir_usd: true, tc: 1100, total_usd_efectivo: 1211.40,
        repartos: [
          { metodo_pago_id: tarjetaA, monto: 169990.00 },
          { metodo_pago_id: tarjetaB, monto: 1162598.40 },
        ],
      });
    expect(r.status).toBe(201);
    // La suma exacta de USD en la caja = override (no el cálculo automático).
    expect(await saldoCaja(cajaUsd)).toBeCloseTo(1211.40, 2);
    expect(r.body.total_usd).toBeCloseTo(1211.40, 2);
  });

  it('convertir_usd requiere TC → 400', async () => {
    const cajaUsd = (await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja USD No TC', moneda: 'USD', saldo_inicial: 0 })).body.id;
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsd,
        convertir_usd: true,
        repartos: [{ metodo_pago_id: tarjetaA, monto: 1000 }],
      });
    expect(r.status).toBe(400);
    expect(r.body.fields?.some(f => /TC/i.test(f.error))).toBe(true);
  });

  it('convertir_usd con caja ARS → 400', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult, // ARS
        convertir_usd: true, tc: 1100,
        repartos: [{ metodo_pago_id: tarjetaA, monto: 1000 }],
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/USD\/USDT/i);
  });

  it('TC sin convertir_usd → 400 (defensa contra ruido en el payload)', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult,
        tc: 1100, // ruido, sin convertir_usd
        repartos: [{ metodo_pago_id: tarjetaA, monto: 100 }],
      });
    expect(r.status).toBe(400);
    expect(r.body.fields?.some(f => /TC/i.test(f.error))).toBe(true);
  });

  it('período cubierto: se persisten desde y hasta en cada mov', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult,
        periodo_desde: '2026-05-26', periodo_hasta: '2026-05-27',
        repartos: [
          { metodo_pago_id: tarjetaA, monto: 500 },
          { metodo_pago_id: tarjetaB, monto: 300 },
        ],
      });
    expect(r.status).toBe(201);
    r.body.movimientos.forEach(m => {
      expect(m.periodo_desde).toBe('2026-05-26');
      expect(m.periodo_hasta).toBe('2026-05-27');
    });
  });

  it('período cubierto con desde > hasta → 400', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult,
        periodo_desde: '2026-05-28', periodo_hasta: '2026-05-26',
        repartos: [{ metodo_pago_id: tarjetaA, monto: 100 }],
      });
    expect(r.status).toBe(400);
    expect(r.body.fields?.some(f => /desde/i.test(f.error) && /hasta/i.test(f.error))).toBe(true);
  });

  it('período cubierto con solo desde (sin hasta) → 400', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult,
        periodo_desde: '2026-05-26', // sin hasta
        repartos: [{ metodo_pago_id: tarjetaA, monto: 100 }],
      });
    expect(r.status).toBe(400);
    expect(r.body.fields?.some(f => /ambos extremos/i.test(f.error))).toBe(true);
  });

  it('audit_log marca batch=liquidacion_multiple en cada mov creado', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaMult,
        repartos: [
          { metodo_pago_id: tarjetaB, monto: 333 },
          { metodo_pago_id: tarjetaC, monto: 777 },
        ],
        comentarios: 'depósito 4-jun',
      });
    expect(r.status).toBe(201);
    const ids = r.body.movimientos.map(m => m.id);
    const { rows } = await pool.query(
      `SELECT registro_id, datos_despues FROM audit_logs
        WHERE tabla='tarjeta_movimientos' AND accion='INSERT' AND registro_id = ANY($1)`,
      [ids]
    );
    expect(rows).toHaveLength(2);
    rows.forEach(row => {
      expect(row.datos_despues.batch).toBe('liquidacion_multiple');
      expect(row.datos_despues.total_repartos).toBe(2);
    });
  });
});
