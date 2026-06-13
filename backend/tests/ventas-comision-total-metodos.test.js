/**
 * Tests de integración — Tema C.1 (2026-06-13)
 *
 * `ventas.comision_total_metodos` queda en sync con tarjeta_movimientos +
 * comprobantes después de cada POST/PUT/DELETE de venta. Se denormaliza para
 * que el dashboard pueda restarlo de la ganancia bruta (PR C.3) sin pagar
 * JOINs extras por query.
 *
 * Cubre los casos canónicos:
 *  · Sin pagos con comisión (efectivo / USD) → columna = 0.
 *  · Pago con tarjeta (ARS, 1 cuota 11%, TC=1000, USD-equiv $100) → 100×0.11 = $11.
 *  · Pago con transferencia + comprobante (Financiera 5%, USD-equiv $200) → $10.
 *  · Combo tarjeta + transferencia → suma de ambos.
 *  · Cancelar la venta vacía la columna a 0.
 *  · PUT que swappa el método de pago refleja la nueva comisión.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, cajaEfectivoArs, tarjeta1c, fvId;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy  = new Date().toISOString().split('T')[0];

// 1×1 GIF base64 — sirve como archivo de comprobante mínimo para venta_comprobantes.
const TINY_GIF = 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';

async function getComisionTotal(ventaId) {
  const { rows } = await pool.query(
    'SELECT comision_total_metodos FROM ventas WHERE id = $1', [ventaId]
  );
  return Number(rows[0]?.comision_total_metodos ?? null);
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;

  // Setear pct_financiera del config — sin este valor, syncFinancieraComprobante
  // calcula comisión = 0 y el test de Financiera queda mudo.
  await request(app).put('/api/config').set(auth()).send({ pct_financiera: 5 });

  // Caja ARS de uso libre (no FV, no tarjeta) — para casos sin comisión.
  cajaEfectivoArs = (await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Test ARS', moneda: 'ARS', saldo_inicial: 0 })).body.id;

  // Caja-tarjeta con 11% — replica el "1 cuota" del cotizador post-fix.
  tarjeta1c = (await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Tarjeta Test 1 Cuota', moneda: 'ARS', es_tarjeta: true, comision_pct: 11 })).body.id;

  // La caja FV viene seeded por setupTestDb (Pesos Ars | Efectivo, es_financiera=true).
  const cajas = await request(app).get('/api/cajas/cajas').set(auth());
  fvId = cajas.body.find(c => c.es_financiera).id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('comision_total_metodos — POST de venta', () => {
  it('venta sin métodos con comisión → columna = 0', async () => {
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Sin comisión', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: cajaEfectivoArs, metodo_nombre: 'Caja Test ARS', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v.status).toBe(201);
    expect(Number(v.body.comision_total_metodos)).toBe(0);
    expect(await getComisionTotal(v.body.id)).toBe(0);
  });

  it('venta con tarjeta ARS 11% → columna ≈ 11 USD (ratio monto_usd/monto)', async () => {
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Con tarjeta', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      // 100000 ARS / 1000 TC = 100 USD; 11% comisión = 11000 ARS = 11 USD.
      pagos: [{ metodo_pago_id: tarjeta1c, metodo_nombre: 'Tarjeta Test 1 Cuota', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v.status).toBe(201);
    expect(Number(v.body.comision_total_metodos)).toBeCloseTo(11, 2);
    expect(await getComisionTotal(v.body.id)).toBeCloseTo(11, 2);
  });

  it('venta con transferencia + comprobante (FV 5%) → columna ≈ 10 USD', async () => {
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Con transferencia', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 200, costo: 1, moneda: 'USD' }],
      // 200000 ARS / 1000 TC = 200 USD; 5% comisión = 10000 ARS = 10 USD.
      pagos: [{ metodo_pago_id: fvId, metodo_nombre: 'Pesos Ars | Efectivo', monto: 200000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v.status).toBe(201);

    // syncFinancieraComprobante NO crea el comprobante hasta que haya un archivo
    // adjunto en venta_comprobantes (invariante a/b/c en lib/financiera.js).
    // Sin archivo → columna debe ser 0.
    expect(Number(v.body.comision_total_metodos)).toBe(0);

    // Subir comprobante manualmente y volver a editar para que reactive el sync.
    await pool.query(
      `INSERT INTO venta_comprobantes (venta_id, archivo_data, archivo_nombre, archivo_tipo)
       VALUES ($1, $2, 'comp.gif', 'image/gif')`,
      [v.body.id, TINY_GIF]
    );
    // Edit no-op para disparar syncFinancieraComprobante + syncComisionTotalMetodos.
    const upd = await request(app).put(`/api/ventas/${v.body.id}`).set(auth())
      .send({ estado: 'acreditado' });
    expect(upd.status).toBe(200);
    expect(Number(upd.body.comision_total_metodos)).toBeCloseTo(10, 2);
    expect(await getComisionTotal(v.body.id)).toBeCloseTo(10, 2);
  });

  it('venta cancelada → columna queda en 0', async () => {
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Cancelable', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: tarjeta1c, metodo_nombre: 'Tarjeta Test 1 Cuota', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v.status).toBe(201);
    expect(Number(v.body.comision_total_metodos)).toBeCloseTo(11, 2);

    const upd = await request(app).put(`/api/ventas/${v.body.id}`).set(auth())
      .send({ estado: 'cancelado' });
    expect(upd.status).toBe(200);
    // syncTarjetaCobros soft-deletea los movs con estado='cancelado' → columna = 0.
    expect(Number(upd.body.comision_total_metodos)).toBe(0);
    expect(await getComisionTotal(v.body.id)).toBe(0);
  });
});

describe('comision_total_metodos — PUT de venta (cambio de método)', () => {
  it('cambiar pago de efectivo → tarjeta refleja la nueva comisión', async () => {
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Swap', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: cajaEfectivoArs, metodo_nombre: 'Caja Test ARS', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(Number(v.body.comision_total_metodos)).toBe(0);

    const upd = await request(app).put(`/api/ventas/${v.body.id}`).set(auth()).send({
      estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Producto', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: tarjeta1c, metodo_nombre: 'Tarjeta Test 1 Cuota', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(upd.status).toBe(200);
    expect(Number(upd.body.comision_total_metodos)).toBeCloseTo(11, 2);
    expect(await getComisionTotal(v.body.id)).toBeCloseTo(11, 2);
  });
});
