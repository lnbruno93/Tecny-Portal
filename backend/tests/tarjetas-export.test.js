/**
 * Tests del endpoint nuevo GET /api/tarjetas/movimientos/totales — agregados
 * por moneda para el header del export PDF/XLSX (no existía endpoint paralelo
 * de /totales en Tarjetas como sí en Comprobantes).
 *
 * También cubre el nuevo cap de limit=5000 en /movimientos (lección aprendida
 * del hotfix de Comprobantes: el listado UI tope 500 pero el export pide 5000).
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

  // Marcar una caja existente como tarjeta (es_tarjeta=true) para tener sobre
  // qué cargar movimientos sin tener que crear el método desde cero.
  await pool.query(`
    UPDATE metodos_pago
       SET es_tarjeta = true, comision_pct = 5.0
     WHERE nombre = 'Pesos Ars | BBVA GL'
  `);
  // Cobros + liquidación en mayo, y un movimiento en USD en junio para
  // verificar el breakdown por moneda.
  const { rows: tarj } = await pool.query(`SELECT id FROM metodos_pago WHERE nombre = 'Pesos Ars | BBVA GL'`);
  const { rows: caja } = await pool.query(`SELECT id FROM metodos_pago WHERE nombre = 'Pesos Ars | Efectivo'`);
  const tarjId = tarj[0].id;
  const cajaId = caja[0].id;
  // Cobros ARS en mayo
  await pool.query(`
    INSERT INTO tarjeta_movimientos (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, caja_id, user_id)
    VALUES
      ($1, '2026-05-10', 'cobro',       'ARS', 100000, 5, 5000, 95000, NULL, 1),
      ($1, '2026-05-15', 'cobro',       'ARS', 200000, 5, 10000, 190000, NULL, 1),
      ($1, '2026-05-25', 'liquidacion', 'ARS', 50000, 0, 0, 50000, $2, 1)
  `, [tarjId, cajaId]);
  // Cobro USD en junio (para el breakdown por moneda)
  await pool.query(`
    INSERT INTO tarjeta_movimientos (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, caja_id, user_id)
    VALUES ($1, '2026-06-05', 'cobro', 'USD', 1000, 5, 50, 950, NULL, 1)
  `, [tarjId]);
});

afterAll(async () => { await teardownTestDb(pool); });

describe('GET /api/tarjetas/movimientos/totales', () => {
  it('sin filtro devuelve agregados de TODOS los movimientos, agrupados por moneda', async () => {
    const r = await request(app).get('/api/tarjetas/movimientos/totales').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(4);                  // 3 ARS + 1 USD
    expect(r.body.ARS.cobros_count).toBe(2);
    expect(r.body.ARS.cobros_bruto).toBe(300000);
    expect(r.body.ARS.comision).toBe(15000);
    expect(r.body.ARS.cobros_neto).toBe(285000);
    expect(r.body.ARS.liquidaciones_count).toBe(1);
    expect(r.body.ARS.liquidado).toBe(50000);
    expect(r.body.ARS.saldo_periodo).toBe(235000); // 285000 − 50000
    expect(r.body.USD.cobros_count).toBe(1);
    expect(r.body.USD.cobros_bruto).toBe(1000);
    expect(r.body.USD.saldo_periodo).toBe(950);
    // USDT no tiene movimientos — todo en cero.
    expect(r.body.USDT.total_count).toBe(0);
  });

  it('filtro desde=2026-05-01&hasta=2026-05-31 → solo movimientos ARS de mayo', async () => {
    const r = await request(app).get('/api/tarjetas/movimientos/totales?desde=2026-05-01&hasta=2026-05-31').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(3);
    expect(r.body.ARS.cobros_count).toBe(2);
    expect(r.body.USD.total_count).toBe(0); // junio queda fuera
  });

  it('filtro desde=2026-06-01 → solo el cobro USD', async () => {
    const r = await request(app).get('/api/tarjetas/movimientos/totales?desde=2026-06-01').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    expect(r.body.ARS.total_count).toBe(0);
    expect(r.body.USD.cobros_count).toBe(1);
  });

  it('sin auth → 401', async () => {
    const r = await request(app).get('/api/tarjetas/movimientos/totales');
    expect(r.status).toBe(401);
  });
});

// El cap de limit subió de 200 a 5000 — la UI sigue pidiendo 500 pero el
// export pide hasta 5000 para incluir TODO el período en el PDF/XLSX.
describe('GET /api/tarjetas/movimientos — cap de limit para exports', () => {
  it('limit=5000 → 200 (acepta el tope del export)', async () => {
    const r = await request(app).get('/api/tarjetas/movimientos?limit=5000').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.data).toBeDefined();
  });

  it('limit=10000 (sobre el cap) → silently capped a 5000 (parsePagination clamp)', async () => {
    // parsePagination clampea sin error — verificamos que devuelve OK + el
    // pagination.limit refleja el cap real.
    const r = await request(app).get('/api/tarjetas/movimientos?limit=10000').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.pagination.limit).toBe(5000);
  });
});
