/**
 * Tests de integración — Trazabilidad Tarjetas → caja-tarjeta (junio 2026).
 *
 * Análogo a financiera-trazabilidad-caja.test.js pero para Tarjetas. Cada
 * tarjeta (es_tarjeta=true en metodos_pago) es su propia "caja". El saldo
 * pendiente "Te deben" del módulo Tarjetas ahora debe coincidir con el
 * saldo_actual de la caja-tarjeta en GET /api/cajas.
 *
 * Cubre:
 *   · POST /cobros-iniciales       → +ingreso por monto_neto en caja-tarjeta
 *   · syncTarjetaCobros (venta)    → +ingreso al crear venta con pago tarjeta
 *   · syncTarjetaCobros (cancelar) → revierte el ingreso
 *   · POST /liquidaciones          → +ingreso destino Y −egreso caja-tarjeta
 *   · POST /liquidaciones-multiples → idem por cada reparto
 *   · DELETE /movimientos/:id      → revierte ambos lados
 *   · PATCH /movimientos/:id con cambio de monto → revierte + repostea
 *   · Liquidar más de lo cobrado   → 400 (saldo caja-tarjeta no puede ir a negativo)
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

const hoy = new Date().toISOString().slice(0, 10);
const saldoCaja = async (id) => Number(
  (await request(app).get('/api/cajas/cajas').set(auth())).body.find(c => c.id === id)?.saldo_actual ?? 0
);

let tarjetaId, cajaArsId;

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  // Tarjeta (es_tarjeta=true) con comisión 10%.
  const tarj = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'TC Trazabilidad', moneda: 'ARS', es_tarjeta: true, comision_pct: 10 });
  tarjetaId = tarj.body.id;
  // Caja destino ARS para liquidaciones.
  const caja = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Trazabilidad', moneda: 'ARS', saldo_inicial: 0 });
  cajaArsId = caja.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Trazabilidad: cobros → +ingreso en caja-tarjeta', () => {
  it('POST /cobros-iniciales crea +ingreso por monto_neto', async () => {
    const antes = await saldoCaja(tarjetaId);
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto_bruto: 100000, pct: 10 });
    expect(r.status).toBe(201);
    // Neto = 100k * 0.9 = 90k
    expect(await saldoCaja(tarjetaId)).toBe(antes + 90000);
  });

  it('venta con pago tarjeta crea +ingreso por monto_neto', async () => {
    const antes = await saldoCaja(tarjetaId);
    const r = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'Cliente Traz', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'P', cantidad: 1, precio_vendido: 50000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: tarjetaId, metodo_nombre: 'TC Trazabilidad', monto: 50000, moneda: 'ARS', tc: 1000 }],
    });
    expect(r.status).toBe(201);
    // Neto = 50k * 0.9 = 45k
    expect(await saldoCaja(tarjetaId)).toBe(antes + 45000);
  });

  it('cancelar venta revierte el ingreso del cobro automático', async () => {
    const v = await request(app).post('/api/ventas').set(auth()).send({
      fecha: hoy, cliente_nombre: 'A cancelar', estado: 'acreditado', tc_venta: 1000,
      items: [{ descripcion: 'X', cantidad: 1, precio_vendido: 30000, costo: 1, moneda: 'ARS' }],
      pagos: [{ metodo_pago_id: tarjetaId, metodo_nombre: 'TC Trazabilidad', monto: 30000, moneda: 'ARS', tc: 1000 }],
    });
    const saldoConVenta = await saldoCaja(tarjetaId);
    await request(app).delete(`/api/ventas/${v.body.id}`).set(auth());
    // Revierte 27k (= 30k * 0.9)
    expect(await saldoCaja(tarjetaId)).toBe(saldoConVenta - 27000);
  });
});

describe('Trazabilidad: liquidaciones → −egreso en caja-tarjeta', () => {
  it('POST /liquidaciones genera +ingreso destino Y −egreso caja-tarjeta', async () => {
    const antesT = await saldoCaja(tarjetaId);
    const antesC = await saldoCaja(cajaArsId);
    const r = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto: 20000, caja_id: cajaArsId });
    expect(r.status).toBe(201);
    expect(await saldoCaja(tarjetaId)).toBe(antesT - 20000);
    expect(await saldoCaja(cajaArsId)).toBe(antesC + 20000);
  });

  it('DELETE liquidación revierte AMBOS lados', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto: 5000, caja_id: cajaArsId });
    const tConLiq = await saldoCaja(tarjetaId);
    const cConLiq = await saldoCaja(cajaArsId);
    await request(app).delete(`/api/tarjetas/movimientos/${r.body.id}`).set(auth());
    // Tarjeta vuelve (sube), caja destino vuelve (baja)
    expect(await saldoCaja(tarjetaId)).toBe(tConLiq + 5000);
    expect(await saldoCaja(cajaArsId)).toBe(cConLiq - 5000);
  });

  it('PATCH liquidación con monto distinto revierte + repostea ambos lados', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto: 10000, caja_id: cajaArsId });
    const tBase = await saldoCaja(tarjetaId);
    const cBase = await saldoCaja(cajaArsId);
    // Cambia el monto: tarjeta debería egresar 5000 más, caja ingresar 5000 más
    const p = await request(app).patch(`/api/tarjetas/movimientos/${r.body.id}`).set(auth())
      .send({ monto: 15000 });
    expect(p.status).toBe(200);
    expect(await saldoCaja(tarjetaId)).toBe(tBase - 5000);
    expect(await saldoCaja(cajaArsId)).toBe(cBase + 5000);
  });

  it('liquidar más de lo que hay pendiente → 400 (caja-tarjeta no puede ir a negativo)', async () => {
    const t = await saldoCaja(tarjetaId);
    const r = await request(app).post('/api/tarjetas/liquidaciones').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto: t + 999999, caja_id: cajaArsId });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/saldo insuficiente/i);
    // El saldo NO cambió (rollback completo).
    expect(await saldoCaja(tarjetaId)).toBe(t);
  });
});

// H4 (TANDA 1 trazab): liquidación múltiple con conversión USD — N tarjetas ARS
// liquidadas en bloque a una caja USDT/USD destino. Cubre la trazabilidad
// completa: cada tarjeta-ARS lleva su −egreso ARS, la caja-destino recibe +ingreso
// USD por cada reparto, y la suma de USD coincide con el total efectivo.
describe('Trazabilidad: liquidación múltiple ARS → USDT con conversión', () => {
  let tarjeta2Id, cajaUsdtId;
  beforeAll(async () => {
    // Una segunda tarjeta ARS para liquidar en bloque.
    const t = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC Mixto Test', moneda: 'ARS', es_tarjeta: true, comision_pct: 0 });
    tarjeta2Id = t.body.id;
    // Caja destino USDT.
    const c = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'USDT Liq Mult', moneda: 'USDT', saldo_inicial: 0 });
    cajaUsdtId = c.body.id;
    // Cebar ambas tarjetas con cobros previos en ARS para tener saldo a liquidar.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto_bruto: 600000, pct: 0 });
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjeta2Id, fecha: hoy, monto_bruto: 400000, pct: 0 });
  });

  it('Cada tarjeta-ARS recibe −egreso ARS, caja USDT recibe +ingresos en USD, suma exacta', async () => {
    const t1Antes  = await saldoCaja(tarjetaId);
    const t2Antes  = await saldoCaja(tarjeta2Id);
    const usdtAntes = await saldoCaja(cajaUsdtId);

    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsdtId,
        repartos: [
          { metodo_pago_id: tarjetaId,  monto: 600000 },
          { metodo_pago_id: tarjeta2Id, monto: 400000 },
        ],
        convertir_usd: true, tc: 1000, total_usd_efectivo: 1000,
        comentarios: 'Liq múltiple mixto',
      });
    expect(r.status).toBe(201);

    // Cada caja-tarjeta ARS bajó por SU monto ARS.
    expect(await saldoCaja(tarjetaId)).toBe(t1Antes - 600000);
    expect(await saldoCaja(tarjeta2Id)).toBe(t2Antes - 400000);
    // Caja USDT recibe el total USD exacto (1000 USDT).
    expect(await saldoCaja(cajaUsdtId)).toBeCloseTo(usdtAntes + 1000, 2);

    // Verificar trazabilidad: 2 movs INGRESO USD + 2 movs EGRESO ARS, todos
    // con origen correcto. Filtramos por los IDs de tarjeta_movimientos creados.
    const ids = r.body.movimientos.map(m => m.id);
    const { rows } = await pool.query(`
      SELECT cm.caja_id, cm.tipo, cm.monto, mp.moneda
        FROM caja_movimientos cm
        JOIN metodos_pago mp ON mp.id = cm.caja_id
       WHERE cm.ref_tabla = 'tarjeta_movimientos' AND cm.ref_id = ANY($1)
         AND cm.deleted_at IS NULL
       ORDER BY cm.caja_id, cm.tipo
    `, [ids]);
    // 4 caja_movimientos: 2 ingreso (a caja USDT) + 2 egreso (uno por tarjeta).
    expect(rows).toHaveLength(4);
    const ingresos = rows.filter(r => r.tipo === 'ingreso');
    const egresos  = rows.filter(r => r.tipo === 'egreso');
    expect(ingresos).toHaveLength(2);
    expect(egresos).toHaveLength(2);
    // Los ingresos van a la caja USDT (en USD).
    ingresos.forEach(i => { expect(i.caja_id).toBe(cajaUsdtId); expect(i.moneda).toBe('USDT'); });
    // Los egresos van a cada caja-tarjeta ARS (en ARS).
    const egresosMontos = egresos.map(e => Number(e.monto)).sort();
    expect(egresosMontos).toEqual([400000, 600000]);
  });
});

// ── #444: PATCH de liquidación con conversión USD ──────────────────────
// Antes del #444 este endpoint rechazaba con 400 "edición no implementada".
// Ahora soporta editar tc, monto_usd, fecha, monto ARS, caja_id, comentarios.
describe('Trazabilidad #444: PATCH liquidación USD', () => {
  let tarjeta3Id, cajaUsdtId2;
  beforeAll(async () => {
    const t = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'TC USD Edit', moneda: 'ARS', es_tarjeta: true, comision_pct: 0 });
    tarjeta3Id = t.body.id;
    const c = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'USDT Edit Test', moneda: 'USDT', saldo_inicial: 0 });
    cajaUsdtId2 = c.body.id;
    // Saldo a liquidar.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjeta3Id, fecha: hoy, monto_bruto: 500000, pct: 0 });
  });

  it('PATCH de monto ARS recalcula automáticamente el USD (monto/tc)', async () => {
    // Setup: liquidación múltiple con TC=1000 → 100k ARS = 100 USD.
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsdtId2,
        repartos: [{ metodo_pago_id: tarjeta3Id, monto: 100000 }],
        convertir_usd: true, tc: 1000,
      });
    expect(r.status).toBe(201);
    const movId = r.body.movimientos[0].id;
    const usdtAntes = await saldoCaja(cajaUsdtId2);

    // PATCH: cambiar monto ARS a 200k. Con tc=1000 (sin cambiar tc), USD debería ser 200.
    const p = await request(app).patch(`/api/tarjetas/movimientos/${movId}`).set(auth())
      .send({ monto: 200000 });
    expect(p.status).toBe(200);
    expect(Number(p.body.monto_neto)).toBe(200000);
    expect(Number(p.body.tc)).toBe(1000);

    // Caja USDT: bajó 100 (revert del original) y subió 200 (repost) → +100.
    expect(await saldoCaja(cajaUsdtId2)).toBeCloseTo(usdtAntes + 100, 2);
  });

  it('PATCH de tc recalcula automáticamente el USD', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsdtId2,
        repartos: [{ metodo_pago_id: tarjeta3Id, monto: 100000 }],
        convertir_usd: true, tc: 1000,
      });
    const movId = r.body.movimientos[0].id;
    const usdtAntes = await saldoCaja(cajaUsdtId2);

    // PATCH: cambiar tc a 2000 → 100k ARS / 2000 = 50 USD.
    const p = await request(app).patch(`/api/tarjetas/movimientos/${movId}`).set(auth())
      .send({ tc: 2000 });
    expect(p.status).toBe(200);
    expect(Number(p.body.tc)).toBe(2000);

    // Caja: revert 100 USD, repost 50 USD → −50.
    expect(await saldoCaja(cajaUsdtId2)).toBeCloseTo(usdtAntes - 50, 2);
  });

  it('PATCH con monto_usd override usa ese valor en vez del cálculo', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsdtId2,
        repartos: [{ metodo_pago_id: tarjeta3Id, monto: 100000 }],
        convertir_usd: true, tc: 1000,
      });
    const movId = r.body.movimientos[0].id;
    const usdtAntes = await saldoCaja(cajaUsdtId2);

    // PATCH: explicit monto_usd=85 (override del cálculo 100k/1000=100).
    const p = await request(app).patch(`/api/tarjetas/movimientos/${movId}`).set(auth())
      .send({ monto_usd: 85 });
    expect(p.status).toBe(200);

    // Caja: revert 100, repost 85 → −15.
    expect(await saldoCaja(cajaUsdtId2)).toBeCloseTo(usdtAntes - 15, 2);
  });

  it('PATCH rechaza si la nueva caja_id no es USD/USDT (cuando la liq es USD)', async () => {
    // Crear una caja ARS para intentar moverla mal
    const cajaArs = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja ARS test #444', moneda: 'ARS', saldo_inicial: 0 });

    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsdtId2,
        repartos: [{ metodo_pago_id: tarjeta3Id, monto: 50000 }],
        convertir_usd: true, tc: 1000,
      });
    const movId = r.body.movimientos[0].id;

    const p = await request(app).patch(`/api/tarjetas/movimientos/${movId}`).set(auth())
      .send({ caja_id: cajaArs.body.id });
    expect(p.status).toBe(400);
    expect(p.body.error).toMatch(/USD\/USDT/i);
  });

  it('PATCH rechaza tc <= 0', async () => {
    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsdtId2,
        repartos: [{ metodo_pago_id: tarjeta3Id, monto: 50000 }],
        convertir_usd: true, tc: 1000,
      });
    const movId = r.body.movimientos[0].id;

    const p = await request(app).patch(`/api/tarjetas/movimientos/${movId}`).set(auth())
      .send({ tc: 0 });
    // Zod rechaza con 400 antes del handler.
    expect(p.status).toBe(400);
  });

  it('PATCH solo fecha (sin tc ni monto) mantiene la conversión existente', async () => {
    // Cebar saldo extra — los tests previos consumieron del cobro inicial.
    await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjeta3Id, fecha: hoy, monto_bruto: 100000, pct: 0 });

    const r = await request(app).post('/api/tarjetas/liquidaciones-multiples').set(auth())
      .send({
        fecha: hoy, caja_id: cajaUsdtId2,
        repartos: [{ metodo_pago_id: tarjeta3Id, monto: 30000 }],
        convertir_usd: true, tc: 1500,
      });
    expect(r.status).toBe(201);
    const movId = r.body.movimientos[0].id;
    const usdtAntes = await saldoCaja(cajaUsdtId2);

    // Solo cambiar fecha; ARS=30k y tc=1500 se mantienen, USD = 20.
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const p = await request(app).patch(`/api/tarjetas/movimientos/${movId}`).set(auth())
      .send({ fecha: ayer });
    expect(p.status).toBe(200);
    expect(p.body.fecha.slice(0, 10)).toBe(ayer);
    expect(Number(p.body.tc)).toBe(1500);
    expect(Number(p.body.monto_neto)).toBe(30000);

    // Caja: revert 20, repost 20 → 0 neto.
    expect(await saldoCaja(cajaUsdtId2)).toBeCloseTo(usdtAntes, 2);
  });
});

describe('Trazabilidad: cobro previo, PATCH y DELETE', () => {
  it('PATCH de cobro previo con neto distinto recalcula caja-tarjeta', async () => {
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto_bruto: 20000, pct: 0 });
    const base = await saldoCaja(tarjetaId);
    // Subir monto: neto pasa de 20k → 40k, delta +20k
    const p = await request(app).patch(`/api/tarjetas/movimientos/${r.body.id}`).set(auth())
      .send({ monto_bruto: 40000, pct: 0 });
    expect(p.status).toBe(200);
    expect(await saldoCaja(tarjetaId)).toBe(base + 20000);
  });

  it('DELETE cobro previo manual revierte el ingreso', async () => {
    const r = await request(app).post('/api/tarjetas/cobros-iniciales').set(auth())
      .send({ metodo_pago_id: tarjetaId, fecha: hoy, monto_bruto: 7000, pct: 0 });
    const conCobro = await saldoCaja(tarjetaId);
    await request(app).delete(`/api/tarjetas/movimientos/${r.body.id}`).set(auth());
    expect(await saldoCaja(tarjetaId)).toBe(conCobro - 7000);
  });
});
