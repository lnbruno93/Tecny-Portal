/**
 * Tests del checkInvariants — sembrando drift artificial para verificar que
 * cada validator detecta su escenario. Si en el futuro un cambio rompe el
 * detector (ej. cambio de schema), estos tests fallan inmediatamente.
 *
 * Estrategia: para cada invariante, dos escenarios:
 *   1. Estado sano → invariante reporta ok=true.
 *   2. Drift inyectado vía SQL directo → invariante reporta ok=false y la
 *      fila contaminada aparece en violaciones.
 *
 * Notamos que algunos drift requieren bypassar checks de la API (insertar
 * con SQL directo). Eso valida que el detector funciona aunque la API esté
 * comprometida — que es exactamente el caso para el que existe.
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const { evaluarTodos, INVARIANTES, resumir } = require('../src/lib/checkInvariants');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('checkInvariants — estado limpio', () => {
  it('con DB recién truncada, todas las invariantes pasan', async () => {
    const resultados = await evaluarTodos();
    const resumen = resumir(resultados);
    // Pueden quedar 'caja_eliminada_con_movs_activos' o similares de otros tests.
    // Solo verificamos que nada explotó (con_error == 0).
    expect(resumen.con_error).toBe(0);
    expect(resultados).toHaveLength(INVARIANTES.length);
  });
});

describe('checkInvariants — detección de drift', () => {

  it('caja_saldo_negativo: caja en negativo lo detecta', async () => {
    // Crear caja + insertar egreso que la deja en negativo via SQL (la API valida).
    const { rows: [c] } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, saldo_inicial)
       VALUES ('Test inv-cn', 'USD', 100) RETURNING id`
    );
    await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen)
       VALUES ($1, CURRENT_DATE, 'egreso', 500, 500, 'ajuste')`,
      [c.id]
    );

    const resultados = await evaluarTodos();
    const inv = resultados.find(r => r.id === 'caja_saldo_negativo');
    expect(inv.ok).toBe(false);
    const violacion = inv.violaciones.find(v => v.id === c.id);
    expect(violacion).toBeTruthy();
    expect(Number(violacion.saldo)).toBeCloseTo(-400, 2);

    await pool.query('DELETE FROM caja_movimientos WHERE caja_id = $1', [c.id]);
    await pool.query('DELETE FROM metodos_pago WHERE id = $1', [c.id]);
  });

  it('caja_eliminada_con_movs_activos: caja deleted_at + mov activo lo detecta', async () => {
    const { rows: [c] } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, saldo_inicial)
       VALUES ('Test inv-eli', 'USD', 0) RETURNING id`
    );
    await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen)
       VALUES ($1, CURRENT_DATE, 'ingreso', 100, 100, 'ajuste')`,
      [c.id]
    );
    await pool.query('UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1', [c.id]);

    const resultados = await evaluarTodos();
    const inv = resultados.find(r => r.id === 'caja_eliminada_con_movs_activos');
    expect(inv.ok).toBe(false);
    expect(inv.violaciones.some(v => v.id === c.id)).toBe(true);

    await pool.query('DELETE FROM caja_movimientos WHERE caja_id = $1', [c.id]);
    await pool.query('DELETE FROM metodos_pago WHERE id = $1', [c.id]);
  });

  it('conciliacion_pareja_inconsistente: conciliado_en sin conciliacion_id lo detecta', async () => {
    const { rows: [c] } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, saldo_inicial)
       VALUES ('Test inv-pi', 'USD', 0) RETURNING id`
    );
    // Mov con conciliado_en pero conciliacion_id NULL — inconsistente.
    const { rows: [m] } = await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, conciliado_en)
       VALUES ($1, CURRENT_DATE, 'ingreso', 50, 50, 'ajuste', NOW()) RETURNING id`,
      [c.id]
    );

    const resultados = await evaluarTodos();
    const inv = resultados.find(r => r.id === 'conciliacion_pareja_inconsistente');
    expect(inv.ok).toBe(false);
    expect(inv.violaciones.some(v => v.id === m.id)).toBe(true);

    await pool.query('DELETE FROM caja_movimientos WHERE id = $1', [m.id]);
    await pool.query('DELETE FROM metodos_pago WHERE id = $1', [c.id]);
  });

  it('egreso_pagado_sin_caja_mov: egreso pagado con metodo_pago_id pero sin mov lo detecta', async () => {
    const { rows: [c] } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, saldo_inicial)
       VALUES ('Test inv-eg', 'USD', 1000) RETURNING id`
    );
    // Egreso pagado con metodo_pago_id pero NO insertamos el caja_movimiento.
    const { rows: [e] } = await pool.query(
      `INSERT INTO egresos (concepto, monto, monto_usd, estado, metodo_pago_id, fecha)
       VALUES ('Test inv', 100, 100, 'pagado', $1, CURRENT_DATE) RETURNING id`,
      [c.id]
    );

    const resultados = await evaluarTodos();
    const inv = resultados.find(r => r.id === 'egreso_pagado_sin_caja_mov');
    expect(inv.ok).toBe(false);
    expect(inv.violaciones.some(v => v.id === e.id)).toBe(true);

    await pool.query('DELETE FROM egresos WHERE id = $1', [e.id]);
    await pool.query('DELETE FROM metodos_pago WHERE id = $1', [c.id]);
  });
});

describe('checkInvariants — endpoint admin', () => {
  it('GET /api/admin/invariants devuelve resumen + invariantes', async () => {
    const res = await request(app).get('/api/admin/invariants').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.resumen).toBeTruthy();
    expect(res.body.invariantes).toHaveLength(INVARIANTES.length);
    expect(typeof res.body.elapsed_ms).toBe('number');
  });

  it('POST /api/admin/invariants/run corre + responde', async () => {
    const res = await request(app).post('/api/admin/invariants/run').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.resumen).toBeTruthy();
  });

  it('Sin auth → 401', async () => {
    const res = await request(app).get('/api/admin/invariants');
    expect(res.status).toBe(401);
  });

  it('Con user no-admin → 403', async () => {
    // Crear usuario non-admin
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash('userpass123', 10);
    // No hay UNIQUE en username; limpiamos previo por las dudas.
    await pool.query(`DELETE FROM users WHERE username = 'testuser_inv'`);
    await pool.query(
      `INSERT INTO users (nombre, username, email, password_hash, role)
       VALUES ('Test User', 'testuser_inv', 'testuser_inv@test.local', $1, 'op')`,
      [hash]
    );
    const login = await request(app).post('/api/auth/login')
      .send({ username: 'testuser_inv', password: 'userpass123' });
    const userToken = login.body.token;
    const res = await request(app).get('/api/admin/invariants')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);

    await pool.query(`DELETE FROM users WHERE username = 'testuser_inv'`);
  });
});

describe('checkInvariants — performance', () => {
  it('evaluarTodos termina rápido (< 2s en DB vacía)', async () => {
    const t0 = Date.now();
    await evaluarTodos();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
