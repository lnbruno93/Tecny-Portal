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
  // Crear cajas con assert explícito: si POST /cajas falla (409 por nombre duplicado
  // de una corrida anterior que no limpió, o cualquier 4xx/5xx), `body.id` queda
  // undefined y los tests fallan después con un 400 críptico ("metodo_pago_id" inválido
  // o caja_id faltante en /liquidaciones). Detectarlo acá da un error inmediato
  // y debuggeable en vez de una flake silenciosa downstream.
  const cajaRes = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'Caja TZ', moneda: 'ARS', saldo_inicial: 0 });
  if (cajaRes.status !== 201) throw new Error(`setup: POST /cajas Caja TZ devolvió ${cajaRes.status} ${JSON.stringify(cajaRes.body)}`);
  cajaArs = cajaRes.body.id;
  const tarjetaRes = await request(app).post('/api/cajas/cajas').set(auth()).send({ nombre: 'TC TZ', moneda: 'ARS', es_tarjeta: true, comision_pct: 10 });
  if (tarjetaRes.status !== 201) throw new Error(`setup: POST /cajas TC TZ devolvió ${tarjetaRes.status} ${JSON.stringify(tarjetaRes.body)}`);
  tarjeta = tarjetaRes.body.id;
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

  // Tests TANDA 2 post-auditoría: el fix de TZ es global (setTypeParser en
  // database.js), no solo tarjetas. Si alguien re-introduce un new Date() en
  // ventas/cuentas/cajas, estos tests lo atrapan.

  it('venta guardada con fecha 2026-05-29 vuelve como "2026-05-29"', async () => {
    const venta = await request(app).post('/api/ventas').set(auth()).send({
      fecha: '2026-05-29', cliente_nombre: 'TZ Test', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'X', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: cajaArs, metodo_nombre: 'Caja TZ', monto: 100, moneda: 'ARS', tc: 1000 }],
    });
    expect(venta.status).toBe(201);
    // GET back para confirmar que la API no convirtió la fecha.
    const list = await request(app).get(`/api/ventas?desde=2026-05-29&hasta=2026-05-29`).set(auth());
    const v = (list.body.data || []).find(x => x.id === venta.body.id);
    expect(v).toBeTruthy();
    expect(v.fecha).toBe('2026-05-29');
  });

  // Nota: el fix es un setTypeParser global aplicado al pool en database.js.
  // Cubrir tarjetas (cobro/liquidación) + venta como módulos representativos
  // alcanza para detectar regresiones — si alguien revertiera el setTypeParser
  // o introdujera un módulo que rompe el invariante, estos tests fallan.
});
