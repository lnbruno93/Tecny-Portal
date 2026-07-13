/**
 * Tests de integración — Movimientos de Caja (#505).
 *
 * Cubre:
 *  - Creación exitosa entre 2 cajas de la misma moneda.
 *  - Cajas iguales rechazadas (400 por Zod + CHECK a nivel DB).
 *  - Cajas de distinta moneda rechazadas (400 con mensaje amigable).
 *  - Costo/comisión opcional: si viene > 0, sale además del monto de la origen.
 *  - Costo negativo rechazado (Zod).
 *  - Saldo insuficiente en origen → 400.
 *  - Listado paginado.
 *  - Soft delete + reversa de ambos asientos en el ledger.
 *  - Reversa que dejaría negativo → 409.
 */

const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, cajaUsd1, cajaUsd2, cajaArs, cajaUsdVacia;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];
const saldoDe = async (id) => Number(
  (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === id).saldo_actual
);

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;

  // 2 cajas USD con fondos + 1 ARS con fondos + 1 USD vacía (para test de saldo).
  const c1 = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Banco USD',       moneda: 'USD', saldo_inicial: 10000 });
  const c2 = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Efectivo USD',    moneda: 'USD', saldo_inicial: 0     });
  const c3 = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja Pesos',      moneda: 'ARS', saldo_inicial: 5000000 });
  const c4 = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Banco USD vacío', moneda: 'USD', saldo_inicial: 0     });
  cajaUsd1 = c1.body.id; cajaUsd2 = c2.body.id; cajaArs = c3.body.id; cajaUsdVacia = c4.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Movimientos de Caja (caja_transferencias)', () => {
  it('crea transferencia USD → USD y mueve el saldo entre las 2 cajas', async () => {
    const saldoOrigenAntes  = await saldoDe(cajaUsd1);
    const saldoDestinoAntes = await saldoDe(cajaUsd2);

    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy,
      caja_origen_id:  cajaUsd1,
      caja_destino_id: cajaUsd2,
      moneda: 'USD',
      monto: 500,
      descripcion: 'Retiro banco → efectivo',
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toBeDefined();
    expect(Number(r.body.monto)).toBe(500);
    expect(Number(r.body.costo)).toBe(0);

    expect(await saldoDe(cajaUsd1)).toBe(saldoOrigenAntes - 500);
    expect(await saldoDe(cajaUsd2)).toBe(saldoDestinoAntes + 500);
  });

  it('costo opcional: sale ADEMÁS del monto de la origen; destino recibe solo monto', async () => {
    const saldoOrigenAntes  = await saldoDe(cajaUsd1);
    const saldoDestinoAntes = await saldoDe(cajaUsd2);

    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy,
      caja_origen_id:  cajaUsd1,
      caja_destino_id: cajaUsd2,
      moneda: 'USD',
      monto: 100,
      costo: 5,        // comisión bancaria
      descripcion: 'Retiro con comisión',
    });
    expect(r.status).toBe(201);
    expect(Number(r.body.costo)).toBe(5);

    // Origen pierde monto + costo (105); destino recibe solo monto (100).
    expect(await saldoDe(cajaUsd1)).toBe(saldoOrigenAntes - 105);
    expect(await saldoDe(cajaUsd2)).toBe(saldoDestinoAntes + 100);
  });

  it('rechaza cajas iguales (origen == destino) → 400', async () => {
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: cajaUsd1, caja_destino_id: cajaUsd1,
      moneda: 'USD', monto: 100,
    });
    expect(r.status).toBe(400);
  });

  it('rechaza monedas distintas SIN campos cross-currency → 400 con hint del feature', async () => {
    // 2026-07-13: el mensaje cambió tras habilitar cross-currency. Antes
    // decía "usá Cambios de Divisa"; ahora hinta al toggle nuevo.
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: cajaUsd1, caja_destino_id: cajaArs,
      moneda: 'USD', monto: 100,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/TC|cambio de moneda/i);
  });

  it('rechaza costo negativo (Zod) → 400', async () => {
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: cajaUsd1, caja_destino_id: cajaUsd2,
      moneda: 'USD', monto: 100, costo: -1,
    });
    expect(r.status).toBe(400);
  });

  it('rechaza monto <= 0 (Zod) → 400', async () => {
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: cajaUsd1, caja_destino_id: cajaUsd2,
      moneda: 'USD', monto: 0,
    });
    expect(r.status).toBe(400);
  });

  it('rechaza saldo insuficiente en origen → 400', async () => {
    // cajaUsdVacia tiene saldo 0; intentamos sacar 100.
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: cajaUsdVacia, caja_destino_id: cajaUsd2,
      moneda: 'USD', monto: 100,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/saldo/i);
  });

  it('lista las transferencias con paginación', async () => {
    const r = await request(app).get('/api/caja-transferencias').set(auth());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
    expect(r.body.data.length).toBeGreaterThan(0);
    // La respuesta debe incluir nombres de las cajas para no forzar N+1 en el front.
    expect(r.body.data[0].caja_origen_nombre).toBeDefined();
    expect(r.body.data[0].caja_destino_nombre).toBeDefined();
  });

  it('DELETE revierte los 2 asientos del ledger y vuelven los saldos', async () => {
    const saldoOrigenAntes  = await saldoDe(cajaUsd1);
    const saldoDestinoAntes = await saldoDe(cajaUsd2);

    // Crear una transferencia para después borrarla.
    const c = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: cajaUsd1, caja_destino_id: cajaUsd2,
      moneda: 'USD', monto: 200,
    });
    expect(c.status).toBe(201);
    expect(await saldoDe(cajaUsd1)).toBe(saldoOrigenAntes  - 200);
    expect(await saldoDe(cajaUsd2)).toBe(saldoDestinoAntes + 200);

    const d = await request(app).delete(`/api/caja-transferencias/${c.body.id}`).set(auth());
    expect(d.status).toBe(200);
    expect(await saldoDe(cajaUsd1)).toBe(saldoOrigenAntes);
    expect(await saldoDe(cajaUsd2)).toBe(saldoDestinoAntes);
  });

  it('DELETE que dejaría negativa la caja destino → 409, no reversa', async () => {
    // Setup: transferimos 100 USD a cajaUsdVacia. Después la vaciamos con otra
    // transferencia que la deje sin fondos. Al intentar deshacer la primera,
    // cajaUsdVacia quedaría en -100.
    const t1 = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: cajaUsd1, caja_destino_id: cajaUsdVacia,
      moneda: 'USD', monto: 100,
    });
    expect(t1.status).toBe(201);
    // Vaciamos la caja destino (transfer USD → USD): sale de cajaUsdVacia hacia otra
    // caja USD para dejar cajaUsdVacia en 0.
    const t2 = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: cajaUsdVacia, caja_destino_id: cajaUsd2,
      moneda: 'USD', monto: 100,
    });
    expect(t2.status).toBe(201);

    // Intentar borrar la primera → deja cajaUsdVacia en -100 → 409.
    const d = await request(app).delete(`/api/caja-transferencias/${t1.body.id}`).set(auth());
    expect(d.status).toBe(409);
    // La transferencia sigue viva (rollback).
    const list = await request(app).get('/api/caja-transferencias').set(auth());
    const found = list.body.data.find(t => t.id === t1.body.id);
    expect(found).toBeDefined();
    expect(found.deleted_at).toBeFalsy();
  });
});

// 2026-07-13 (feature): transferencias entre cajas de distinta moneda con TC
// tipeado por el operador. Cliente reportó necesidad de mover ARS→USD
// (o similares) sin pasar por "Cambios de Divisa" (que exige más metadata).
describe('POST /api/caja-transferencias — CROSS-CURRENCY con TC manual', () => {
  async function crearCaja(nombre, moneda, saldo = 0) {
    const r = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre, moneda, saldo_inicial: saldo });
    return r.body.id;
  }

  it('ARS→USD con TC manual → egreso ARS + ingreso USD posteados correctamente', async () => {
    const origen  = await crearCaja('Cross Origen ARS ' + Date.now(), 'ARS', 2_000_000);
    const destino = await crearCaja('Cross Destino USD ' + Date.now(), 'USD');
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy,
      caja_origen_id: origen, caja_destino_id: destino,
      moneda: 'ARS', monto: 1_500_000,
      moneda_destino: 'USD', monto_destino: 1500, tc: 1000,
      descripcion: 'Compra USD Banco Tute',
    });
    expect(r.status).toBe(201);
    expect(r.body.moneda_destino).toBe('USD');
    expect(Number(r.body.monto_destino)).toBe(1500);
    expect(Number(r.body.tc)).toBe(1000);

    // Egreso en origen: 1.500.000 ARS
    // Saldo actual = 2M - 1.5M = 500k
    expect(await saldoDe(origen)).toBe(500_000);
    // Ingreso en destino: 1500 USD
    expect(await saldoDe(destino)).toBe(1500);
  });

  it('same-currency (backward compat) → moneda_destino/monto_destino/tc quedan NULL', async () => {
    const origen  = await crearCaja('SameCurr O ' + Date.now(), 'USD', 1000);
    const destino = await crearCaja('SameCurr D ' + Date.now(), 'USD');
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: origen, caja_destino_id: destino,
      moneda: 'USD', monto: 500,
    });
    expect(r.status).toBe(201);
    expect(r.body.moneda_destino).toBeNull();
    expect(r.body.monto_destino).toBeNull();
    expect(r.body.tc).toBeNull();
  });

  it('rechaza cross con solo 2 de 3 campos (todo-o-nada) → 400', async () => {
    const origen  = await crearCaja('Cross Incompleto O ' + Date.now(), 'ARS', 10000);
    const destino = await crearCaja('Cross Incompleto D ' + Date.now(), 'USD');
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: origen, caja_destino_id: destino,
      moneda: 'ARS', monto: 5000,
      moneda_destino: 'USD', tc: 1000,
      // falta monto_destino
    });
    expect(r.status).toBe(400);
  });

  it('rechaza cross con misma moneda_destino que origen', async () => {
    const origen  = await crearCaja('Cross Mismo O ' + Date.now(), 'ARS', 10000);
    const destino = await crearCaja('Cross Mismo D ' + Date.now(), 'ARS');
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: origen, caja_destino_id: destino,
      moneda: 'ARS', monto: 5000,
      moneda_destino: 'ARS', monto_destino: 5000, tc: 1,
    });
    expect(r.status).toBe(400);
  });

  it('same-currency con cajas de moneda distinta ya no rechaza con mensaje viejo — sugiere activar TC', async () => {
    const ars = await crearCaja('SameFail ARS ' + Date.now(), 'ARS', 10000);
    const usd = await crearCaja('SameFail USD ' + Date.now(), 'USD');
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: ars, caja_destino_id: usd,
      moneda: 'ARS', monto: 5000, // sin campos cross
    });
    expect(r.status).toBe(400);
    // Mensaje debe hintar la nueva feature.
    expect(r.body.error).toMatch(/TC|cambio de moneda/i);
  });

  it('DELETE de cross-currency → los 2 movimientos se reversan', async () => {
    const origen  = await crearCaja('Cross Revert O ' + Date.now(), 'ARS', 3_000_000);
    const destino = await crearCaja('Cross Revert D ' + Date.now(), 'USD');
    const r = await request(app).post('/api/caja-transferencias').set(auth()).send({
      fecha: hoy, caja_origen_id: origen, caja_destino_id: destino,
      moneda: 'ARS', monto: 2_000_000,
      moneda_destino: 'USD', monto_destino: 2000, tc: 1000,
    });
    expect(r.status).toBe(201);
    // Post-alta: origen 3M-2M=1M, destino 0+2000=2000.
    expect(await saldoDe(origen)).toBe(1_000_000);
    expect(await saldoDe(destino)).toBe(2000);

    const del = await request(app).delete(`/api/caja-transferencias/${r.body.id}`).set(auth());
    expect(del.status).toBe(200);
    // Post-delete: saldos vuelven al estado inicial.
    expect(await saldoDe(origen)).toBe(3_000_000);
    expect(await saldoDe(destino)).toBe(0);
  });
});
