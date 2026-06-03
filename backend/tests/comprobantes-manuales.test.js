/**
 * Tests de integración — Comprobantes manuales (venta previa al sistema).
 *
 * Réplica del modelo "cobro previo" de Tarjetas: el operador carga manualmente
 * comprobantes con venta_id=NULL para ventas históricas donde el cliente pagó
 * con la caja Financiera, sin necesidad de re-cargar la venta entera.
 *
 * Cubre:
 *   POST   /api/comprobantes/manuales         — crear con cálculo server-side
 *   PATCH  /api/comprobantes/manuales/:id     — editar manual (no autogenerados)
 *   DELETE /api/comprobantes/:id              — solo manuales (venta_id IS NULL)
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
  // Setear pct_financiera para que el fallback sea conocido en los tests.
  await request(app).put('/api/config').set(auth()).send({ pct_financiera: 5 });
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Comprobantes manuales — venta previa al sistema', () => {
  it('POST /comprobantes/manuales crea con venta_id=NULL y calcula comisión + neto', async () => {
    const r = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-01-05', cliente: 'Cliente Previo', monto_bruto: 100000, pct: 3 });
    expect(r.status).toBe(201);
    expect(r.body.venta_id).toBeNull();
    expect(Number(r.body.monto)).toBe(100000);
    expect(Number(r.body.monto_financiera)).toBe(3000); // 3% de 100k
    expect(Number(r.body.monto_neto)).toBe(97000);
  });

  it('pct omitido → usa pct_financiera de config (5%)', async () => {
    const r = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-01-06', cliente: 'Cliente Fallback', monto_bruto: 1000 });
    expect(r.status).toBe(201);
    expect(Number(r.body.monto_financiera)).toBe(50); // 5% de 1000
    expect(Number(r.body.monto_neto)).toBe(950);
  });

  it('PATCH /manuales/:id recalcula montos y permite cambiar cliente', async () => {
    const c = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-01-07', cliente: 'Cliente Edit', monto_bruto: 1000, pct: 10 });
    expect(Number(c.body.monto_neto)).toBe(900);

    const r = await request(app).patch(`/api/comprobantes/manuales/${c.body.id}`).set(auth())
      .send({ monto_bruto: 2000, pct: 15, cliente: 'Cliente Actualizado' });
    expect(r.status).toBe(200);
    expect(r.body.cliente).toBe('Cliente Actualizado');
    expect(Number(r.body.monto)).toBe(2000);
    expect(Number(r.body.monto_financiera)).toBe(300); // 15% de 2000
    expect(Number(r.body.monto_neto)).toBe(1700);
  });

  it('PATCH parcial: solo cliente (recalcula con pct del config sobre bruto existente)', async () => {
    const c = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-01-08', cliente: 'Original', monto_bruto: 500, pct: 5 });
    const r = await request(app).patch(`/api/comprobantes/manuales/${c.body.id}`).set(auth())
      .send({ cliente: 'Renombrado' });
    expect(r.status).toBe(200);
    expect(r.body.cliente).toBe('Renombrado');
    expect(Number(r.body.monto)).toBe(500);
    expect(Number(r.body.monto_neto)).toBe(475); // 500 * (1 - 5%)
  });

  it('PATCH con body vacío {} → 400 (refine "al menos un campo")', async () => {
    const c = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-01-09', cliente: 'X', monto_bruto: 100, pct: 0 });
    const r = await request(app).patch(`/api/comprobantes/manuales/${c.body.id}`).set(auth()).send({});
    expect(r.status).toBe(400);
  });

  it('DELETE comprobante manual (venta_id IS NULL) → 200', async () => {
    const c = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-01-09', cliente: 'A borrar', monto_bruto: 100, pct: 0 });
    const del = await request(app).delete(`/api/comprobantes/${c.body.id}`).set(auth());
    expect(del.status).toBe(200);
  });

  it('PATCH /manuales/:id rechaza si el comprobante proviene de una venta', async () => {
    // Crear una venta minimal para tener un venta_id válido (FK requiere existencia).
    const { rows: v } = await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, tc_venta)
       VALUES ('TEST-V1', '2026-01-10', 'V Auto', 'acreditado', 100, 1) RETURNING id`
    );
    const { rows } = await pool.query(
      `INSERT INTO comprobantes (fecha, cliente, monto, monto_financiera, monto_neto, venta_id)
       VALUES ('2026-01-10', 'Auto', 5000, 250, 4750, $1) RETURNING id`, [v[0].id]
    );
    const r = await request(app).patch(`/api/comprobantes/manuales/${rows[0].id}`).set(auth())
      .send({ monto_bruto: 9999 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/venta/i);
    // Cleanup
    await pool.query('DELETE FROM comprobantes WHERE id = $1', [rows[0].id]);
    await pool.query('DELETE FROM ventas WHERE id = $1', [v[0].id]);
  });

  it('DELETE /comprobantes/:id rechaza si venta_id != NULL', async () => {
    const { rows: v } = await pool.query(
      `INSERT INTO ventas (order_id, fecha, cliente_nombre, estado, total_usd, tc_venta)
       VALUES ('TEST-V2', '2026-01-10', 'V Auto 2', 'acreditado', 100, 1) RETURNING id`
    );
    const { rows } = await pool.query(
      `INSERT INTO comprobantes (fecha, cliente, monto, monto_financiera, monto_neto, venta_id)
       VALUES ('2026-01-10', 'Auto 2', 5000, 250, 4750, $1) RETURNING id`, [v[0].id]
    );
    const del = await request(app).delete(`/api/comprobantes/${rows[0].id}`).set(auth());
    expect(del.status).toBe(400);
    expect(del.body.error).toMatch(/venta/i);
    await pool.query('DELETE FROM comprobantes WHERE id = $1', [rows[0].id]);
    await pool.query('DELETE FROM ventas WHERE id = $1', [v[0].id]);
  });

  it('rechaza monto_bruto <= 0', async () => {
    const r = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-01-10', cliente: 'X', monto_bruto: 0 });
    expect(r.status).toBe(400);
  });

  it('rechaza fecha futura', async () => {
    const r = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2099-12-31', cliente: 'X', monto_bruto: 100 });
    expect(r.status).toBe(400);
  });
});
