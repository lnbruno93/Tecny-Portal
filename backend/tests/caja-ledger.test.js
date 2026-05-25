/**
 * Tests de integración — Ledger de cajas (Fase 2a)
 * Saldo inicial por caja + movimientos (ajustes manuales) + saldo_actual.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

async function crearCaja(over = {}) {
  const res = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Ledger ' + Math.random().toString(36).slice(2, 7), moneda: 'USD', ...over });
  return res.body;
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Ledger de cajas', () => {
  it('una caja arranca con su saldo inicial', async () => {
    const caja = await crearCaja({ saldo_inicial: 1000 });
    expect(Number(caja.saldo_inicial)).toBe(1000);

    const list = await request(app).get('/api/cajas/cajas').set(auth());
    const row = list.body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(1000);
  });

  it('los ajustes (ingreso/egreso) actualizan el saldo_actual', async () => {
    const caja = await crearCaja({ saldo_inicial: 500 });

    const ing = await request(app).post(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth())
      .send({ fecha: hoy, tipo: 'ingreso', monto: 300, concepto: 'arqueo +' });
    expect(ing.status).toBe(201);

    const egr = await request(app).post(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth())
      .send({ fecha: hoy, tipo: 'egreso', monto: 100, concepto: 'retiro' });
    expect(egr.status).toBe(201);

    // saldo = 500 + 300 - 100 = 700
    const row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(700);
    expect(Number(row.movimientos)).toBe(2);

    // historial
    const movs = await request(app).get(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth());
    expect(movs.body).toHaveLength(2);

    // borrar el egreso → saldo vuelve a 800
    const del = await request(app).delete(`/api/cajas/cajas/movimientos/${egr.body.id}`).set(auth());
    expect(del.status).toBe(200);
    const row2 = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row2.saldo_actual)).toBe(800);
  });

  it('editar el saldo inicial recalcula el saldo', async () => {
    const caja = await crearCaja({ saldo_inicial: 100 });
    await request(app).put(`/api/cajas/cajas/${caja.id}`).set(auth()).send({ saldo_inicial: 250 });
    const row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(250);
  });

  it('un PAGO a proveedor egresa de la caja y se revierte al borrarlo', async () => {
    const caja = await crearCaja({ saldo_inicial: 1000 });
    const prov = await request(app).post('/api/proveedores').set(auth()).send({ nombre: 'Prov Caja ' + Math.random() });

    const pago = await request(app).post('/api/proveedores/movimientos').set(auth())
      .send({ proveedor_id: prov.body.id, fecha: hoy, tipo: 'pago', monto: 300, moneda: 'USD', caja_id: caja.id });
    expect(pago.status).toBe(201);

    // caja: 1000 - 300 = 700
    let row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(700);
    const movs = await request(app).get(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth());
    expect(movs.body.some(m => m.origen === 'proveedor' && m.tipo === 'egreso')).toBe(true);

    // borrar el pago → caja vuelve a 1000
    await request(app).delete(`/api/proveedores/movimientos/${pago.body.id}`).set(auth());
    row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(1000);
  });

  it('un egreso impacta la caja y se revierte al borrarlo', async () => {
    const caja = await crearCaja({ saldo_inicial: 500 });
    const egr = await request(app).post('/api/ventas/egresos').set(auth())
      .send({ fecha: hoy, concepto: 'Alquiler', monto: 200, moneda: 'USD', metodo_pago_id: caja.id });
    expect(egr.status).toBe(201);

    let row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(300); // 500 - 200

    await request(app).delete(`/api/ventas/egresos/${egr.body.id}`).set(auth());
    row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(500);
  });

  it('solo una caja puede ser la financiera', async () => {
    const c1 = await crearCaja({ es_financiera: true });
    expect(c1.es_financiera).toBe(true);
    const c2 = await crearCaja({ es_financiera: true });
    // al marcar c2, c1 deja de serlo
    const list = (await request(app).get('/api/cajas/cajas').set(auth())).body;
    const fin = list.filter(c => c.es_financiera);
    expect(fin).toHaveLength(1);
    expect(fin[0].id).toBe(c2.id);
  });

  it('una VENTA con caja normal ingresa a la caja y se revierte al cancelar/borrar', async () => {
    const caja = await crearCaja({ saldo_inicial: 0 });
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      cliente_nombre: 'Cliente Caja',
      estado: 'acreditado',
      items: [{ descripcion: 'Producto X', cantidad: 1, precio_vendido: 950, costo: 800, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: caja.id, metodo_nombre: caja.nombre, monto: 950, moneda: 'USD' }],
    });
    expect(venta.status).toBe(201);

    // caja: 0 + 950 = 950, con un movimiento origen 'venta'
    let row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(950);
    const movs = await request(app).get(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth());
    expect(movs.body.some(m => m.origen === 'venta' && m.tipo === 'ingreso')).toBe(true);

    // cancelar la venta (solo metadatos) → revierte el ingreso
    await request(app).put(`/api/ventas/${venta.body.id}`).set(auth()).send({ estado: 'cancelado' });
    row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(0);

    // reactivar → vuelve a ingresar
    await request(app).put(`/api/ventas/${venta.body.id}`).set(auth()).send({ estado: 'acreditado' });
    row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(950);

    // borrar → revierte definitivamente
    await request(app).delete(`/api/ventas/${venta.body.id}`).set(auth());
    row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(0);
  });

  it('una VENTA con la caja FINANCIERA no impacta la caja; al adjuntar comprobante crea el comprobante de Financiera', async () => {
    // marcar % de retención de Financiera
    const cfg = await request(app).put('/api/config').set(auth()).send({ pct_financiera: 10 });
    expect(cfg.status).toBe(200);

    const cajaFin = await crearCaja({ saldo_inicial: 0, es_financiera: true });
    expect(cajaFin.es_financiera).toBe(true);

    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy,
      cliente_nombre: 'Cliente Financiera',
      estado: 'acreditado',
      items: [{ descripcion: 'Producto Fin', cantidad: 1, precio_vendido: 1000, costo: 700, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: cajaFin.id, metodo_nombre: cajaFin.nombre, monto: 1000, moneda: 'USD' }],
    });
    expect(venta.status).toBe(201);

    // la caja financiera NO recibe ingreso (va por comprobante)
    const row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === cajaFin.id);
    expect(Number(row.saldo_actual)).toBe(0);

    // adjuntar comprobante → se auto-genera el comprobante de Financiera (comisión 10%)
    const comp = await request(app).post(`/api/ventas/${venta.body.id}/comprobantes`).set(auth())
      .send({ archivo_data: 'data:image/png;base64,iVBORw0KGgo=', archivo_nombre: 'comp.png', archivo_tipo: 'image/png' });
    expect(comp.status).toBe(201);
    expect(comp.body.comprobante_financiera).toBeTruthy();
    expect(Number(comp.body.comprobante_financiera.monto)).toBe(1000);
    expect(Number(comp.body.comprobante_financiera.monto_financiera)).toBe(100); // 1000 × 10%
    expect(Number(comp.body.comprobante_financiera.monto_neto)).toBe(900);

    // adjuntar un segundo comprobante NO duplica el de Financiera
    const comp2 = await request(app).post(`/api/ventas/${venta.body.id}/comprobantes`).set(auth())
      .send({ archivo_data: 'data:image/png;base64,iVBORw0KGgo=', archivo_nombre: 'comp2.png', archivo_tipo: 'image/png' });
    expect(comp2.status).toBe(201);
    expect(comp2.body.comprobante_financiera).toBeNull();
  });

  it('un PAGO B2B (cuenta corriente) ingresa a la caja y se revierte al borrarlo', async () => {
    const caja = await crearCaja({ saldo_inicial: 0 });
    const cli = await request(app).post('/api/cuentas/clientes').set(auth())
      .send({ nombre: 'Mayorista Caja ' + Math.random(), categoria: 'A+' });
    expect(cli.status).toBe(201);

    const pago = await request(app).post('/api/cuentas/movimientos').set(auth())
      .send({ cliente_cc_id: cli.body.id, fecha: hoy, tipo: 'pago', monto_total: 300, caja_id: caja.id });
    expect(pago.status).toBe(201);

    // caja: 0 + 300 = 300, movimiento origen 'b2b'
    let row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(300);
    const movs = await request(app).get(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth());
    expect(movs.body.some(m => m.origen === 'b2b' && m.tipo === 'ingreso')).toBe(true);

    // borrar el pago → caja vuelve a 0
    await request(app).delete(`/api/cuentas/movimientos/${pago.body.id}`).set(auth());
    row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(0);
  });

  it('una COMPRA B2B no toca la caja (solo el pago ingresa)', async () => {
    const caja = await crearCaja({ saldo_inicial: 0 });
    const cli = await request(app).post('/api/cuentas/clientes').set(auth())
      .send({ nombre: 'Mayorista Compra ' + Math.random(), categoria: 'A-' });
    await request(app).post('/api/cuentas/movimientos').set(auth())
      .send({ cliente_cc_id: cli.body.id, fecha: hoy, tipo: 'compra', monto_total: 1000, caja_id: caja.id });
    const row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(0);
  });

  it('un COBRO de envío ingresa a la caja ARS, se revierte al cancelar y al borrar', async () => {
    const caja = await crearCaja({ moneda: 'ARS', saldo_inicial: 0 });
    const envio = await request(app).post('/api/envios').set(auth()).send({
      fecha: hoy, cliente: 'Cliente Envío', direccion: 'Calle 123', estado: 'Pendiente',
      items: [
        { tipo: 'producto', descripcion: 'Caja x1', monto: 0 },
        { tipo: 'pago', descripcion: 'Efectivo', monto: 50000, metodo_pago_id: caja.id },
      ],
    });
    expect(envio.status).toBe(201);

    // caja ARS: 0 + 50000 = 50000 (saldo nativo en ARS)
    let row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(50000);
    const movs = await request(app).get(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth());
    expect(movs.body.some(m => m.origen === 'envio' && m.tipo === 'ingreso')).toBe(true);

    // cancelar el envío → revierte el ingreso
    await request(app).put(`/api/envios/${envio.body.id}`).set(auth()).send({ estado: 'Cancelado' });
    row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(0);

    // reactivar (Entregado) → vuelve a ingresar
    await request(app).put(`/api/envios/${envio.body.id}`).set(auth()).send({ estado: 'Entregado' });
    row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(50000);

    // borrar → revierte definitivamente
    await request(app).delete(`/api/envios/${envio.body.id}`).set(auth());
    row = (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === caja.id);
    expect(Number(row.saldo_actual)).toBe(0);
  });

  it('un ajuste en una caja ARS requiere tipo de cambio', async () => {
    const caja = await crearCaja({ moneda: 'ARS' });
    const sinTc = await request(app).post(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth())
      .send({ fecha: hoy, tipo: 'ingreso', monto: 142500 });
    expect(sinTc.status).toBe(400);

    const conTc = await request(app).post(`/api/cajas/cajas/${caja.id}/movimientos`).set(auth())
      .send({ fecha: hoy, tipo: 'ingreso', monto: 142500, tc: 1425 });
    expect(conTc.status).toBe(201);
    expect(Number(conTc.body.monto_usd)).toBe(100); // 142500 / 1425
  });
});
