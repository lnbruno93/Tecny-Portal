/**
 * Tests de Conciliación bancaria.
 *
 * Cubre el flow end-to-end:
 *  - POST crea conciliación + auto-match
 *  - PUT actualiza match manual
 *  - POST cerrar marca caja_movimientos
 *  - DELETE libera los movimientos
 * Más casos de borde: caja inexistente, fecha fuera de rango, monto fuera
 * de tolerancia, match duplicado, conciliación cerrada inmutable, etc.
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, cajaId;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;

  const k = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Concil USD', moneda: 'USD', saldo_inicial: 0 });
  cajaId = k.body.id;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Conciliación: flow end-to-end', () => {
  let movId1, movId2, concId;

  beforeAll(async () => {
    // Sembrar 2 movimientos de caja directos.
    const { rows } = await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, concepto)
       VALUES
         ($1, '2026-04-05', 'ingreso', 500, 500, 'venta', 'Venta #100'),
         ($1, '2026-04-10', 'egreso',  200, 200, 'egreso', 'Gasto luz')
       RETURNING id`,
      [cajaId]
    );
    movId1 = rows[0].id; // ingreso 500 (matchea con línea +500)
    movId2 = rows[1].id; // egreso  200 (matchea con línea -200)
  });

  it('POST /api/conciliacion crea + auto-match las 2 líneas', async () => {
    const res = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: cajaId,
      fecha_desde: '2026-04-01',
      fecha_hasta: '2026-04-30',
      archivo_nombre: 'test.csv',
      tolerancia_dias: 2,
      lineas: [
        { fecha: '2026-04-05', monto: 500,  descripcion: 'transferencia recibida' },
        { fecha: '2026-04-10', monto: -200, descripcion: 'pago servicio' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.lineas_total).toBe(2);
    expect(res.body.lineas_matched).toBe(2);
    expect(res.body.lineas_pendientes).toBe(0);
    concId = res.body.id;
  });

  it('GET /api/conciliacion/:id devuelve líneas + movs disponibles', async () => {
    const res = await request(app).get(`/api/conciliacion/${concId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.lineas).toHaveLength(2);
    expect(res.body.lineas[0].matched_caja_mov_id).toBe(movId1);
    expect(res.body.lineas[1].matched_caja_mov_id).toBe(movId2);
    expect(Array.isArray(res.body.movimientos_disponibles)).toBe(true);
  });

  it('PUT línea con ignorada=true actualiza el flag', async () => {
    const conc = await request(app).get(`/api/conciliacion/${concId}`).set(auth());
    const lid = conc.body.lineas[0].id;
    const res = await request(app)
      .put(`/api/conciliacion/${concId}/lineas/${lid}`).set(auth())
      .send({ ignorada: true, matched_caja_mov_id: null });
    expect(res.status).toBe(200);
    expect(res.body.ignorada).toBe(true);
    expect(res.body.matched_caja_mov_id).toBeNull();
  });

  it('PUT línea con match a otro mov: si ese mov ya está matched a otra línea → 409', async () => {
    const conc = await request(app).get(`/api/conciliacion/${concId}`).set(auth());
    // Línea 1 (ahora ignorada, mov libre), línea 2 (matcheada con movId2).
    // Intento volver a matchear línea 1 con movId2 → debería rechazar.
    const linea1Id = conc.body.lineas[0].id;
    const res = await request(app)
      .put(`/api/conciliacion/${concId}/lineas/${linea1Id}`).set(auth())
      .send({ matched_caja_mov_id: movId2 });
    expect(res.status).toBe(409);
  });

  it('POST cerrar marca conciliado_en + conciliacion_id en cada matched', async () => {
    const res = await request(app).post(`/api/conciliacion/${concId}/cerrar`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.cerrado_en).toBeTruthy();
    // El movId2 estaba matched, debe estar cerrado.
    const { rows } = await pool.query(
      'SELECT conciliado_en, conciliacion_id FROM caja_movimientos WHERE id = $1',
      [movId2]
    );
    expect(rows[0].conciliado_en).toBeTruthy();
    expect(rows[0].conciliacion_id).toBe(concId);
  });

  it('No se puede editar una conciliación cerrada (409)', async () => {
    const conc = await request(app).get(`/api/conciliacion/${concId}`).set(auth());
    const lid = conc.body.lineas[0].id;
    const res = await request(app)
      .put(`/api/conciliacion/${concId}/lineas/${lid}`).set(auth())
      .send({ nota: 'tarde para esto' });
    expect(res.status).toBe(409);
  });

  it('DELETE libera los movimientos conciliados', async () => {
    const del = await request(app).delete(`/api/conciliacion/${concId}`).set(auth());
    expect(del.status).toBe(200);
    const { rows } = await pool.query(
      'SELECT conciliado_en, conciliacion_id FROM caja_movimientos WHERE id = $1',
      [movId2]
    );
    expect(rows[0].conciliado_en).toBeNull();
    expect(rows[0].conciliacion_id).toBeNull();
  });
});

describe('Conciliación: casos de borde', () => {
  it('caja inexistente → 400', async () => {
    const res = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: 999999,
      fecha_desde: '2026-04-01', fecha_hasta: '2026-04-30',
      lineas: [{ fecha: '2026-04-05', monto: 100, descripcion: 'x' }],
    });
    expect(res.status).toBe(400);
  });

  it('fecha_desde > fecha_hasta → 400 por schema refine', async () => {
    const res = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: cajaId,
      fecha_desde: '2026-05-30', fecha_hasta: '2026-05-01',
      lineas: [{ fecha: '2026-05-05', monto: 100 }],
    });
    expect(res.status).toBe(400);
  });

  it('lineas vacío → 400', async () => {
    const res = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: cajaId,
      fecha_desde: '2026-05-01', fecha_hasta: '2026-05-31',
      lineas: [],
    });
    expect(res.status).toBe(400);
  });

  it('línea con monto 0 → 400 por schema (monto debe ser > 0)', async () => {
    const res = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: cajaId,
      fecha_desde: '2026-05-01', fecha_hasta: '2026-05-31',
      lineas: [{ fecha: '2026-05-05', monto: 0 }],
    });
    expect(res.status).toBe(400);
  });

  it('GET listado paginado', async () => {
    const res = await request(app).get('/api/conciliacion?limit=10').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeTruthy();
  });

  it('auto-match respeta tolerancia: fecha 5 días aparte → no matchea con tolerancia 2', async () => {
    // Mov: ingreso 999 al 2026-06-01
    const { rows } = await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, concepto)
       VALUES ($1, '2026-06-01', 'ingreso', 999, 999, 'venta', 'Test') RETURNING id`,
      [cajaId]
    );
    const movId = rows[0].id;
    // Línea con fecha 2026-06-10 (9 días aparte) → fuera de tolerancia.
    const res = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: cajaId,
      fecha_desde: '2026-06-01', fecha_hasta: '2026-06-30',
      tolerancia_dias: 2,
      lineas: [{ fecha: '2026-06-10', monto: 999, descripcion: 'Lejos' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.lineas_matched).toBe(0);

    // Cleanup
    await pool.query('DELETE FROM caja_movimientos WHERE id = $1', [movId]);
  });
});
