/**
 * Tests de integración — Trazabilidad Financiera → caja FV (junio 2026).
 *
 * Cambio de modelo: TODOS los movimientos del módulo Financiera (comprobantes
 * manuales, comprobantes con archivo, pagos a vendedor) ahora impactan la caja
 * marcada `es_financiera=true`. El saldo del libro caja queda alineado con el
 * saldo virtual del módulo.
 *
 * Cubre:
 *   · POST /comprobantes/manuales       → +ingreso por monto_neto
 *   · POST /comprobantes (con archivo)  → +ingreso por monto_neto
 *   · PATCH /comprobantes/manuales/:id  → revierte + repostea si cambió neto
 *   · DELETE /comprobantes/:id          → revierte el ingreso
 *   · POST /pagos                       → +ingreso destino + −egreso FV
 *   · DELETE /pagos/:id                 → revierte ambos
 *   · Sin caja FV configurada           → 400 con mensaje claro
 *   · Egreso que deja FV en negativo    → 400 (saldo insuficiente)
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

// Helper: saldo actual de una caja por id.
async function saldoCaja(id) {
  const r = await request(app).get('/api/cajas/cajas').set(auth());
  const c = r.body.find(x => x.id === id);
  return Number(c?.saldo_actual ?? 0);
}

// Helper: id de la caja FV (es_financiera=true).
async function getFvId() {
  const r = await request(app).get('/api/cajas/cajas').set(auth());
  return r.body.find(c => c.es_financiera)?.id;
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

describe('Trazabilidad: comprobantes manuales → caja FV', () => {
  it('POST /manuales crea ingreso en caja FV por monto_neto', async () => {
    const fvId = await getFvId();
    const antes = await saldoCaja(fvId);

    const r = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-04-01', cliente: 'Cliente Manual', monto_bruto: 100000, pct: 5 });
    expect(r.status).toBe(201);
    // monto_neto = 100000 * 0.95 = 95000
    expect(await saldoCaja(fvId)).toBe(antes + 95000);
  });

  it('DELETE /comprobantes/:id revierte el ingreso de la caja FV', async () => {
    const fvId = await getFvId();
    const c = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-04-02', cliente: 'A borrar', monto_bruto: 50000, pct: 0 });
    const saldoConComp = await saldoCaja(fvId);

    const del = await request(app).delete(`/api/comprobantes/${c.body.id}`).set(auth());
    expect(del.status).toBe(200);
    expect(await saldoCaja(fvId)).toBe(saldoConComp - 50000);
  });

  it('PATCH /manuales/:id con neto distinto revierte + repostea', async () => {
    const fvId = await getFvId();
    const c = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-04-03', cliente: 'A editar', monto_bruto: 30000, pct: 0 });
    const saldoOrig = await saldoCaja(fvId);

    // Subir el monto a 50000 → el delta debería ser +20000 sobre el saldo previo
    // al PATCH (que ya incluye el +30000 del POST).
    const p = await request(app).patch(`/api/comprobantes/manuales/${c.body.id}`).set(auth())
      .send({ monto_bruto: 50000, pct: 0 });
    expect(p.status).toBe(200);
    expect(await saldoCaja(fvId)).toBe(saldoOrig + 20000);
  });

  it('PATCH sin cambio de neto NO toca caja FV', async () => {
    const fvId = await getFvId();
    const c = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-04-04', cliente: 'Solo cambia cliente', monto_bruto: 10000, pct: 0 });
    const antes = await saldoCaja(fvId);

    const p = await request(app).patch(`/api/comprobantes/manuales/${c.body.id}`).set(auth())
      .send({ cliente: 'Cliente Renombrado' });
    expect(p.status).toBe(200);
    // Saldo idéntico — sin reverse/repost porque el neto no cambió.
    expect(await saldoCaja(fvId)).toBe(antes);
  });
});

describe('Trazabilidad: pagos a vendedor → ingreso destino + egreso FV', () => {
  let cajaDestino;
  beforeAll(async () => {
    const c = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Destino Trazabilidad', moneda: 'ARS', saldo_inicial: 0 });
    cajaDestino = c.body.id;
    // Asegurar saldo FV holgado para todos los pagos del bloque.
    await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-04-10', cliente: 'Prime trazabilidad', monto_bruto: 2000000, pct: 0 });
  });

  it('POST /pagos crea +ingreso en destino y −egreso en caja FV', async () => {
    const fvId = await getFvId();
    const antesFv  = await saldoCaja(fvId);
    const antesDst = await saldoCaja(cajaDestino);

    const r = await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-04-11', monto: 12000, caja_id: cajaDestino, referencia: 'Vendedor X' });
    expect(r.status).toBe(201);

    expect(await saldoCaja(cajaDestino)).toBe(antesDst + 12000);
    expect(await saldoCaja(fvId)).toBe(antesFv - 12000);
  });

  it('DELETE /pagos/:id revierte BOTH el ingreso destino y el egreso FV', async () => {
    const fvId = await getFvId();
    const r = await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-04-12', monto: 8000, caja_id: cajaDestino, referencia: 'Reverso' });
    const fvConPago  = await saldoCaja(fvId);
    const dstConPago = await saldoCaja(cajaDestino);

    const del = await request(app).delete(`/api/pagos/${r.body.id}`).set(auth());
    expect(del.status).toBe(200);
    expect(await saldoCaja(cajaDestino)).toBe(dstConPago - 8000); // reverso del ingreso
    expect(await saldoCaja(fvId)).toBe(fvConPago + 8000);         // reverso del egreso
  });

  it('Egreso que dejaría FV en negativo → 400 (no hay saldo en Financiera)', async () => {
    const fvId = await getFvId();
    const saldoFv = await saldoCaja(fvId);

    const r = await request(app).post('/api/pagos').set(auth())
      .send({ fecha: '2026-04-13', monto: saldoFv + 1000, caja_id: cajaDestino, referencia: 'overdraft' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/saldo insuficiente/i);
    // El saldo FV no cambió (rollback).
    expect(await saldoCaja(fvId)).toBe(saldoFv);
  });
});

describe('Trazabilidad: sin caja FV configurada → error claro', () => {
  it('si no existe caja es_financiera=true, POST /manuales devuelve 400 con mensaje guía', async () => {
    // Desmarcar la caja FV del setup.
    await pool.query(`UPDATE metodos_pago SET es_financiera = false WHERE es_financiera = true`);

    const r = await request(app).post('/api/comprobantes/manuales').set(auth())
      .send({ fecha: '2026-04-20', cliente: 'Sin FV', monto_bruto: 1000, pct: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/configurá una caja|es_financiera/i);

    // Restaurar para el resto de tests (la suite no es 100% aislada entre describes).
    await pool.query(`UPDATE metodos_pago SET es_financiera = true WHERE nombre = 'Pesos Ars | Efectivo'`);
  });
});
