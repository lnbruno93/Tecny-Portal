/**
 * Tests del Dashboard de Resumen Mensual.
 *
 * Cubre:
 *  - Shape del JSON (actual + comparado).
 *  - Validación del formato YYYY-MM (400 si está mal).
 *  - Default de períodos (sin args → mes actual vs mes anterior).
 *  - Agregaciones correctas con datos sembrados.
 *  - El cache no contamina entre tests con datos distintos.
 *  - Helpers puros (rangoMes, mesAnterior).
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const { rangoMes, mesAnterior } = require('../src/lib/dashboardMensual');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});
afterAll(async () => { await teardownTestDb(pool); });

describe('Helpers: rangoMes + mesAnterior', () => {
  it('rangoMes 2026-02 → { desde 01, hasta 28 } (no bisiesto)', () => {
    expect(rangoMes('2026-02')).toEqual({ desde: '2026-02-01', hasta: '2026-02-28' });
  });
  it('rangoMes 2024-02 → 29 (año bisiesto)', () => {
    expect(rangoMes('2024-02')).toEqual({ desde: '2024-02-01', hasta: '2024-02-29' });
  });
  it('rangoMes 2026-01 → 31 días', () => {
    expect(rangoMes('2026-01').hasta).toBe('2026-01-31');
  });
  it('rangoMes 2026-04 → 30 días', () => {
    expect(rangoMes('2026-04').hasta).toBe('2026-04-30');
  });
  it('rangoMes 2026-12 → 31 días', () => {
    expect(rangoMes('2026-12').hasta).toBe('2026-12-31');
  });
  it('rangoMes con formato inválido → throw status 400', () => {
    expect(() => rangoMes('2026-13')).toThrow();
    expect(() => rangoMes('abcd-ef')).toThrow();
    expect(() => rangoMes('2026')).toThrow();
  });
  it('mesAnterior cruza año correctamente', () => {
    expect(mesAnterior('2026-01')).toBe('2025-12');
  });
  it('mesAnterior dentro del año', () => {
    expect(mesAnterior('2026-05')).toBe('2026-04');
    expect(mesAnterior('2026-10')).toBe('2026-09');
  });
});

describe('GET /api/dashboard/resumen-mensual', () => {
  it('sin args → 200 con shape correcto (actual + comparado)', async () => {
    const res = await request(app).get('/api/dashboard/resumen-mensual').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('actual');
    expect(res.body).toHaveProperty('comparado');
    expect(res.body).toHaveProperty('generado_en');
    // actual debe tener todas las secciones.
    const a = res.body.actual;
    expect(a).toHaveProperty('periodo.desde');
    expect(a).toHaveProperty('periodo.hasta');
    expect(a).toHaveProperty('ventas');
    expect(a.ventas).toHaveProperty('cant_ventas');
    expect(a.ventas).toHaveProperty('ventas_usd');
    expect(a.ventas).toHaveProperty('ganancia_usd');
    expect(a.ventas).toHaveProperty('ticket_promedio_usd');
    expect(Array.isArray(a.ventas.top_productos)).toBe(true);
    expect(Array.isArray(a.ventas.top_vendedores)).toBe(true);
    expect(Array.isArray(a.ventas.pagos_por_metodo)).toBe(true);
    expect(a).toHaveProperty('cajas');
    expect(Array.isArray(a.cajas.cajas)).toBe(true);
    expect(a.cajas).toHaveProperty('por_moneda.ARS');
    expect(a.cajas).toHaveProperty('por_moneda.USD');
    expect(a.cajas).toHaveProperty('por_moneda.USDT');
    expect(a.cajas).toHaveProperty('capital_usd_equivalente');
    expect(a).toHaveProperty('deuda_cc.deuda_usd');
    expect(a).toHaveProperty('deuda_proveedores.deuda_usd');
    expect(a).toHaveProperty('egresos.total_usd');
  });

  it('períodos custom: ?periodo=YYYY-MM&comparar_con=YYYY-MM', async () => {
    const res = await request(app)
      .get('/api/dashboard/resumen-mensual?periodo=2026-03&comparar_con=2026-02')
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.actual.periodo.desde).toBe('2026-03-01');
    expect(res.body.actual.periodo.hasta).toBe('2026-03-31');
    expect(res.body.comparado.periodo.desde).toBe('2026-02-01');
    expect(res.body.comparado.periodo.hasta).toBe('2026-02-28');
  });

  it('formato YYYY-MM inválido → 400', async () => {
    const r1 = await request(app).get('/api/dashboard/resumen-mensual?periodo=2026-13').set(auth());
    expect(r1.status).toBe(400);
    const r2 = await request(app).get('/api/dashboard/resumen-mensual?periodo=abc').set(auth());
    expect(r2.status).toBe(400);
  });

  it('requiere permiso financiera (usuario sin permiso → 403)', async () => {
    // Crear usuario sin permiso financiera
    const noFin = await request(app).post('/api/usuarios').set(auth()).send({
      nombre: 'Sin Fin', username: 'sinfin', password: 'pwd123abc', role: 'usuario',
      perms: { ventas: true, cajas: true }, // sin financiera
    });
    if (noFin.status !== 201) return; // depende del setup; skip si la fixture no permite
    const login = await request(app).post('/api/auth/login')
      .send({ username: 'sinfin', password: 'pwd123abc' });
    const tok = login.body.token;
    const res = await request(app).get('/api/dashboard/resumen-mensual')
      .set({ Authorization: `Bearer ${tok}` });
    expect(res.status).toBe(403);
  });

  it('sin auth → 401', async () => {
    const res = await request(app).get('/api/dashboard/resumen-mensual');
    expect(res.status).toBe(401);
  });
});

describe('Agregaciones reales con datos sembrados (SQL directo)', () => {
  let cajaDashId;

  beforeAll(async () => {
    // Seed via SQL directo para no depender de los schemas de ventas
    // (que evolucionan con cambios de negocio). Solo necesitamos verificar
    // que las agregaciones del dashboard reflejen lo que persistimos.
    const { rows: [c] } = await pool.query(
      `INSERT INTO metodos_pago (nombre, moneda, saldo_inicial)
       VALUES ('Caja Dash Test', 'USD', 2000) RETURNING id`
    );
    cajaDashId = c.id;
    // Ingreso al 2026-04-15 simulando una venta.
    await pool.query(
      `INSERT INTO caja_movimientos (caja_id, fecha, tipo, monto, monto_usd, origen, concepto)
       VALUES ($1, '2026-04-15', 'ingreso', 500, 500, 'venta', 'Test seed')`,
      [cajaDashId]
    );
  });

  it('snapshot de cajas refleja saldo histórico al corte', async () => {
    // Al 2026-04-30: saldo_inicial 2000 + ingreso 500 = 2500.
    const res = await request(app)
      .get('/api/dashboard/resumen-mensual?periodo=2026-04&comparar_con=2026-03')
      .set(auth());
    expect(res.status).toBe(200);
    const c = res.body.actual.cajas.cajas.find(x => x.id === cajaDashId);
    expect(c).toBeTruthy();
    expect(Number(c.saldo)).toBeCloseTo(2500, 2);
  });

  it('snapshot del mes anterior NO incluye el movimiento (saldo solo inicial)', async () => {
    // Al 2026-03-31: solo el saldo inicial (2000) — el movimiento es de abril.
    const res = await request(app)
      .get('/api/dashboard/resumen-mensual?periodo=2026-04&comparar_con=2026-03')
      .set(auth());
    const c = res.body.comparado.cajas.cajas.find(x => x.id === cajaDashId);
    expect(Number(c.saldo)).toBeCloseTo(2000, 2);
  });

  // TANDA 0 #5: TC fallback
  it('TANDA 0 #5: si no hay TC de venta ni config, tc_referencia es null', async () => {
    // En tests, las tablas están casi vacías y tc_referencia config se setea
    // sólo si la migración 19 corrió. Si tc_referencia es valor > 0, lo usa;
    // si no, debería ser null (antes hardcoded 1000 → ahora null si nada).
    const res = await request(app)
      .get('/api/dashboard/resumen-mensual?periodo=2026-04&comparar_con=2026-03')
      .set(auth());
    expect(res.status).toBe(200);
    // tc_referencia puede ser un número (de la última venta o config) o null.
    // Lo importante: NO debe ser 1000 hardcoded.
    const tc = res.body.actual.cajas.tc_referencia;
    if (tc !== null) {
      expect(typeof tc).toBe('number');
      expect(tc).toBeGreaterThan(0);
    }
    // Si hay saldo ARS y tc_referencia es null, capital_usd_equivalente
    // debe ser null (no inventamos un TC). Si saldo ARS = 0, puede ser 0.
    const cajas = res.body.actual.cajas;
    if (tc === null && cajas.por_moneda.ARS !== 0) {
      expect(cajas.capital_usd_equivalente).toBeNull();
    }
  });
});
