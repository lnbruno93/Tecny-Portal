/**
 * Tests del script de backfill (TANDA 2 trazabilidad junio 2026).
 *
 * Cubre:
 *   · DRY-RUN: lista los comprobantes/pagos pendientes sin tocar la DB.
 *   · APPLY: crea los caja_movimientos faltantes, valida saldo final.
 *   · Idempotencia: correr 2 veces no duplica los inserts.
 *   · Guarda contra saldo negativo: aborta sin commit si proyección < 0.
 *   · Edge cases: no toca comprobantes desde ventas, no toca pagos legacy.
 *
 * Los tests usan la función `runBackfill` exportada (no el CLI directo)
 * para poder leer el return value y assertear sin parsear stdout.
 *
 * Silenciamos console.log para no contaminar la salida de jest — el script
 * imprime un reporte humano que no nos interesa en tests.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const { runBackfill } = require('../scripts/backfill-caja-financiera');

let pool, token;
const auth = () => ({ Authorization: `Bearer ${token}` });

// Silenciar el reporte humano del script para no inflar la salida de jest.
let logSpy;
beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { logSpy.mockRestore(); });

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  token = res.body.token;
});

afterAll(async () => { await teardownTestDb(pool); });

// Helper: bypass el endpoint y crear un comprobante "histórico" directo en
// la DB SIN su caja_movimiento (simula el estado pre-TANDA 1).
async function seedComprobanteHistorico({ fecha, cliente, monto_neto, venta_id = null }) {
  const { rows } = await pool.query(`
    INSERT INTO comprobantes (fecha, cliente, monto, monto_financiera, monto_neto, venta_id)
    VALUES ($1, $2, $3, 0, $3, $4)
    RETURNING id
  `, [fecha, cliente, monto_neto, venta_id]);
  return rows[0].id;
}

// Helper: bypass el endpoint y crear un pago "histórico" SIN su egreso FV.
// Sí creamos el ingreso a la caja destino (porque ese sí existía en pagos
// post-junio 2026 sprint USD — lo que faltaba era el egreso desde FV).
async function seedPagoHistorico({ fecha, monto, caja_destino_id }) {
  // Insertar el pago.
  const { rows: pagoRows } = await pool.query(`
    INSERT INTO pagos (fecha, monto, caja_id) VALUES ($1, $2, $3) RETURNING id
  `, [fecha, monto, caja_destino_id]);
  const pagoId = pagoRows[0].id;
  // Insertar el ingreso a la caja destino (lo que ya existía pre-backfill).
  await pool.query(`
    INSERT INTO caja_movimientos
      (caja_id, fecha, tipo, monto, monto_usd, origen, ref_tabla, ref_id, concepto)
    VALUES ($1, $2, 'ingreso', $3, $3, 'financiera', 'pagos', $4, 'Pago histórico')
  `, [caja_destino_id, fecha, monto, pagoId]);
  return pagoId;
}

// Helper: limpiar comprobantes + pagos + caja_movimientos entre tests para
// aislar cada caso. NO toca metodos_pago (la caja FV se preserva).
async function resetData() {
  await pool.query(`TRUNCATE comprobantes, pagos, caja_movimientos RESTART IDENTITY CASCADE`);
}

describe('backfill-caja-financiera (TANDA 2)', () => {
  beforeEach(async () => { await resetData(); });

  it('DRY-RUN: no toca la DB; reporta los movs que se crearían', async () => {
    await seedComprobanteHistorico({ fecha: '2026-03-01', cliente: 'Histórico 1', monto_neto: 50000 });
    await seedComprobanteHistorico({ fecha: '2026-03-15', cliente: 'Histórico 2', monto_neto: 30000 });

    const result = await runBackfill({ apply: false });
    expect(result.apply).toBe(false);
    expect(result.comprobantes).toBe(2);
    expect(result.pagos).toBe(0);
    expect(result.saldoProyectado).toBe(80000); // 0 + 50000 + 30000

    // Confirmar que NO se insertaron caja_movimientos.
    const { rows } = await pool.query('SELECT COUNT(*) FROM caja_movimientos');
    expect(parseInt(rows[0].count)).toBe(0);
  });

  it('APPLY: inserta los caja_movimientos y commitea', async () => {
    const compId1 = await seedComprobanteHistorico({ fecha: '2026-03-01', cliente: 'Acme', monto_neto: 50000 });
    const compId2 = await seedComprobanteHistorico({ fecha: '2026-03-15', cliente: 'Beta', monto_neto: 30000 });

    const result = await runBackfill({ apply: true });
    expect(result.apply).toBe(true);
    expect(result.comprobantes).toBe(2);
    expect(result.saldoFinal).toBe(80000);

    // Confirmar que los movs existen con ref_tabla='comprobantes' y ref_id correcto.
    const { rows } = await pool.query(
      `SELECT ref_id, tipo, monto FROM caja_movimientos
        WHERE ref_tabla = 'comprobantes' AND deleted_at IS NULL ORDER BY ref_id`
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].ref_id).toBe(compId1);
    expect(Number(rows[0].monto)).toBe(50000);
    expect(rows[0].tipo).toBe('ingreso');
    expect(rows[1].ref_id).toBe(compId2);
  });

  it('idempotencia: correr APPLY 2 veces NO duplica los movs', async () => {
    await seedComprobanteHistorico({ fecha: '2026-03-01', cliente: 'Acme', monto_neto: 50000 });
    await runBackfill({ apply: true });

    // 2da corrida: no debería encontrar nada pendiente.
    const result2 = await runBackfill({ apply: true });
    expect(result2.skipped).toBe(true);

    const { rows } = await pool.query(`SELECT COUNT(*) FROM caja_movimientos WHERE ref_tabla = 'comprobantes'`);
    expect(parseInt(rows[0].count)).toBe(1); // sigue 1, no se duplicó
  });

  it('NO toca comprobantes que vienen de ventas (venta_id NOT NULL)', async () => {
    // Crear una venta minimalista para tener un venta_id válido.
    const { rows: vRows } = await pool.query(`
      INSERT INTO ventas (cliente_nombre, fecha, estado, order_id)
      VALUES ('Cliente venta', '2026-03-01', 'acreditado', 'TEST-1') RETURNING id
    `);
    const ventaId = vRows[0].id;
    await seedComprobanteHistorico({ fecha: '2026-03-01', cliente: 'Cliente venta', monto_neto: 99999, venta_id: ventaId });
    // Y un manual independiente.
    await seedComprobanteHistorico({ fecha: '2026-03-02', cliente: 'Manual ok', monto_neto: 11111 });

    const result = await runBackfill({ apply: true });
    // Solo el manual se backfilleó.
    expect(result.comprobantes).toBe(1);
    expect(result.saldoFinal).toBe(11111);
  });

  it('NO toca pagos legacy con caja_id IS NULL', async () => {
    // Pago legacy directo (sin caja_id) — no debe ser detectado.
    await pool.query(`
      INSERT INTO pagos (fecha, monto, caja_id) VALUES ('2026-01-01', 10000, NULL)
    `);
    const result = await runBackfill({ apply: false });
    expect(result.pagos).toBe(0);
  });

  it('aborta y rollback si el saldo proyectado quedaría negativo', async () => {
    // Crear caja destino para el pago.
    const c = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Destino Backfill', moneda: 'ARS', saldo_inicial: 100000 });
    const cajaDest = c.body.id;

    // Pago histórico de 50k SIN comprobantes contraparte — la proyección
    // dejaría la caja FV en -50k.
    await seedPagoHistorico({ fecha: '2026-03-01', monto: 50000, caja_destino_id: cajaDest });

    await expect(runBackfill({ apply: true })).rejects.toThrow(/negativo/i);

    // Confirmar que NO se insertó el egreso (rollback exitoso).
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM caja_movimientos WHERE ref_tabla = 'pagos' AND tipo = 'egreso'`
    );
    expect(parseInt(rows[0].count)).toBe(0);
  });

  it('flag --solo-comprobantes omite los pagos pendientes', async () => {
    const c = await request(app).post('/api/cajas/cajas').set(auth())
      .send({ nombre: 'Caja Destino Solo Comp', moneda: 'ARS' });
    await seedComprobanteHistorico({ fecha: '2026-03-01', cliente: 'C1', monto_neto: 100000 });
    await seedPagoHistorico({ fecha: '2026-03-02', monto: 20000, caja_destino_id: c.body.id });

    const result = await runBackfill({ apply: true, soloComprobantes: true });
    expect(result.comprobantes).toBe(1);
    expect(result.pagos).toBe(0);

    // El pago sigue sin su egreso FV — una segunda corrida sin el flag lo agarra.
    const result2 = await runBackfill({ apply: false });
    expect(result2.pagos).toBe(1);
  });

  it('si no hay caja FV configurada, throwea con mensaje guía', async () => {
    await pool.query(`UPDATE metodos_pago SET es_financiera = false WHERE es_financiera = true`);
    await expect(runBackfill({ apply: false })).rejects.toThrow(/es_financiera|Cajas → Config/i);
    // Restaurar.
    await pool.query(`UPDATE metodos_pago SET es_financiera = true WHERE nombre = 'Pesos Ars | Efectivo'`);
  });
});
