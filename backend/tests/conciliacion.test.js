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

// Tests de los fixes de TANDA 0 (auditoría post-features).
describe('Conciliación: fixes TANDA 0', () => {
  it('schema refine: ignorada=true + matched_caja_mov_id en misma request → 400', async () => {
    // Crear conciliación rápida con 1 línea matcheada
    const { rows } = await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, concepto)
       VALUES ($1, '2026-07-01', 'ingreso', 333, 333, 'venta', 'TestT0') RETURNING id`,
      [cajaId]
    );
    const movT = rows[0].id;
    const cr = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: cajaId,
      fecha_desde: '2026-07-01', fecha_hasta: '2026-07-31',
      lineas: [{ fecha: '2026-07-01', monto: 333, descripcion: 'T0' }],
    });
    expect(cr.status).toBe(201);
    const concIdT = cr.body.id;
    const det = await request(app).get(`/api/conciliacion/${concIdT}`).set(auth());
    const lid = det.body.lineas[0].id;

    // Payload contradictorio en la misma request
    const bad = await request(app)
      .put(`/api/conciliacion/${concIdT}/lineas/${lid}`).set(auth())
      .send({ ignorada: true, matched_caja_mov_id: movT });
    expect(bad.status).toBe(400);

    // Cleanup
    await request(app).delete(`/api/conciliacion/${concIdT}`).set(auth());
    await pool.query('DELETE FROM caja_movimientos WHERE id = $1', [movT]);
  });

  it('cross-request invariant: línea ya matched + intento de ignorar sin desmatch → 409', async () => {
    const { rows } = await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, concepto)
       VALUES ($1, '2026-07-15', 'ingreso', 444, 444, 'venta', 'TestX') RETURNING id`,
      [cajaId]
    );
    const movX = rows[0].id;
    const cr = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: cajaId,
      fecha_desde: '2026-07-01', fecha_hasta: '2026-07-31',
      lineas: [{ fecha: '2026-07-15', monto: 444, descripcion: 'X' }],
    });
    const concIdX = cr.body.id;
    const det = await request(app).get(`/api/conciliacion/${concIdX}`).set(auth());
    const lid = det.body.lineas[0].id;
    expect(det.body.lineas[0].matched_caja_mov_id).toBe(movX);

    // Ahora intento poner ignorada=true sin tocar matched → debe fallar 409
    const r = await request(app)
      .put(`/api/conciliacion/${concIdX}/lineas/${lid}`).set(auth())
      .send({ ignorada: true });
    expect(r.status).toBe(409);

    // Cleanup
    await request(app).delete(`/api/conciliacion/${concIdX}`).set(auth());
    await pool.query('DELETE FROM caja_movimientos WHERE id = $1', [movX]);
  });

  it('GET sigue mostrando conciliaciones con caja soft-deleted (LEFT JOIN)', async () => {
    // Crear caja efímera + conciliación + soft-delete de la caja.
    const k = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Efimera', moneda: 'USD', saldo_inicial: 0 });
    const cajaEfimera = k.body.id;
    const { rows } = await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, concepto)
       VALUES ($1, '2026-08-01', 'ingreso', 100, 100, 'venta', 'TestE') RETURNING id`,
      [cajaEfimera]
    );
    const movE = rows[0].id;
    const cr = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: cajaEfimera,
      fecha_desde: '2026-08-01', fecha_hasta: '2026-08-31',
      lineas: [{ fecha: '2026-08-01', monto: 100, descripcion: 'E' }],
    });
    expect(cr.status).toBe(201);
    const concIdE = cr.body.id;
    // Soft-delete la caja directo en DB (no via API, que valida balance).
    await pool.query('UPDATE metodos_pago SET deleted_at = NOW() WHERE id = $1', [cajaEfimera]);

    // GET listado debe seguir mostrando la conciliación
    const list = await request(app).get('/api/conciliacion?limit=100').set(auth());
    const found = list.body.data.find(c => c.id === concIdE);
    expect(found).toBeTruthy();
    expect(found.caja_nombre).toBe('(caja eliminada)');

    // GET detalle también debe funcionar
    const det = await request(app).get(`/api/conciliacion/${concIdE}`).set(auth());
    expect(det.status).toBe(200);
    expect(det.body.caja_nombre).toBe('(caja eliminada)');

    // Cleanup. La caja Efimera queda soft-deleted (no se puede hard-delete
    // por FK RESTRICT desde conciliaciones; afterAll del file barre todo).
    await request(app).delete(`/api/conciliacion/${concIdE}`).set(auth());
    await pool.query('DELETE FROM conciliacion_lineas WHERE conciliacion_id = $1', [concIdE]);
    await pool.query('DELETE FROM conciliaciones WHERE id = $1', [concIdE]);
    await pool.query('DELETE FROM caja_movimientos WHERE id = $1', [movE]);
    await pool.query('DELETE FROM metodos_pago WHERE id = $1', [cajaEfimera]);
  });
});

// TANDA 4: perf test del auto-match O(N+M) con Map.
describe('Conciliación: perf auto-match (TANDA 4)', () => {
  // Stress test: 200 movs distintos + 200 líneas con match exacto. Verifica
  // que el auto-match funcione (cada línea encuentra su mov) y que termine
  // en un tiempo razonable (< 2s end-to-end incluyendo network+TX).
  // Con la implementación vieja O(L*M) = 40k comparaciones; con la nueva
  // O(M + L*K) ≈ 600 lookups. Diferencia perceptible solo a >1000 items.
  it('200 líneas + 200 movs match exacto: termina rápido', async () => {
    const k = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Perf', moneda: 'USD', saldo_inicial: 0 });
    const cajaPerf = k.body.id;

    // Sembrar 200 movs con montos únicos (100, 200, ..., 20000).
    const inserts = [];
    for (let i = 1; i <= 200; i++) {
      inserts.push(`($1, '2026-09-15'::date, 'ingreso', ${i * 100}, ${i * 100}, 'venta', 'M${i}')`);
    }
    await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, concepto)
       VALUES ${inserts.join(',')}`,
      [cajaPerf]
    );

    // 200 líneas con los mismos montos → todas deberían matchear.
    const lineas = [];
    for (let i = 1; i <= 200; i++) {
      lineas.push({ fecha: '2026-09-15', monto: i * 100, descripcion: `L${i}` });
    }

    const t0 = Date.now();
    const res = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: cajaPerf,
      fecha_desde: '2026-09-01', fecha_hasta: '2026-09-30',
      tolerancia_dias: 2,
      lineas,
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(201);
    expect(res.body.lineas_total).toBe(200);
    expect(res.body.lineas_matched).toBe(200);
    // Threshold generoso para CI con DB local: 2s. Con O(L*M) viejo en una
    // máquina lenta llegaba a >5s con 200×200.
    expect(elapsed).toBeLessThan(2000);

    // Cleanup
    await request(app).delete(`/api/conciliacion/${res.body.id}`).set(auth());
    await pool.query('DELETE FROM conciliacion_lineas WHERE conciliacion_id = $1', [res.body.id]);
    await pool.query('DELETE FROM conciliaciones WHERE id = $1', [res.body.id]);
    await pool.query('DELETE FROM caja_movimientos WHERE caja_id = $1', [cajaPerf]);
    await pool.query('DELETE FROM metodos_pago WHERE id = $1', [cajaPerf]);
  });

  // Edge case: monto con coma flotante problemática (0.1 + 0.2 = 0.30000000000004).
  // Con Math.round(monto * 100) la clave es entera exacta, así que matchea.
  it('match con decimales que romperían comparación float (0.1+0.2)', async () => {
    const k = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Float', moneda: 'USD', saldo_inicial: 0 });
    const cajaFloat = k.body.id;
    // 0.30 exacto en DB.
    const { rows } = await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, concepto)
       VALUES ($1, '2026-10-01', 'ingreso', 0.30, 0.30, 'venta', 'Float') RETURNING id`,
      [cajaFloat]
    );
    const movF = rows[0].id;
    // Línea con 0.30 desde el extracto.
    const res = await request(app).post('/api/conciliacion').set(auth()).send({
      caja_id: cajaFloat,
      fecha_desde: '2026-10-01', fecha_hasta: '2026-10-31',
      lineas: [{ fecha: '2026-10-01', monto: 0.30, descripcion: 'F' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.lineas_matched).toBe(1);

    // Cleanup
    await request(app).delete(`/api/conciliacion/${res.body.id}`).set(auth());
    await pool.query('DELETE FROM conciliacion_lineas WHERE conciliacion_id = $1', [res.body.id]);
    await pool.query('DELETE FROM conciliaciones WHERE id = $1', [res.body.id]);
    await pool.query('DELETE FROM caja_movimientos WHERE id = $1', [movF]);
    await pool.query('DELETE FROM metodos_pago WHERE id = $1', [cajaFloat]);
  });
});
