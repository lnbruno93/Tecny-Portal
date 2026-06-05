/**
 * Tests de integración — Financiera (huecos de cobertura)
 *
 * Cubre lo que financiera.test.js no toca: DELETE de pagos y comprobantes,
 * filtros buscar/vendedor, y el endpoint de archivo adjunto.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

/* ═══════════ PAGOS ═══════════ */
describe('Pagos — DELETE y filtros', () => {
  let cajaArs;
  beforeAll(async () => {
    const c = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja ARS Pagos Extra', moneda: 'ARS', saldo_inicial: 0 });
    cajaArs = c.body.id;
  });

  it('borra un pago (soft-delete), y devuelve 404/400 según corresponda', async () => {
    const created = await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-02-01', monto: 1000, referencia: 'REF-DELETE', caja_id: cajaArs });
    expect(created.status).toBe(201);

    const del = await request(app).delete(`/api/pagos/${created.body.id}`).set(auth());
    expect(del.status).toBe(200);

    const del2 = await request(app).delete(`/api/pagos/${created.body.id}`).set(auth());
    expect(del2.status).toBe(404);

    const badId = await request(app).delete('/api/pagos/abc').set(auth());
    expect(badId.status).toBe(400);
  });

  it('filtra pagos por referencia (buscar)', async () => {
    await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-02-02', monto: 500, referencia: 'TransferenciaXYZ', caja_id: cajaArs });
    const res = await request(app).get('/api/pagos?buscar=TransferenciaXYZ').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every(p => /TransferenciaXYZ/i.test(p.referencia))).toBe(true);
  });
});

/* ═══════════ PAGOS — Conversión USD + impacto en cajas (junio 2026) ═══════════ */
// La financiera deposita en USD a un TC del día. El pago descuenta el saldo
// pendiente en ARS y el ingreso entra a una caja USD elegida por el operador.
// Espejo del flujo de liquidación de Tarjetas.
describe('Pagos — conversión USD + impacto en cajas', () => {
  const saldoCaja = async (id) =>
    Number((await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === id).saldo_actual);

  let cajaArs, cajaUsd;
  beforeAll(async () => {
    const ar = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja ARS Pagos USD Test', moneda: 'ARS', saldo_inicial: 0 });
    const us = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja USD Pagos USD Test', moneda: 'USD', saldo_inicial: 0 });
    cajaArs = ar.body.id; cajaUsd = us.body.id;
  });

  it('pago en ARS (sin conversión): la caja ARS sube por el monto exacto', async () => {
    const antes = await saldoCaja(cajaArs);
    const r = await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-03-01', monto: 100000, caja_id: cajaArs, referencia: 'ARS plano' });
    expect(r.status).toBe(201);
    expect(await saldoCaja(cajaArs)).toBe(antes + 100000);
    // tc y monto_usd siguen NULL.
    expect(r.body.tc).toBeNull();
    expect(r.body.monto_usd).toBeNull();
  });

  it('pago con conversión USD: caja USD sube por monto_usd, monto ARS descuenta del saldo', async () => {
    const antesUsd = await saldoCaja(cajaUsd);
    const r = await request(app).post('/api/pagos').set(auth())
      .send({
        fecha: '2026-03-02', monto: 1100000, caja_id: cajaUsd,
        convertir_usd: true, tc: 1100, monto_usd: 1000,
        referencia: 'Liquidación USD',
      });
    expect(r.status).toBe(201);
    expect(await saldoCaja(cajaUsd)).toBeCloseTo(antesUsd + 1000, 2);
    // El monto ARS sigue siendo 1.100.000 (descuenta del saldo financiera).
    expect(Number(r.body.monto)).toBe(1100000);
    expect(Number(r.body.tc)).toBe(1100);
    expect(Number(r.body.monto_usd)).toBe(1000);
  });

  it('convertir_usd con caja ARS → 400', async () => {
    const r = await request(app).post('/api/pagos').set(auth())
      .send({
        fecha: '2026-03-03', monto: 100, caja_id: cajaArs,
        convertir_usd: true, tc: 1100, monto_usd: 0.09,
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/USD\/USDT/i);
  });

  it('sin convertir_usd con caja USD → 400', async () => {
    const r = await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-03-04', monto: 100, caja_id: cajaUsd });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/ARS/);
  });

  it('convertir_usd sin TC ni monto_usd → 400', async () => {
    const r = await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-03-05', monto: 100000, caja_id: cajaUsd, convertir_usd: true });
    expect(r.status).toBe(400);
    expect(r.body.fields?.some(f => /TC/i.test(f.error) || /USD/i.test(f.error))).toBe(true);
  });

  it('caja_id obligatorio → 400 (rechaza body sin caja)', async () => {
    const r = await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-03-06', monto: 500 });
    expect(r.status).toBe(400);
  });

  it('DELETE revierte el ingreso a la caja (ARS)', async () => {
    const antes = await saldoCaja(cajaArs);
    const r = await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-03-07', monto: 7500, caja_id: cajaArs });
    expect(await saldoCaja(cajaArs)).toBe(antes + 7500);
    const del = await request(app).delete(`/api/pagos/${r.body.id}`).set(auth());
    expect(del.status).toBe(200);
    expect(await saldoCaja(cajaArs)).toBe(antes);
  });

  it('DELETE revierte el ingreso a la caja (USD)', async () => {
    const antes = await saldoCaja(cajaUsd);
    const r = await request(app).post('/api/pagos').set(auth())
      .send({
        fecha: '2026-03-08', monto: 220000, caja_id: cajaUsd,
        convertir_usd: true, tc: 1100, monto_usd: 200,
      });
    expect(await saldoCaja(cajaUsd)).toBeCloseTo(antes + 200, 2);
    const del = await request(app).delete(`/api/pagos/${r.body.id}`).set(auth());
    expect(del.status).toBe(200);
    expect(await saldoCaja(cajaUsd)).toBeCloseTo(antes, 2);
  });

  it('DELETE con caja en negativo → 409, pago NO se borra', async () => {
    // Caja USD aislada para que el saldo de tests previos no afecte: solo
    // queremos que el pago entre, después se gaste todo, y el DELETE quede
    // sin fondos para revertir.
    const cajaIsla = (await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja USD Aislada Neg', moneda: 'USD', saldo_inicial: 0 })).body.id;
    // Pago USD 100 → caja en 100.
    const r = await request(app).post('/api/pagos').set(auth())
      .send({
        fecha: '2026-03-09', monto: 110000, caja_id: cajaIsla,
        convertir_usd: true, tc: 1100, monto_usd: 100,
      });
    expect(r.status).toBe(201);
    // Gastar los 100 → caja en 0.
    await request(app).post(`/api/cajas/cajas/${cajaIsla}/movimientos`).set(auth())
      .send({ fecha: '2026-03-09', tipo: 'egreso', monto: 100, concepto: 'gasto' });
    // Ahora DELETE quiere revertir -100 → caja -100. reverseCajaMovimientos
    // detecta y tira 409.
    const del = await request(app).delete(`/api/pagos/${r.body.id}`).set(auth());
    expect(del.status).toBe(409);
    // Pago sigue activo (no borrado por rollback de la tx).
    const list = await request(app).get(`/api/pagos?buscar=`).set(auth());
    expect(list.body.data.some(p => p.id === r.body.id)).toBe(true);
  });
});

/* ═══════════ COMPROBANTES ═══════════ */
describe('Comprobantes — DELETE, filtros y archivo', () => {
  let vendedorId;

  beforeAll(async () => {
    const v = await request(app).post('/api/vendedores').set(auth()).send({ nombre: 'Vendedor Test' });
    vendedorId = v.body.id;
  });

  it('borra un comprobante (soft-delete), y devuelve 404/400 según corresponda', async () => {
    const created = await request(app).post('/api/comprobantes').set(auth())
      .send({ fecha: '2026-02-01', cliente: 'Cliente Del', monto: 1000, monto_financiera: 30, monto_neto: 970 });
    const del = await request(app).delete(`/api/comprobantes/${created.body.id}`).set(auth());
    expect(del.status).toBe(200);
    const del2 = await request(app).delete(`/api/comprobantes/${created.body.id}`).set(auth());
    expect(del2.status).toBe(404);
    const badId = await request(app).delete('/api/comprobantes/abc').set(auth());
    expect(badId.status).toBe(400);
  });

  it('filtra por vendedor y por buscar (cliente/referencia)', async () => {
    await request(app).post('/api/comprobantes').set(auth())
      .send({ fecha: '2026-02-03', cliente: 'ClienteVend', vendedor_id: vendedorId, monto: 5000, monto_financiera: 150, monto_neto: 4850, referencia: 'FACT-001' });

    const porVendedor = await request(app).get('/api/comprobantes?vendedor=Vendedor Test').set(auth());
    expect(porVendedor.status).toBe(200);
    expect(porVendedor.body.data.length).toBeGreaterThan(0);

    const porBuscar = await request(app).get('/api/comprobantes?buscar=FACT-001').set(auth());
    expect(porBuscar.status).toBe(200);
    expect(porBuscar.body.data.length).toBeGreaterThan(0);

    // totales con buscar también ejercita esa rama
    const totales = await request(app).get('/api/comprobantes/totales?buscar=FACT-001').set(auth());
    expect(totales.status).toBe(200);
    expect(totales.body.count).toBeGreaterThan(0);
  });

  it('sirve el archivo adjunto (200) y devuelve 404 si no tiene', async () => {
    const conArchivo = await request(app).post('/api/comprobantes').set(auth())
      .send({ fecha: '2026-02-04', cliente: 'Con Archivo', monto: 1000, monto_financiera: 30, monto_neto: 970, archivo_data: 'iVBORw0KGgo=', archivo_nombre: 'c.png', archivo_tipo: 'image/png' });
    const ok = await request(app).get(`/api/comprobantes/${conArchivo.body.id}/archivo`).set(auth());
    expect(ok.status).toBe(200);
    expect(ok.body.data).toBe('iVBORw0KGgo=');

    const sinArchivo = await request(app).post('/api/comprobantes').set(auth())
      .send({ fecha: '2026-02-05', cliente: 'Sin Archivo', monto: 1000, monto_financiera: 30, monto_neto: 970 });
    const notFound = await request(app).get(`/api/comprobantes/${sinArchivo.body.id}/archivo`).set(auth());
    expect(notFound.status).toBe(404);

    const badId = await request(app).get('/api/comprobantes/abc/archivo').set(auth());
    expect(badId.status).toBe(400);
  });
});
