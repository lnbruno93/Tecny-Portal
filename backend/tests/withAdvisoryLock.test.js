/**
 * Tests del helper `withAdvisoryLock`.
 *
 * Garantía: cuando hay múltiples llamadas concurrentes con el mismo lockName,
 * SOLO UNA ejecuta la función. Las otras reciben `{ acquired: false }` y
 * saltan silently. Cuando el job termina, el lock se libera y otro llamado
 * posterior lo puede tomar.
 *
 * Esta protección es crítica para crons que corren en múltiples réplicas
 * (Railway 2 réplicas activas). Sin esto, jobs como `audit_purga` o
 * `invariants_check` corrían 2× cada noche.
 */
const withAdvisoryLock = require('../src/lib/withAdvisoryLock');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;

beforeAll(async () => {
  pool = await setupTestDb();
});
afterAll(async () => { await teardownTestDb(pool); });

describe('withAdvisoryLock', () => {
  it('una sola llamada — ejecuta el job y devuelve acquired:true', async () => {
    let ran = false;
    const result = await withAdvisoryLock('test_lock_single', async () => {
      ran = true;
      return 'done';
    });
    expect(ran).toBe(true);
    expect(result.acquired).toBe(true);
    expect(result.result).toBe('done');
    expect(result.error).toBeUndefined();
  });

  it('dos llamadas concurrentes con MISMO lockName — solo una ejecuta', async () => {
    let ranCount = 0;
    // El job debe tardar un poco para que la segunda llamada llegue mientras
    // la primera está ejecutándose (lock todavía tomado).
    const slowJob = async () => {
      ranCount++;
      await new Promise(resolve => setTimeout(resolve, 200));
      return ranCount;
    };

    const [r1, r2] = await Promise.all([
      withAdvisoryLock('test_lock_concurrent', slowJob),
      withAdvisoryLock('test_lock_concurrent', slowJob),
    ]);

    // Exactamente 1 ejecutó el job (acquired:true), el otro saltó (acquired:false).
    const acquired = [r1, r2].filter(r => r.acquired);
    const skipped = [r1, r2].filter(r => !r.acquired);
    expect(acquired).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(ranCount).toBe(1);
  });

  it('dos llamadas con lockNames DISTINTOS — ambas ejecutan en paralelo', async () => {
    let ranA = 0, ranB = 0;
    const [rA, rB] = await Promise.all([
      withAdvisoryLock('test_lock_distinct_A', async () => { ranA++; }),
      withAdvisoryLock('test_lock_distinct_B', async () => { ranB++; }),
    ]);
    expect(rA.acquired).toBe(true);
    expect(rB.acquired).toBe(true);
    expect(ranA).toBe(1);
    expect(ranB).toBe(1);
  });

  it('después de que termina, el lock se libera y otro llamado lo toma', async () => {
    let firstRan = false, secondRan = false;
    const r1 = await withAdvisoryLock('test_lock_sequential', async () => { firstRan = true; });
    expect(r1.acquired).toBe(true);
    expect(firstRan).toBe(true);

    // Segundo llamado SECUENCIAL (no concurrente) — debe tomar el lock.
    const r2 = await withAdvisoryLock('test_lock_sequential', async () => { secondRan = true; });
    expect(r2.acquired).toBe(true);
    expect(secondRan).toBe(true);
  });

  it('si el job tira error, el lock se libera (no queda zombie)', async () => {
    const r1 = await withAdvisoryLock('test_lock_error', async () => {
      throw new Error('explosión controlada');
    });
    // El helper captura el error y lo devuelve en `error` — no rethrow.
    expect(r1.acquired).toBe(true);
    expect(r1.error).toBeInstanceOf(Error);
    expect(r1.error.message).toBe('explosión controlada');

    // El lock debe estar liberado: segundo llamado lo toma.
    let secondRan = false;
    const r2 = await withAdvisoryLock('test_lock_error', async () => { secondRan = true; });
    expect(r2.acquired).toBe(true);
    expect(secondRan).toBe(true);
  });

  it('valida argumentos — rechaza lockName vacío o fn no-función', async () => {
    await expect(withAdvisoryLock('', async () => {})).rejects.toThrow(/lockName/);
    await expect(withAdvisoryLock(null, async () => {})).rejects.toThrow(/lockName/);
    await expect(withAdvisoryLock('valid', 'not-a-function')).rejects.toThrow(/fn/);
  });
});
