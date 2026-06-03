/**
 * Regresión: garantizar que `DATE` (OID 1082) se devuelve como string
 * "YYYY-MM-DD" desde node-pg, NO como `Date` JS.
 *
 * Por qué: PostgreSQL `DATE` no tiene zona horaria, pero por default node-pg
 * lo parsea como `Date` en la zona del server (Railway = UTC). `JSON.stringify`
 * lo emite como UTC ISO ("2026-05-29T00:00:00.000Z"), y el browser en Argentina
 * (UTC-3) lo muestra como 28/05/26 — un día antes del que el usuario cargó.
 *
 * Fix global: `pg.types.setTypeParser(builtins.DATE, val => val)` en
 * config/database.js. Este test es la red de seguridad.
 *
 * Probamos con un movimiento de tarjeta porque la pantalla "Estado de cuenta"
 * fue donde se descubrió el bug, pero la propiedad aplica a cualquier columna
 * DATE del schema.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, cajaArs, tarjeta;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  cajaArs = (await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja TZ', moneda: 'ARS', saldo_inicial: 0 })).body.id;
  tarjeta = (await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'TC TZ', moneda: 'ARS', es_tarjeta: true, comision_pct: 10 })).body.id;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('DATE columns: timezone-safe (vuelven como string YYYY-MM-DD)', () => {
  it('cobro previo guardado con fecha 2026-05-29 vuelve EXACTAMENTE como "2026-05-29"', async () => {
    const create = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjeta, fecha: '2026-05-29', monto_bruto: 1000, pct: 10 });
    expect(create.status).toBe(201);
    // Sin el fix global, esto vendría como "2026-05-29T00:00:00.000Z" (UTC ISO).
    // Con el fix, es la string cruda de la columna DATE.
    expect(create.body.fecha).toBe('2026-05-29');

    // Estado de cuenta (paginado, con metodo_nombre) tampoco corrompe la fecha.
    const ec = await request(app).get('/api/tarjetas/movimientos').set(auth());
    const row = ec.body.data.find(m => m.id === create.body.id);
    expect(row).toBeTruthy();
    expect(row.fecha).toBe('2026-05-29');
  });

  it('liquidación guardada con fecha 2026-06-01 vuelve como "2026-06-01"', async () => {
    // Necesitamos saldo para liquidar.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjeta, fecha: '2026-06-01', monto_bruto: 5000, pct: 0 });
    const liq = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjeta, fecha: '2026-06-01', monto: 3000, caja_id: cajaArs });
    expect(liq.status).toBe(201);
    expect(liq.body.fecha).toBe('2026-06-01');
  });
});
