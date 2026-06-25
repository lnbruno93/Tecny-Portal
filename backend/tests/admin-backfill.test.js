/**
 * Tests de los endpoints admin para disparar el backfill desde la UI.
 *
 * Cubre los wrappers HTTP de scripts/backfill-caja-financiera.js (que ya tiene
 * sus propios tests más exhaustivos en backfill-caja-financiera.test.js).
 * Acá solo verificamos:
 *   · La protección adminOnly funciona (no-admin → 403).
 *   · El dry-run no toca la DB.
 *   · El apply commitea y devuelve resultado estructurado.
 *   · El error "sin caja FV configurada" se traduce en 400.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER, createTestUser } = require('./helpers/setup');

let pool, adminToken;
const auth = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

beforeEach(async () => {
  // Limpiar comprobantes / pagos / caja_movimientos entre tests para aislar.
  await pool.query('TRUNCATE comprobantes, pagos, caja_movimientos RESTART IDENTITY CASCADE');
});

// Seed helper — comprobante histórico SIN caja_movimiento.
async function seedComprobanteHistorico({ fecha, cliente, monto_neto, venta_id = null }) {
  const { rows } = await pool.query(`
    INSERT INTO comprobantes (fecha, cliente, monto, monto_financiera, monto_neto, venta_id)
    VALUES ($1, $2, $3, 0, $3, $4) RETURNING id
  `, [fecha, cliente, monto_neto, venta_id]);
  return rows[0].id;
}

describe('GET /api/admin/backfill-caja-financiera (dry-run)', () => {
  it('devuelve reporte sin tocar la DB', async () => {
    await seedComprobanteHistorico({ fecha: '2026-03-01', cliente: 'Hist 1', monto_neto: 50000 });
    await seedComprobanteHistorico({ fecha: '2026-03-15', cliente: 'Hist 2', monto_neto: 30000 });

    const r = await request(app).get('/api/admin/backfill-caja-financiera').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.apply).toBe(false);
    expect(r.body.comprobantes).toBe(2);
    expect(r.body.pagos).toBe(0);
    expect(r.body.saldoProyectado).toBe(80000);
    expect(r.body.muestras.comprobantes).toHaveLength(2);
    expect(r.body.muestras.comprobantes[0].cliente).toBe('Hist 1');
    expect(r.body.caja.nombre).toBeTruthy();

    // Confirmar que NO se insertaron caja_movimientos.
    const { rows } = await pool.query('SELECT COUNT(*) FROM caja_movimientos');
    expect(parseInt(rows[0].count)).toBe(0);
  });

  it('cuando no hay nada pendiente, skipped=true y los contadores son 0', async () => {
    const r = await request(app).get('/api/admin/backfill-caja-financiera').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.skipped).toBe(true);
    expect(r.body.comprobantes).toBe(0);
    expect(r.body.pagos).toBe(0);
  });

  it('sin caja FV configurada → 400 con mensaje guía', async () => {
    // TANDA 4 trazab: capturar el id ANTES de desmarcar — restaurar por id
    // (no por nombre, que asume el seed) y try/finally garantiza que si una
    // assertion falla, la restore corre igual y no deja la DB sin caja FV.
    const { rows: prev } = await pool.query(
      `SELECT id FROM metodos_pago WHERE es_financiera = true LIMIT 1`
    );
    const fvId = prev[0]?.id;
    await pool.query(`UPDATE metodos_pago SET es_financiera = false WHERE id = $1`, [fvId]);
    try {
      const r = await request(app).get('/api/admin/backfill-caja-financiera').set(auth());
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/es_financiera|Cajas → Config/i);
    } finally {
      await pool.query(`UPDATE metodos_pago SET es_financiera = true WHERE id = $1`, [fvId]);
    }
  });

  it('rechaza usuario sin role=admin → 403', async () => {
    // SEG-2: createTestUser seedea tenant_users + tenant_user_roles.
    const created = await createTestUser(pool, {
      nombre: 'Op', username: 'opbackfill',
      email: 'opbackfill@test.local', password: 'op123',
      role: 'op',
    });
    const opLogin = await request(app).post('/api/auth/login').send({ username: 'opbackfill', password: 'op123' });
    const opToken = opLogin.body.token;

    const r = await request(app).get('/api/admin/backfill-caja-financiera').set({ Authorization: `Bearer ${opToken}` });
    expect(r.status).toBe(403);

    // Cleanup.
    await pool.query('DELETE FROM users WHERE id = $1', [created.id]);
  });

  it('rechaza sin auth → 401', async () => {
    const r = await request(app).get('/api/admin/backfill-caja-financiera');
    expect(r.status).toBe(401);
  });
});

describe('POST /api/admin/backfill-caja-financiera/apply', () => {
  it('inserta los caja_movimientos y devuelve saldo final', async () => {
    await seedComprobanteHistorico({ fecha: '2026-03-01', cliente: 'Hist apply', monto_neto: 25000 });

    const r = await request(app).post('/api/admin/backfill-caja-financiera/apply').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.apply).toBe(true);
    expect(r.body.comprobantes).toBe(1);
    expect(r.body.saldoFinal).toBe(25000);

    // Confirmar que el caja_movimiento existe.
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM caja_movimientos WHERE ref_tabla = 'comprobantes' AND deleted_at IS NULL`
    );
    expect(parseInt(rows[0].count)).toBe(1);
  });

  // B2 audit trail (TANDA 0 trazabilidad): el endpoint admin debe estampar
  // user_id del admin disparador en cada caja_movimiento creado, para trazar
  // quién corrió el backfill. CLI sin endpoint deja null.
  it('B2: estampa req.user.id en user_id de los caja_movimientos del backfill', async () => {
    await seedComprobanteHistorico({ fecha: '2026-03-02', cliente: 'Audit trail', monto_neto: 1000 });
    const r = await request(app).post('/api/admin/backfill-caja-financiera/apply').set(auth());
    expect(r.status).toBe(200);
    // El TEST_USER usado en login es admin (id=1 según el seed).
    const { rows } = await pool.query(
      `SELECT user_id FROM caja_movimientos WHERE ref_tabla = 'comprobantes' AND deleted_at IS NULL`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).not.toBeNull();
  });

  it('correr 2 veces no duplica (idempotente)', async () => {
    await seedComprobanteHistorico({ fecha: '2026-03-01', cliente: 'Idem', monto_neto: 10000 });
    await request(app).post('/api/admin/backfill-caja-financiera/apply').set(auth());
    const r2 = await request(app).post('/api/admin/backfill-caja-financiera/apply').set(auth());
    expect(r2.status).toBe(200);
    expect(r2.body.skipped).toBe(true);
  });
});
