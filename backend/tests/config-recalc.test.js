/**
 * Tests del helper recalcComprobantesFinancieraByTenant.
 *
 * Reportado por primer cliente real (iDeals Ar tenant=12, 2026-06-25):
 *   1. Owner configuró pct_financiera = 3% en Config
 *   2. Cargó una venta con cobro financiero + archivo de comprobante
 *   3. En la sección Comprobantes, monto_financiera mostraba 0 (no se descontó)
 *
 * Root cause confirmado en prod (SELECT * FROM config WHERE tenant_id=12 → 0 filas):
 *   · signup no sembraba fila en `config` para tenants nuevos
 *   · PUT /api/config confiaba en DEFAULT dinámico de tenant_id (que falló silently)
 *   · `syncFinancieraComprobante` lee `SELECT pct_financiera FROM config LIMIT 1` →
 *     0 filas → cae al `|| 0` → cálculo congelado en 0
 *
 * Estos tests cubren el helper de forma AISLADA (no toca config global ni rompe
 * otros suites paralelos). El comportamiento del endpoint PUT /api/config está
 * cubierto implícitamente por los tests existentes de financiera.test.js que
 * setean pct_financiera y verifican que los comprobantes lo usan.
 */
const { recalcComprobantesFinancieraByTenant } = require('../src/lib/financiera');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;
const TEST_CLIENTE_PREFIX = 'RecalcTest_';

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  // Cleanup: borrar SOLO mis filas de prueba para no contaminar otros suites.
  await pool.query(
    `DELETE FROM comprobantes WHERE cliente LIKE $1 || '%'`,
    [TEST_CLIENTE_PREFIX]
  );
  await teardownTestDb(pool);
});

describe('recalcComprobantesFinancieraByTenant — Bug #2 primer cliente real', () => {
  it('recalcula monto_financiera y monto_neto con el nuevo pct', async () => {
    // Insertar comprobante propio con valores congelados en 0 (caso del cliente)
    const { rows } = await pool.query(
      `INSERT INTO comprobantes (fecha, cliente, monto, monto_financiera, monto_neto, tenant_id)
       VALUES ('2026-06-25', $1, 100000, 0, 100000, 1)
       RETURNING id`,
      [TEST_CLIENTE_PREFIX + 'recalc1']
    );
    const compId = rows[0].id;

    // Ejecutar el recalc con 5%
    const count = await recalcComprobantesFinancieraByTenant(pool, 5);
    expect(count).toBeGreaterThanOrEqual(1);

    const { rows: result } = await pool.query(
      'SELECT monto, monto_financiera, monto_neto FROM comprobantes WHERE id = $1',
      [compId]
    );
    expect(Number(result[0].monto)).toBe(100000);
    expect(Number(result[0].monto_financiera)).toBe(5000);
    expect(Number(result[0].monto_neto)).toBe(95000);
  });

  it('caso exacto del cliente iDeals Ar (monto 355000, pct 3%)', async () => {
    const { rows } = await pool.query(
      `INSERT INTO comprobantes (fecha, cliente, monto, monto_financiera, monto_neto, tenant_id)
       VALUES ('2026-06-25', $1, 355000, 0, 355000, 1)
       RETURNING id`,
      [TEST_CLIENTE_PREFIX + 'iDeals']
    );
    const compId = rows[0].id;

    await recalcComprobantesFinancieraByTenant(pool, 3);

    const { rows: result } = await pool.query(
      'SELECT monto_financiera, monto_neto FROM comprobantes WHERE id = $1',
      [compId]
    );
    // 355000 * 0.03 = 10650
    // 355000 - 10650 = 344350
    expect(Number(result[0].monto_financiera)).toBe(10650);
    expect(Number(result[0].monto_neto)).toBe(344350);
  });

  it('NO toca comprobantes soft-deleted', async () => {
    const { rows } = await pool.query(
      `INSERT INTO comprobantes (fecha, cliente, monto, monto_financiera, monto_neto, deleted_at, tenant_id)
       VALUES ('2026-06-25', $1, 50000, 1000, 49000, NOW(), 1)
       RETURNING id`,
      [TEST_CLIENTE_PREFIX + 'deleted']
    );
    const compId = rows[0].id;

    await recalcComprobantesFinancieraByTenant(pool, 10);

    const { rows: result } = await pool.query(
      'SELECT monto_financiera, monto_neto FROM comprobantes WHERE id = $1',
      [compId]
    );
    // Sigue con los valores viejos (pct=2 implícito), porque está soft-deleted
    expect(Number(result[0].monto_financiera)).toBe(1000);
    expect(Number(result[0].monto_neto)).toBe(49000);
  });

  it('pct=0 deja monto_financiera=0 y monto_neto=monto', async () => {
    const { rows } = await pool.query(
      `INSERT INTO comprobantes (fecha, cliente, monto, monto_financiera, monto_neto, tenant_id)
       VALUES ('2026-06-25', $1, 7777, 200, 7577, 1)
       RETURNING id`,
      [TEST_CLIENTE_PREFIX + 'zero']
    );
    const compId = rows[0].id;

    await recalcComprobantesFinancieraByTenant(pool, 0);

    const { rows: result } = await pool.query(
      'SELECT monto, monto_financiera, monto_neto FROM comprobantes WHERE id = $1',
      [compId]
    );
    expect(Number(result[0].monto_financiera)).toBe(0);
    expect(Number(result[0].monto_neto)).toBe(7777);
  });
});
