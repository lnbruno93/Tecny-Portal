/**
 * Tests del script Tema C.2 — backfill de ventas.comision_total_metodos.
 *
 * Cubre:
 *  · DRY-RUN no toca la DB (la columna queda como estaba).
 *  · APPLY actualiza solo las ventas cuyo cálculo difiere.
 *  · Idempotencia: 2 corridas seguidas no cambian nada en la 2da.
 *  · Ventas canceladas se ignoran (la columna queda en 0).
 *  · Reporte estructurado (top 10 + suma delta).
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const { runBackfill } = require('../scripts/backfill-comision-total-metodos');

let pool, token, cajaEfectivoArs, tarjeta11;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { console.log.mockRestore?.(); });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;

  cajaEfectivoArs = (await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Backfill ARS', moneda: 'ARS', saldo_inicial: 0 })).body.id;

  tarjeta11 = (await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'TC Backfill 11%', moneda: 'ARS', es_tarjeta: true, comision_pct: 11 })).body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

async function getCol(ventaId) {
  const { rows } = await pool.query(
    'SELECT comision_total_metodos FROM ventas WHERE id = $1', [ventaId]
  );
  return Number(rows[0]?.comision_total_metodos || 0);
}

describe('backfill-comision-total-metodos', () => {
  it('venta nueva post-C.1 queda al día — backfill no la toca', async () => {
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Post-C.1', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: tarjeta11, metodo_nombre: 'TC Backfill 11%', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v.status).toBe(201);
    expect(Number(v.body.comision_total_metodos)).toBeCloseTo(11, 2);

    // Inducimos drift artificial — simulamos venta legacy con la columna en 0.
    await pool.query('UPDATE ventas SET comision_total_metodos = 0 WHERE id = $1', [v.body.id]);
    expect(await getCol(v.body.id)).toBe(0);

    // DRY-RUN detecta el cambio pero no escribe.
    const dry = await runBackfill({ apply: false });
    expect(dry.apply).toBe(false);
    expect(dry.ventas_cambiadas).toBeGreaterThanOrEqual(1);
    expect(dry.suma_delta_usd).toBeCloseTo(11, 2);
    expect(await getCol(v.body.id)).toBe(0); // no cambió

    // APPLY persiste.
    const ap = await runBackfill({ apply: true });
    expect(ap.apply).toBe(true);
    expect(ap.ventas_cambiadas).toBeGreaterThanOrEqual(1);
    expect(await getCol(v.body.id)).toBeCloseTo(11, 2);
  });

  it('2da corrida después de apply → 0 cambios (idempotencia)', async () => {
    // El test anterior ya dejó todo al día.
    const r = await runBackfill({ apply: true });
    expect(r.ventas_cambiadas).toBe(0);
    expect(r.skipped).toBe(true);
  });

  it('venta cancelada no aparece en el backfill (filtro estado != cancelado)', async () => {
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Pronto cancelada', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: tarjeta11, metodo_nombre: 'TC Backfill 11%', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    await request(app).put(`/api/ventas/${v.body.id}`).set(auth())
      .send({ estado: 'cancelado' });

    // Si forzamos drift en la cancelada, el backfill NO debería tocarla.
    await pool.query('UPDATE ventas SET comision_total_metodos = 99 WHERE id = $1', [v.body.id]);

    const dry = await runBackfill({ apply: false });
    // En el reporte de cambios no debería figurar (estado != 'cancelado' la filtra).
    expect(dry.muestras.find(m => m.id === v.body.id)).toBeUndefined();

    // Y la columna queda como la dejamos (= 99), porque el backfill NO la mira.
    expect(await getCol(v.body.id)).toBe(99);
  });

  it('venta sin métodos con comisión queda en 0 y no aparece en cambios', async () => {
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Sin comisión', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: cajaEfectivoArs, metodo_nombre: 'Caja Backfill ARS', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(Number(v.body.comision_total_metodos)).toBe(0);

    const r = await runBackfill({ apply: false });
    expect(r.muestras.find(m => m.id === v.body.id)).toBeUndefined();
  });
});
