/**
 * Tests de integración — módulo Proyectos.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, contactoId;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  const c = await request(app).post('/api/contactos').set(auth()).send({ nombre: 'Inversor', apellido: 'Uno', tipo: 'inversor' });
  contactoId = c.body.id;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Proyectos', () => {
  let proyectoId;

  it('crea un proyecto con participantes (desde contactos)', async () => {
    const res = await request(app).post('/api/proyectos').set(auth())
      .send({ nombre: 'App iPro', objetivo: 'Lanzar v2', fecha_creacion: '2026-01-15', participantes: [contactoId] });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('App iPro');
    proyectoId = res.body.id;

    const det = await request(app).get(`/api/proyectos/${proyectoId}`).set(auth());
    expect(det.status).toBe(200);
    expect(det.body.participantes).toHaveLength(1);
    expect(det.body.participantes[0].id).toBe(contactoId);
  });

  it('rechaza proyecto sin nombre → 400', async () => {
    const res = await request(app).post('/api/proyectos').set(auth()).send({ objetivo: 'x' });
    expect(res.status).toBe(400);
  });

  it('carga un movimiento: $ + TC → USD calculado', async () => {
    const res = await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({ proyecto_id: proyectoId, fecha: '2026-02-01', detalle: 'Servidor', categoria: 'Infra', monto: 142500, tc: 1425, inversor_contacto_id: contactoId, comentarios: 'mensual' });
    expect(res.status).toBe(201);
    expect(Number(res.body.monto)).toBe(142500);
    expect(Number(res.body.monto_usd)).toBe(100); // 142500 / 1425

    // un segundo movimiento solo en USD directo
    await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({ proyecto_id: proyectoId, fecha: '2026-03-01', detalle: 'Dominio', monto_usd: 50 });

    // movimientos paginados
    const movs = await request(app).get(`/api/proyectos/${proyectoId}/movimientos`).set(auth());
    expect(Array.isArray(movs.body.data)).toBe(true);
    expect(movs.body.data).toHaveLength(2);
    expect(movs.body.pagination).toHaveProperty('total');
    expect(movs.body.data.some(m => m.inversor_nombre === 'Inversor Uno')).toBe(true);
  });

  it('el resumen del proyecto totaliza $ y USD + rango de fechas', async () => {
    const det = await request(app).get(`/api/proyectos/${proyectoId}`).set(auth());
    expect(Number(det.body.resumen.total_ars)).toBe(142500);
    expect(Number(det.body.resumen.total_usd)).toBe(150); // 100 + 50
    expect(Number(det.body.resumen.cant_movimientos)).toBe(2);
    expect(det.body.resumen.desde).toBeTruthy();
    expect(det.body.resumen.hasta).toBeTruthy();
  });

  it('la lista muestra el proyecto con totales', async () => {
    const res = await request(app).get('/api/proyectos').set(auth());
    expect(res.status).toBe(200);
    const p = res.body.find(x => x.id === proyectoId);
    expect(p).toBeTruthy();
    expect(Number(p.total_usd)).toBe(150);
    expect(Number(p.cant_movimientos)).toBe(2);
  });

  it('borra un movimiento y el total baja', async () => {
    const movs = await request(app).get(`/api/proyectos/${proyectoId}/movimientos`).set(auth());
    const usdMov = movs.body.data.find(m => Number(m.monto_usd) === 50);
    await request(app).delete(`/api/proyectos/movimientos/${usdMov.id}`).set(auth());
    const det = await request(app).get(`/api/proyectos/${proyectoId}`).set(auth());
    expect(Number(det.body.resumen.total_usd)).toBe(100);
  });
});

// ─── Integración con cajas ──────────────────────────────────────────────────
describe('Proyectos — impacto en cajas (caja_id + tipo)', () => {
  let proyId, cajaUsdId, cajaArsId;

  async function saldoCaja(id) {
    const r = await request(app).get('/api/cajas/cajas').set(auth());
    return Number((r.body || []).find(c => c.id === id)?.saldo_actual ?? 0);
  }

  beforeAll(async () => {
    const p = await request(app).post('/api/proyectos').set(auth())
      .send({ nombre: 'Proyecto Caja', fecha_creacion: '2026-04-01' });
    proyId = p.body.id;
    const ku = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja USD Proy', moneda: 'USD', saldo_inicial: 1000 });
    expect(ku.status).toBe(201);
    cajaUsdId = ku.body.id;
    const ka = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja ARS Proy', moneda: 'ARS', saldo_inicial: 100000 });
    expect(ka.status).toBe(201);
    cajaArsId = ka.body.id;
  });

  it('movimiento egreso USD postea al ledger y baja saldo de la caja', async () => {
    const antes = await saldoCaja(cajaUsdId);
    const res = await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({
        proyecto_id: proyId, fecha: '2026-04-05',
        detalle: 'Inversión en infra',
        monto_usd: 250,
        caja_id: cajaUsdId, tipo: 'egreso',
      });
    expect(res.status).toBe(201);
    expect(res.body.caja_id).toBe(cajaUsdId);
    expect(res.body.tipo).toBe('egreso');
    expect(await saldoCaja(cajaUsdId)).toBeCloseTo(antes - 250, 2);
  });

  it('movimiento ingreso ARS postea al ledger y sube saldo', async () => {
    const antes = await saldoCaja(cajaArsId);
    const res = await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({
        proyecto_id: proyId, fecha: '2026-04-06',
        detalle: 'Aporte de inversor',
        monto: 50000, tc: 1000,
        caja_id: cajaArsId, tipo: 'ingreso',
      });
    expect(res.status).toBe(201);
    expect(await saldoCaja(cajaArsId)).toBeCloseTo(antes + 50000, 2);
  });

  it('caja_id sin tipo → 400 (refine del schema)', async () => {
    const res = await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({
        proyecto_id: proyId, fecha: '2026-04-07',
        monto_usd: 100,
        caja_id: cajaUsdId,
      });
    expect(res.status).toBe(400);
  });

  it('caja_id con monto = 0 → 400 (refine: necesita monto > 0)', async () => {
    const res = await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({
        proyecto_id: proyId, fecha: '2026-04-07',
        detalle: 'Solo detalle',
        caja_id: cajaUsdId, tipo: 'egreso',
      });
    expect(res.status).toBe(400);
  });

  it('caja inexistente → 400 con rollback (no inserta el movimiento)', async () => {
    const movsAntes = (await request(app).get(`/api/proyectos/${proyId}/movimientos`).set(auth())).body.pagination.total;
    const res = await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({
        proyecto_id: proyId, fecha: '2026-04-08',
        monto_usd: 100,
        caja_id: 999999, tipo: 'egreso',
      });
    expect(res.status).toBe(400);
    const movsDespues = (await request(app).get(`/api/proyectos/${proyId}/movimientos`).set(auth())).body.pagination.total;
    expect(movsDespues).toBe(movsAntes);
  });

  it('egreso que dejaría caja en negativo → 400 (regla del ledger)', async () => {
    const saldo = await saldoCaja(cajaUsdId);
    const res = await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({
        proyecto_id: proyId, fecha: '2026-04-09',
        monto_usd: saldo + 100,
        caja_id: cajaUsdId, tipo: 'egreso',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/saldo|insuficiente/i);
  });

  it('DELETE revierte el ledger y restituye saldo de la caja', async () => {
    const antes = await saldoCaja(cajaUsdId);
    const mov = await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({
        proyecto_id: proyId, fecha: '2026-04-10',
        detalle: 'A revertir',
        monto_usd: 80,
        caja_id: cajaUsdId, tipo: 'egreso',
      });
    expect(mov.status).toBe(201);
    expect(await saldoCaja(cajaUsdId)).toBeCloseTo(antes - 80, 2);

    const del = await request(app).delete(`/api/proyectos/movimientos/${mov.body.id}`).set(auth());
    expect(del.status).toBe(200);
    expect(await saldoCaja(cajaUsdId)).toBeCloseTo(antes, 2);
  });

  it('movimiento sin caja_id NO impacta en ledger (modo legacy)', async () => {
    const saldoU = await saldoCaja(cajaUsdId);
    const saldoA = await saldoCaja(cajaArsId);
    const res = await request(app).post('/api/proyectos/movimientos').set(auth())
      .send({
        proyecto_id: proyId, fecha: '2026-04-11',
        detalle: 'Solo log, sin caja',
        monto_usd: 500,
      });
    expect(res.status).toBe(201);
    expect(res.body.caja_id).toBeNull();
    expect(await saldoCaja(cajaUsdId)).toBeCloseTo(saldoU, 2);
    expect(await saldoCaja(cajaArsId)).toBeCloseTo(saldoA, 2);
  });

  it('GET /movimientos incluye caja_nombre y caja_moneda en JOIN', async () => {
    const res = await request(app).get(`/api/proyectos/${proyId}/movimientos`).set(auth());
    const conCaja = res.body.data.find(m => m.caja_id);
    expect(conCaja).toBeTruthy();
    expect(conCaja.caja_nombre).toBeTruthy();
    expect(conCaja.caja_moneda).toMatch(/^(USD|ARS|USDT)$/);
  });
});
