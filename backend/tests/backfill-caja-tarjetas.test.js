/**
 * Tests del script de backfill de cajas-tarjeta (TANDA 2 Tarjetas).
 *
 * Cubre:
 *   · DRY-RUN no toca la DB.
 *   · APPLY crea +ingreso por cada cobro pendiente y −egreso por liquidación.
 *   · Idempotencia: 2 corridas no duplican.
 *   · NO toca cobros que YA tienen caja_movimiento.
 *   · Aborta si alguna tarjeta quedaría con saldo negativo.
 *   · Sin tarjetas configuradas → throw con mensaje guía.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const { runBackfill } = require('../scripts/backfill-caja-tarjetas');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { console.log.mockRestore?.(); });

let tarjetaId, otraCajaId;

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
  // Tarjeta para los tests.
  const tarj = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'TC Backfill', moneda: 'ARS', es_tarjeta: true, comision_pct: 10 });
  tarjetaId = tarj.body.id;
  // Caja destino para liquidaciones.
  const caja = await request(app).post('/api/cajas/cajas').set(auth())
    .send({ nombre: 'Caja Backfill ARS', moneda: 'ARS', saldo_inicial: 0 });
  otraCajaId = caja.body.id;
});

afterAll(async () => { await teardownTestDb(pool); });

// Seed helper: cobro histórico SIN caja_movimiento (simula estado pre-TANDA 1).
async function seedCobroHistorico({ fecha, neto, venta_id = null, tarjeta = tarjetaId }) {
  const { rows } = await pool.query(`
    INSERT INTO tarjeta_movimientos
      (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, venta_id)
    VALUES ($1, $2, 'cobro', 'ARS', $3, 0, 0, $3, $4)
    RETURNING id
  `, [tarjeta, fecha, neto, venta_id]);
  return rows[0].id;
}

// Seed helper: liquidación histórica con +ingreso en caja destino (lo que SÍ
// existía pre-TANDA 1) pero SIN egreso en caja-tarjeta.
async function seedLiquidacionHistorica({ fecha, monto, tarjeta = tarjetaId, cajaDest = otraCajaId }) {
  const { rows: tm } = await pool.query(`
    INSERT INTO tarjeta_movimientos
      (metodo_pago_id, fecha, tipo, moneda, monto_bruto, pct, monto_comision, monto_neto, caja_id)
    VALUES ($1, $2, 'liquidacion', 'ARS', $3, 0, 0, $3, $4)
    RETURNING id
  `, [tarjeta, fecha, monto, cajaDest]);
  const tmId = tm[0].id;
  // Ingreso histórico en la caja destino (eso ya existía).
  await pool.query(`
    INSERT INTO caja_movimientos
      (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto)
    VALUES ($1, $2, 'ingreso', $3, $3, 'tarjeta', 'tarjeta_movimientos', $4, 'Liquidación tarjeta histórica')
  `, [cajaDest, fecha, monto, tmId]);
  return tmId;
}

async function resetData() {
  await pool.query('TRUNCATE tarjeta_movimientos, caja_movimientos RESTART IDENTITY CASCADE');
}

describe('backfill-caja-tarjetas (TANDA 2)', () => {
  beforeEach(async () => { await resetData(); });

  it('DRY-RUN: no toca la DB; reporta movs pendientes por tarjeta', async () => {
    await seedCobroHistorico({ fecha: '2026-03-01', neto: 90000 });
    await seedCobroHistorico({ fecha: '2026-03-15', neto: 27000 });

    const result = await runBackfill({ apply: false });
    expect(result.apply).toBe(false);
    expect(result.cobros).toBe(2);
    expect(result.liquidaciones).toBe(0);
    expect(result.porTarjeta).toHaveLength(1);
    expect(result.porTarjeta[0].saldoProyectado).toBe(90000 + 27000);

    // Confirmar que NO se insertaron caja_movimientos.
    const { rows } = await pool.query('SELECT COUNT(*) FROM caja_movimientos');
    expect(parseInt(rows[0].count)).toBe(0);
  });

  it('APPLY: inserta los caja_movimientos y commitea', async () => {
    await seedCobroHistorico({ fecha: '2026-03-01', neto: 50000 });
    const liqId = await seedLiquidacionHistorica({ fecha: '2026-03-10', monto: 30000 });

    const result = await runBackfill({ apply: true });
    expect(result.apply).toBe(true);
    expect(result.cobros).toBe(1);
    expect(result.liquidaciones).toBe(1);

    // +ingreso de 50k en la caja-tarjeta.
    const { rows: ing } = await pool.query(`
      SELECT COUNT(*) FROM caja_movimientos
       WHERE ref_tabla = 'tarjeta_movimientos' AND caja_id = $1 AND tipo = 'ingreso'
    `, [tarjetaId]);
    expect(parseInt(ing[0].count)).toBe(1);
    // −egreso de 30k en la caja-tarjeta.
    const { rows: eg } = await pool.query(`
      SELECT ref_id FROM caja_movimientos
       WHERE ref_tabla = 'tarjeta_movimientos' AND caja_id = $1 AND tipo = 'egreso'
    `, [tarjetaId]);
    expect(eg).toHaveLength(1);
    expect(eg[0].ref_id).toBe(liqId);
  });

  it('idempotencia: correr APPLY 2 veces NO duplica los movs', async () => {
    await seedCobroHistorico({ fecha: '2026-03-01', neto: 10000 });
    await runBackfill({ apply: true });
    const result2 = await runBackfill({ apply: true });
    expect(result2.skipped).toBe(true);
    const { rows } = await pool.query(`
      SELECT COUNT(*) FROM caja_movimientos WHERE ref_tabla = 'tarjeta_movimientos' AND tipo = 'ingreso'
    `);
    expect(parseInt(rows[0].count)).toBe(1);
  });

  it('NO toca cobros que ya tienen su +ingreso (movs post-TANDA 1)', async () => {
    // Cobro que YA tiene su caja_movimiento (simula movs creados por TANDA 1).
    const cId = await seedCobroHistorico({ fecha: '2026-03-01', neto: 20000 });
    await pool.query(`
      INSERT INTO caja_movimientos
        (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto)
      VALUES ($1, '2026-03-01', 'ingreso', 20000, 20000, 'tarjeta', 'tarjeta_movimientos', $2, 'TANDA 1 cobro')
    `, [tarjetaId, cId]);

    // Otro cobro SIN su ingreso (pre-TANDA 1).
    await seedCobroHistorico({ fecha: '2026-03-02', neto: 15000 });

    const result = await runBackfill({ apply: false });
    expect(result.cobros).toBe(1); // solo el segundo
  });

  it('aborta si una tarjeta quedaría con saldo negativo', async () => {
    // Solo liquidación, sin cobros → quedaría negativo.
    await seedLiquidacionHistorica({ fecha: '2026-03-01', monto: 50000 });
    await expect(runBackfill({ apply: true })).rejects.toThrow(/negativ/i);
    // NO se insertó nada.
    const { rows } = await pool.query(`
      SELECT COUNT(*) FROM caja_movimientos WHERE ref_tabla = 'tarjeta_movimientos' AND tipo = 'egreso'
    `);
    expect(parseInt(rows[0].count)).toBe(0);
  });

  it('si no hay tarjetas configuradas, throwea con mensaje guía', async () => {
    // TANDA 4 trazab: capturar ids ANTES de desmarcar — restaurar por id
    // y try/finally garantiza que assertion failure no deje DB con 0 tarjetas.
    const { rows: prev } = await pool.query(
      `SELECT id FROM metodos_pago WHERE es_tarjeta = true`
    );
    const ids = prev.map(r => r.id);
    await pool.query(`UPDATE metodos_pago SET es_tarjeta = false WHERE id = ANY($1)`, [ids]);
    try {
      await expect(runBackfill({ apply: false })).rejects.toThrow(/tarjeta/i);
    } finally {
      await pool.query(`UPDATE metodos_pago SET es_tarjeta = true WHERE id = ANY($1)`, [ids]);
    }
  });
});
