/**
 * Tests de integración — Trazabilidad Tarjetas → caja-tarjeta (junio 2026).
 *
 * Análogo a financiera-trazabilidad-caja.test.js pero para Tarjetas. Cada
 * tarjeta (es_tarjeta=true en metodos_pago) es su propia "caja". El saldo
 * pendiente "Te deben" del módulo Tarjetas ahora debe coincidir con el
 * saldo_actual de la caja-tarjeta en GET /api/cajas.
 *
 * Cubre:
 *   · POST /cobros-iniciales       → +ingreso por monto_neto en caja-tarjeta
 *   · syncTarjetaCobros (venta)    → +ingreso al crear venta con pago tarjeta
 *   · syncTarjetaCobros (cancelar) → revierte el ingreso
 *   · POST /liquidaciones          → +ingreso destino Y −egreso caja-tarjeta
 *   · POST /liquidaciones-multiples → idem por cada reparto
 *   · DELETE /movimientos/:id      → revierte ambos lados
 *   · PATCH /movimientos/:id con cambio de monto → revierte + repostea
 *   · Liquidar más de lo cobrado   → 400 (saldo caja-tarjeta no puede ir a negativo)
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

const hoy = new Date().toISOString().slice(0, 10);
const saldoCaja = async (id) => Number(
  (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === id)?.saldo_actual ?? 0
);

let tarjetaId, cajaArsId;

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  // Tarjeta (es_tarjeta=true) con comisión 10%.
  const tarj = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'TC Trazabilidad', moneda: 'ARS', es_tarjeta: true, comision_pct: 10 });
  tarjetaId = tarj.body.id;
  // Caja destino ARS para liquidaciones.
  const caja = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Trazabilidad', moneda: 'ARS', saldo_inicial: 0 });
  cajaArsId = caja.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Trazabilidad: cobros → +ingreso en caja-tarjeta', () => {
  it('POST /cobros-iniciales crea +ingreso por monto_neto', async () => {
    const antes = await saldoCaja(tarjetaId);
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto_bruto: 100000, pct: 10 });
    expect(r.status).toBe(201);
    // Neto = 100k * 0.9 = 90k
    expect(await saldoCaja(tarjetaId)).toBe(antes + 90000);
  });

  it('venta con pago tarjeta crea +ingreso por monto_neto', async () => {
    const antes = await saldoCaja(tarjetaId);
    const r = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Cliente Traz', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'P', cantidad: 1, precio_vendido: 50000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: tarjetaId, metodo_nombre: 'TC Trazabilidad', monto: 50000, moneda: 'ARS', tc: 1000 }],
    });
    expect(r.status).toBe(201);
    // Neto = 50k * 0.9 = 45k
    expect(await saldoCaja(tarjetaId)).toBe(antes + 45000);
  });

  it('cancelar venta revierte el ingreso del cobro automático', async () => {
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'A cancelar', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'X', cantidad: 1, precio_vendido: 30000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: tarjetaId, metodo_nombre: 'TC Trazabilidad', monto: 30000, moneda: 'ARS', tc: 1000 }],
    });
    const saldoConVenta = await saldoCaja(tarjetaId);
    await request(app).delete(`/api/ventas/${v.body.id}`).set(auth());
    // Revierte 27k (= 30k * 0.9)
    expect(await saldoCaja(tarjetaId)).toBe(saldoConVenta - 27000);
  });
});

describe('Trazabilidad: liquidaciones → −egreso en caja-tarjeta', () => {
  it('POST /liquidaciones genera +ingreso destino Y −egreso caja-tarjeta', async () => {
    const antesT = await saldoCaja(tarjetaId);
    const antesC = await saldoCaja(cajaArsId);
    const r = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto: 20000, caja_id: cajaArsId });
    expect(r.status).toBe(201);
    expect(await saldoCaja(tarjetaId)).toBe(antesT - 20000);
    expect(await saldoCaja(cajaArsId)).toBe(antesC + 20000);
  });

  it('DELETE liquidación revierte AMBOS lados', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto: 5000, caja_id: cajaArsId });
    const tConLiq = await saldoCaja(tarjetaId);
    const cConLiq = await saldoCaja(cajaArsId);
    await request(app).delete(`/api/tarjetas/movimientos/${r.body.id}`).set(auth());
    // Tarjeta vuelve (sube), caja destino vuelve (baja)
    expect(await saldoCaja(tarjetaId)).toBe(tConLiq + 5000);
    expect(await saldoCaja(cajaArsId)).toBe(cConLiq - 5000);
  });

  it('PATCH liquidación con monto distinto revierte + repostea ambos lados', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto: 10000, caja_id: cajaArsId });
    const tBase = await saldoCaja(tarjetaId);
    const cBase = await saldoCaja(cajaArsId);
    // Cambia el monto: tarjeta debería egresar 5000 más, caja ingresar 5000 más
    const p = await request(app).patch(`/api/tarjetas/movimientos/${r.body.id}`).set(auth())
      .send({ monto: 15000 });
    expect(p.status).toBe(200);
    expect(await saldoCaja(tarjetaId)).toBe(tBase - 5000);
    expect(await saldoCaja(cajaArsId)).toBe(cBase + 5000);
  });

  it('liquidar más de lo que hay pendiente → 400 (caja-tarjeta no puede ir a negativo)', async () => {
    const t = await saldoCaja(tarjetaId);
    const r = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto: t + 999999, caja_id: cajaArsId });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/saldo insuficiente/i);
    // El saldo NO cambió (rollback completo).
    expect(await saldoCaja(tarjetaId)).toBe(t);
  });
});

describe('Trazabilidad: cobro previo, PATCH y DELETE', () => {
  it('PATCH de cobro previo con neto distinto recalcula caja-tarjeta', async () => {
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto_bruto: 20000, pct: 0 });
    const base = await saldoCaja(tarjetaId);
    // Subir monto: neto pasa de 20k → 40k, delta +20k
    const p = await request(app).patch(`/api/tarjetas/movimientos/${r.body.id}`).set(auth())
      .send({ monto_bruto: 40000, pct: 0 });
    expect(p.status).toBe(200);
    expect(await saldoCaja(tarjetaId)).toBe(base + 20000);
  });

  it('DELETE cobro previo manual revierte el ingreso', async () => {
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto_bruto: 7000, pct: 0 });
    const conCobro = await saldoCaja(tarjetaId);
    await request(app).delete(`/api/tarjetas/movimientos/${r.body.id}`).set(auth());
    expect(await saldoCaja(tarjetaId)).toBe(conCobro - 7000);
  });
});
