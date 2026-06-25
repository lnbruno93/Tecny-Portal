/**
 * Tests de integración — PUT /api/config con recalc retroactivo de comprobantes.
 *
 * Reportado por primer cliente real (iDeals Ar tenant=12, 2026-06-25):
 *   1. Owner configuró pct_financiera = 3% en Config
 *   2. Cargó una venta con cobro financiero + archivo de comprobante
 *   3. En la sección Comprobantes, monto_financiera mostraba 0 (no se descontó)
 *
 * Root cause confirmado en prod (SELECT * FROM config WHERE tenant_id=12 → 0 filas):
 *   · signup no sembraba fila en `config` para tenants nuevos
 *   · PUT /api/config confiaba en DEFAULT dinámico de tenant_id (que falló silently)
 *   · `syncFinancieraComprobante` lee `SELECT pct_financiera FROM config LIMIT 1` →
 *     0 filas → cae al `|| 0` → cálculo congelado en 0
 *
 * Este test cubre el camino feliz post-fix:
 *   · Owner edita pct_financiera en Config
 *   · El INSERT del backend usa tenant_id explícito (no DEFAULT)
 *   · monto_financiera y monto_neto de comprobantes existentes se recalculan
 *     con el nuevo % (recalc retroactivo — lo que el owner espera intuitivamente)
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe('PUT /api/config — recalc retroactivo (Bug #2 primer cliente real)', () => {
  beforeEach(async () => {
    // Resetear comprobantes para cada test (los tests anteriores pueden haber dejado
    // filas con valores distintos). Hacemos soft-delete porque el helper solo toca
    // filas activas — los soft-deleted no se cuentan.
    await pool.query(`UPDATE comprobantes SET deleted_at = NOW() WHERE deleted_at IS NULL`);
  });

  it('cambiar pct_financiera recalcula monto_financiera y monto_neto de comprobantes activos', async () => {
    // Setup: pct viejo = 0, comprobante con monto_financiera congelado en 0.
    await request(app).put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ pct_financiera: 0 });

    const created = await request(app).post('/api/comprobantes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha: '2026-06-25',
        cliente: 'Cliente Test',
        monto: 100000,
        monto_financiera: 0,    // congelado en 0 (caso real del cliente iDeals Ar)
        monto_neto: 100000,
      });
    expect(created.status).toBe(201);
    const compId = created.body.id;

    // Acción: owner sube pct a 5%
    const put = await request(app).put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ pct_financiera: 5 });
    expect(put.status).toBe(200);
    expect(Number(put.body.pct_financiera)).toBe(5);

    // Aserción: el comprobante existente se recalculó retroactivamente.
    //   monto_financiera = 100000 * 0.05 = 5000
    //   monto_neto = 100000 - 5000 = 95000
    const { rows } = await pool.query(
      'SELECT monto, monto_financiera, monto_neto FROM comprobantes WHERE id = $1',
      [compId]
    );
    expect(Number(rows[0].monto)).toBe(100000);
    expect(Number(rows[0].monto_financiera)).toBe(5000);
    expect(Number(rows[0].monto_neto)).toBe(95000);
  });

  it('cambiar pct a 3% recalcula correctamente — caso exacto reportado (monto 355000)', async () => {
    // Mismo escenario que el cliente iDeals Ar tenant=12 reportó.
    await request(app).put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ pct_financiera: 0 });

    const created = await request(app).post('/api/comprobantes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha: '2026-06-25',
        cliente: 'iDeals Test',
        monto: 355000,
        monto_financiera: 0,
        monto_neto: 355000,
      });
    const compId = created.body.id;

    await request(app).put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ pct_financiera: 3 });

    const { rows } = await pool.query(
      'SELECT monto_financiera, monto_neto FROM comprobantes WHERE id = $1',
      [compId]
    );
    // 355000 * 0.03 = 10650
    // 355000 - 10650 = 344350
    expect(Number(rows[0].monto_financiera)).toBe(10650);
    expect(Number(rows[0].monto_neto)).toBe(344350);
  });

  it('recalc idempotente — re-PUT con el mismo % no cambia valores', async () => {
    await request(app).put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ pct_financiera: 4 });

    const created = await request(app).post('/api/comprobantes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fecha: '2026-06-25',
        cliente: 'Idemp Test',
        monto: 50000,
        monto_financiera: 2000,
        monto_neto: 48000,
      });
    const compId = created.body.id;

    // Re-PUT con mismo 4%
    await request(app).put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ pct_financiera: 4 });

    const { rows } = await pool.query(
      'SELECT monto_financiera, monto_neto FROM comprobantes WHERE id = $1',
      [compId]
    );
    expect(Number(rows[0].monto_financiera)).toBe(2000);
    expect(Number(rows[0].monto_neto)).toBe(48000);
  });

  it('recalc NO toca comprobantes soft-deleted', async () => {
    await request(app).put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ pct_financiera: 2 });

    // Crear 2 comprobantes y soft-deletear uno
    const c1 = await request(app).post('/api/comprobantes')
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-06-25', cliente: 'Activo', monto: 10000, monto_financiera: 200, monto_neto: 9800 });
    const c2 = await request(app).post('/api/comprobantes')
      .set('Authorization', `Bearer ${token}`)
      .send({ fecha: '2026-06-25', cliente: 'Borrado', monto: 10000, monto_financiera: 200, monto_neto: 9800 });

    await pool.query(`UPDATE comprobantes SET deleted_at = NOW() WHERE id = $1`, [c2.body.id]);

    // Cambiar pct a 10%
    await request(app).put('/api/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ pct_financiera: 10 });

    const { rows: r1 } = await pool.query('SELECT monto_financiera, monto_neto FROM comprobantes WHERE id = $1', [c1.body.id]);
    const { rows: r2 } = await pool.query('SELECT monto_financiera, monto_neto FROM comprobantes WHERE id = $1', [c2.body.id]);

    // Activo: recalculado a 10%
    expect(Number(r1[0].monto_financiera)).toBe(1000);
    expect(Number(r1[0].monto_neto)).toBe(9000);

    // Borrado: queda con los valores viejos (2%)
    expect(Number(r2[0].monto_financiera)).toBe(200);
    expect(Number(r2[0].monto_neto)).toBe(9800);
  });
});
