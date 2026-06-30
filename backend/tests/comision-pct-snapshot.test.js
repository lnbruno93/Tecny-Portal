/**
 * Tests de la política "snapshot lazy" de % de comisiones.
 * Auditoría 2026-06-30 D-01 — Bug P0 "cambiar pct retroactivo afecta KPIs".
 *
 * Cubre los 4 escenarios definidos en el diseño:
 *  1. Cambiar config.pct_financiera DESPUÉS de crear V1 → editar V1
 *       → comprobantes.monto_financiera queda intacto (NO recalcula con pct nuevo).
 *  2. Cambiar mp.comision_pct (caja tarjeta) DESPUÉS de crear V2 → editar V2
 *       → tarjeta_movimientos.monto_comision queda intacto.
 *  3. Crear venta NUEVA después de cambio de % → usa el % nuevo (snapshot al INSERT).
 *  4. Sealing lazy: venta pre-fix (pct_aplicado IS NULL) → editar
 *       → pct_aplicado se popula con el derivado, monto_financiera no cambia.
 *
 * Helpers:
 *  · createVentaConFinanciera(monto, pct) — crea venta + comprobante + setea config.
 *  · TINY_GIF — archivo dummy para satisfacer la invariante (c) de financiera.
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token, cajaEfectivoArs, tarjeta1c, fvId;
const auth = () => ({ Authorization: `Bearer ${token}` });
const hoy = new Date().toISOString().split('T')[0];

// 1×1 GIF base64 — sirve como archivo de comprobante mínimo.
const TINY_GIF = 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';

async function getComprobante(ventaId) {
  const { rows } = await pool.query(
    `SELECT id, monto, monto_financiera, monto_neto, pct_aplicado, deleted_at
       FROM comprobantes WHERE venta_id = $1 ORDER BY id LIMIT 1`,
    [ventaId]
  );
  return rows[0] || null;
}

async function getTarjetaMov(ventaId) {
  const { rows } = await pool.query(
    `SELECT id, monto_bruto, monto_comision, monto_neto, pct, deleted_at
       FROM tarjeta_movimientos
      WHERE venta_id = $1 AND tipo = 'cobro' AND deleted_at IS NULL
      ORDER BY id LIMIT 1`,
    [ventaId]
  );
  return rows[0] || null;
}

async function getVentaPagoSnapshot(ventaId) {
  const { rows } = await pool.query(
    `SELECT id, metodo_pago_id, comision_pct_snapshot FROM venta_pagos
      WHERE venta_id = $1 ORDER BY id LIMIT 1`,
    [ventaId]
  );
  return rows[0] || null;
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;

  // Setear pct_financiera = 5% al inicio
  await request(app).put('/api/config').set(auth()).send({ pct_financiera: 5 });

  cajaEfectivoArs = (await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Snap Test ARS', moneda: 'ARS', saldo_inicial: 0 })).body.id;

  tarjeta1c = (await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Tarjeta Snap 11', moneda: 'ARS', es_tarjeta: true, comision_pct: 11 })).body.id;

  const cajas = await request(app).get('/api/cajas/cajas').set(auth());
  fvId = cajas.body.find(c => c.es_financiera).id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('snapshot lazy — financiera (config.pct_financiera)', () => {
  it('cambiar pct_financiera tras alta NO afecta monto_financiera al editar', async () => {
    // Setup: pct_financiera = 5%
    await request(app).put('/api/config').set(auth()).send({ pct_financiera: 5 });

    // Crear venta con pago FV
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'V1 Financiera Snap', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'Prod', cantidad: 1, precio_vendido: 200, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: fvId, metodo_nombre: 'Pesos Ars | Efectivo', monto: 200000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v.status).toBe(201);
    const ventaId = v.body.id;

    // Agregar archivo de comprobante (sin esto, financiera no se sincroniza)
    await pool.query(
      `INSERT INTO venta_comprobantes (venta_id, archivo_data, archivo_nombre, archivo_tipo)
       VALUES ($1, $2, 'snap.gif', 'image/gif')`,
      [ventaId, TINY_GIF]
    );
    // Edit no-op para disparar syncFinancieraComprobante
    await request(app).put(`/api/ventas/${ventaId}`).set(auth())
      .send({ estado: 'acreditado' });

    let comp = await getComprobante(ventaId);
    // 200000 * 5% = 10000
    expect(Number(comp.monto_financiera)).toBe(10000);
    expect(Number(comp.pct_aplicado)).toBe(5);
    const montoFinOriginal = Number(comp.monto_financiera);

    // Cambiar pct_financiera a 9% — esto NO debe propagarse a la venta histórica.
    await request(app).put('/api/config').set(auth()).send({ pct_financiera: 9 });

    // Editar la venta (cambio de nota — toca syncFinancieraComprobante).
    const upd = await request(app).put(`/api/ventas/${ventaId}`).set(auth())
      .send({ notas: 'edit despues del cambio de pct' });
    expect(upd.status).toBe(200);

    comp = await getComprobante(ventaId);
    // CRÍTICO: monto_financiera no cambió. pct_aplicado sigue siendo 5 (no 9).
    expect(Number(comp.monto_financiera)).toBe(montoFinOriginal);
    expect(Number(comp.pct_aplicado)).toBe(5);

    // Cleanup: restaurar pct = 5
    await request(app).put('/api/config').set(auth()).send({ pct_financiera: 5 });
  });

  it('venta NUEVA después de cambio de pct usa el % nuevo (snapshot al INSERT)', async () => {
    await request(app).put('/api/config').set(auth()).send({ pct_financiera: 5 });

    // Crear venta vieja
    const v1 = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'V1 antes del cambio', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'P', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: fvId, metodo_nombre: 'Pesos Ars | Efectivo', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    await pool.query(
      `INSERT INTO venta_comprobantes (venta_id, archivo_data, archivo_nombre, archivo_tipo)
       VALUES ($1, $2, 'a.gif', 'image/gif')`, [v1.body.id, TINY_GIF]
    );
    await request(app).put(`/api/ventas/${v1.body.id}`).set(auth()).send({ estado: 'acreditado' });
    const comp1 = await getComprobante(v1.body.id);
    expect(Number(comp1.pct_aplicado)).toBe(5);
    expect(Number(comp1.monto_financiera)).toBe(5000);

    // Cambiar pct a 7%
    await request(app).put('/api/config').set(auth()).send({ pct_financiera: 7 });

    // Crear venta NUEVA — debe usar 7%.
    const v2 = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'V2 después del cambio', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'P', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: fvId, metodo_nombre: 'Pesos Ars | Efectivo', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    await pool.query(
      `INSERT INTO venta_comprobantes (venta_id, archivo_data, archivo_nombre, archivo_tipo)
       VALUES ($1, $2, 'b.gif', 'image/gif')`, [v2.body.id, TINY_GIF]
    );
    await request(app).put(`/api/ventas/${v2.body.id}`).set(auth()).send({ estado: 'acreditado' });

    const comp2 = await getComprobante(v2.body.id);
    // V2 usa el % nuevo
    expect(Number(comp2.pct_aplicado)).toBe(7);
    expect(Number(comp2.monto_financiera)).toBe(7000);

    // V1 sigue intacta con su pct_aplicado=5
    const comp1Again = await getComprobante(v1.body.id);
    expect(Number(comp1Again.pct_aplicado)).toBe(5);
    expect(Number(comp1Again.monto_financiera)).toBe(5000);

    // Cleanup
    await request(app).put('/api/config').set(auth()).send({ pct_financiera: 5 });
  });

  it('sealing lazy: fila pre-fix (pct_aplicado=NULL) se sella sin cambiar montos', async () => {
    // Simular fila pre-fix: insertar comprobante manualmente con pct_aplicado=NULL.
    // monto=100000, monto_financiera=4500 → pct derivado debería ser 4.5%.
    const { rows: vrow } = await pool.query(
      `INSERT INTO ventas (order_id, fecha, estado, total_usd, ganancia_usd, user_id)
       VALUES ('ORD-SNAP-LAZY', $1, 'acreditado', 100, 50, (SELECT id FROM users LIMIT 1))
       RETURNING id`,
      [hoy]
    );
    const ventaId = vrow[0].id;
    // venta_pago + comprobante pre-fix (pct_aplicado y comision_pct_snapshot NULL)
    await pool.query(
      `INSERT INTO venta_pagos (venta_id, metodo_pago_id, metodo_nombre, monto, moneda, tc, monto_usd, es_cuenta_corriente)
       VALUES ($1, $2, 'Pesos Ars | Efectivo', 100000, 'ARS', 1000, 100, false)`,
      [ventaId, fvId]
    );
    await pool.query(
      `INSERT INTO venta_comprobantes (venta_id, archivo_data, archivo_nombre, archivo_tipo)
       VALUES ($1, $2, 'pre.gif', 'image/gif')`, [ventaId, TINY_GIF]
    );
    await pool.query(
      `INSERT INTO comprobantes (fecha, cliente, monto, monto_financiera, monto_neto, venta_id, archivo_data, archivo_nombre, archivo_tipo)
       VALUES ($1, 'Pre fix', 100000, 4500, 95500, $2, $3, 'pre.gif', 'image/gif')`,
      [hoy, ventaId, TINY_GIF]
    );

    // Pre-condiciones: pct_aplicado NULL, monto_financiera=4500
    let comp = await getComprobante(ventaId);
    expect(comp.pct_aplicado).toBeNull();
    expect(Number(comp.monto_financiera)).toBe(4500);

    // Cambiar config a 9% antes del touch — para verificar que NO se aplica.
    await request(app).put('/api/config').set(auth()).send({ pct_financiera: 9 });

    // Editar la venta (touch) — debe sellar lazy
    const upd = await request(app).put(`/api/ventas/${ventaId}`).set(auth())
      .send({ notas: 'sealing lazy touch' });
    expect(upd.status).toBe(200);

    comp = await getComprobante(ventaId);
    // Sealing matemático: pct = 4500 * 100 / 100000 = 4.5
    expect(Number(comp.pct_aplicado)).toBe(4.5);
    // CRÍTICO: monto_financiera no cambió a 9000 (que sería 9% del nuevo config)
    expect(Number(comp.monto_financiera)).toBe(4500);

    // Cleanup
    await request(app).put('/api/config').set(auth()).send({ pct_financiera: 5 });
  });
});

describe('snapshot lazy — tarjeta (mp.comision_pct)', () => {
  it('cambiar mp.comision_pct tras alta NO afecta tarjeta_movimientos.monto_comision al editar', async () => {
    // Crear venta V2 con pago en tarjeta 11%
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'V2 Tarjeta Snap', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'P', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: tarjeta1c, metodo_nombre: 'Tarjeta Snap 11', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v.status).toBe(201);
    const ventaId = v.body.id;

    let tm = await getTarjetaMov(ventaId);
    expect(Number(tm.monto_comision)).toBe(11000); // 100000 × 11%
    expect(Number(tm.pct)).toBe(11);

    let vp = await getVentaPagoSnapshot(ventaId);
    expect(Number(vp.comision_pct_snapshot)).toBe(11);

    const comisionOriginal = Number(tm.monto_comision);

    // Cambiar comision_pct del método a 25%
    await request(app).put(`/api/cajas/cajas/${tarjeta1c}`).set(auth())
      .send({ es_tarjeta: true, comision_pct: 25 });

    // Editar la venta (no fullEdit — solo nota)
    const upd = await request(app).put(`/api/ventas/${ventaId}`).set(auth())
      .send({ notas: 'edit despues del cambio de comision_pct' });
    expect(upd.status).toBe(200);

    tm = await getTarjetaMov(ventaId);
    // CRÍTICO: la comisión sigue siendo 11%, no 25%
    expect(Number(tm.monto_comision)).toBe(comisionOriginal);
    expect(Number(tm.pct)).toBe(11);

    // El snapshot del venta_pago sigue siendo 11 (no se cambió a 25)
    vp = await getVentaPagoSnapshot(ventaId);
    expect(Number(vp.comision_pct_snapshot)).toBe(11);

    // Cleanup
    await request(app).put(`/api/cajas/cajas/${tarjeta1c}`).set(auth())
      .send({ es_tarjeta: true, comision_pct: 11 });
  });

  it('venta NUEVA después de cambio de comision_pct usa el % nuevo (snapshot al INSERT)', async () => {
    // Asegurar que tarjeta1c está en 11
    await request(app).put(`/api/cajas/cajas/${tarjeta1c}`).set(auth())
      .send({ es_tarjeta: true, comision_pct: 11 });

    // V1 con 11%
    const v1 = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'V1 con 11', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'P', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: tarjeta1c, metodo_nombre: 'Tarjeta Snap 11', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v1.status).toBe(201);
    const tm1 = await getTarjetaMov(v1.body.id);
    expect(Number(tm1.pct)).toBe(11);

    // Cambiar comision_pct a 20
    await request(app).put(`/api/cajas/cajas/${tarjeta1c}`).set(auth())
      .send({ es_tarjeta: true, comision_pct: 20 });

    // V2 con 20%
    const v2 = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'V2 con 20', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'P', cantidad: 1, precio_vendido: 100, costo: 1, moneda: 'USD' }],
      pagos: [{ metodo_pago_id: tarjeta1c, metodo_nombre: 'Tarjeta Snap 11', monto: 100000, moneda: 'ARS', tc: 1000 }],
    });
    expect(v2.status).toBe(201);
    const tm2 = await getTarjetaMov(v2.body.id);
    expect(Number(tm2.pct)).toBe(20);
    expect(Number(tm2.monto_comision)).toBe(20000);

    // V1 sigue intacta con 11%
    const tm1Again = await getTarjetaMov(v1.body.id);
    expect(Number(tm1Again.pct)).toBe(11);

    // Cleanup
    await request(app).put(`/api/cajas/cajas/${tarjeta1c}`).set(auth())
      .send({ es_tarjeta: true, comision_pct: 11 });
  });

  it('sealing lazy de venta_pago pre-fix: derive pct desde mov viejo', async () => {
    // Simular venta pre-fix: venta + venta_pago con comision_pct_snapshot=NULL +
    // tarjeta_movimiento con pct=33 (un % que NO es el actual del método).
    const { rows: vrow } = await pool.query(
      `INSERT INTO ventas (order_id, fecha, estado, total_usd, ganancia_usd, user_id)
       VALUES ('ORD-TJ-LAZY', $1, 'acreditado', 100, 50, (SELECT id FROM users LIMIT 1))
       RETURNING id`,
      [hoy]
    );
    const ventaId = vrow[0].id;
    await pool.query(
      `INSERT INTO venta_pagos (venta_id, metodo_pago_id, metodo_nombre, monto, moneda, tc, monto_usd, es_cuenta_corriente)
       VALUES ($1, $2, 'Tarjeta Snap 11', 100000, 'ARS', 1000, 100, false)`,
      [ventaId, tarjeta1c]
    );
    // mov histórico con 33% — simula que en su momento el método estaba en 33.
    await pool.query(
      `INSERT INTO tarjeta_movimientos
         (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, venta_id)
       VALUES ($1, $2, 'cobro', 'ARS', 100000, 33, 33000, 67000, $3)`,
      [tarjeta1c, hoy, ventaId]
    );

    // El método de pago actual está en 11 — pero el sealing debe usar el 33 derivado.
    let vp = await getVentaPagoSnapshot(ventaId);
    expect(vp.comision_pct_snapshot).toBeNull();

    // Touch: editar nota → syncTarjetaCobros corre, sella lazy, recrea movs.
    const upd = await request(app).put(`/api/ventas/${ventaId}`).set(auth())
      .send({ notas: 'sealing lazy tarjeta' });
    expect(upd.status).toBe(200);

    vp = await getVentaPagoSnapshot(ventaId);
    // sealing derivó 33 del mov viejo (33000 / 100000 * 100 = 33)
    expect(Number(vp.comision_pct_snapshot)).toBe(33);

    // El mov nuevo recreado usa el snapshot (33%), NO el pct actual del método (11%)
    const tm = await getTarjetaMov(ventaId);
    expect(Number(tm.pct)).toBe(33);
    expect(Number(tm.monto_comision)).toBe(33000);
  });
});
