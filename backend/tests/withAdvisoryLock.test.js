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

// ─────────────────────────────────────────────────────────────────────────────
// Errores transitorios (Sentry 2026-07-05 issues #Z + #M).
// El worker de audit corre cada 2s → si el pool DB se satura, `db.connect()`
// tira "Connection terminated due to connection timeout". Antes eso propagaba
// → captureException a Sentry cada 2s → 15 events acumulados. Ahora se
// clasifica como transitorio, no propaga, el próximo tick retryea.
// ─────────────────────────────────────────────────────────────────────────────
describe('withAdvisoryLock — errores transitorios', () => {
  const { isTransientDbError } = withAdvisoryLock;
  const db = require('../src/config/database');

  describe('isTransientDbError (pure)', () => {
    it('acepta los mensajes que ve el driver de pg', () => {
      expect(isTransientDbError(new Error('Connection terminated due to connection timeout'))).toBe(true);
      expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
      expect(isTransientDbError(new Error('Query read timeout'))).toBe(true);
      expect(isTransientDbError(new Error('timeout expired'))).toBe(true);
      expect(isTransientDbError(new Error('the pool is draining'))).toBe(true);
      expect(isTransientDbError(new Error('connect ETIMEDOUT 10.0.0.1:5432'))).toBe(true);
      expect(isTransientDbError(new Error('read ECONNRESET'))).toBe(true);
    });

    it('acepta SQLSTATE codes de conexión', () => {
      // Los códigos vienen sin mensaje matcheable — solo el err.code identifica.
      const admin = Object.assign(new Error('server going down'), { code: '57P01' });
      const crash = Object.assign(new Error('sql-y'), { code: '57P02' });
      const connFail = Object.assign(new Error('nope'), { code: '08006' });
      expect(isTransientDbError(admin)).toBe(true);
      expect(isTransientDbError(crash)).toBe(true);
      expect(isTransientDbError(connFail)).toBe(true);
    });

    it('rechaza errores reales que NO son transitorios', () => {
      expect(isTransientDbError(new Error('bug: undefined is not a function'))).toBe(false);
      expect(isTransientDbError(new Error('duplicate key value violates unique constraint'))).toBe(false);
      // Constraint violation code
      const dupe = Object.assign(new Error('dupe'), { code: '23505' });
      expect(isTransientDbError(dupe)).toBe(false);
      expect(isTransientDbError(null)).toBe(false);
      expect(isTransientDbError(undefined)).toBe(false);
      expect(isTransientDbError('string, not an Error')).toBe(false);
    });
  });

  describe('withAdvisoryLock frente a fallos transitorios', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('devuelve { transient:true } cuando db.connect() falla con connection timeout', async () => {
      // Simulamos pool saturado: el connect() rechaza con el error exacto que
      // vimos en Sentry (#M — 10 events del audit_queue_worker).
      const err = new Error('Connection terminated due to connection timeout');
      jest.spyOn(db, 'connect').mockRejectedValueOnce(err);

      let jobRan = false;
      const r = await withAdvisoryLock('transient_test_connect', async () => { jobRan = true; });

      expect(r.acquired).toBe(false);
      expect(r.transient).toBe(true);
      expect(r.error).toBe(err);
      expect(jobRan).toBe(false);
    });

    it('devuelve { transient:true } cuando la query de try_lock falla con query timeout', async () => {
      // El connect() funciona, pero el pg_try_advisory_lock se corta por
      // statement_timeout (#Z — 5 events "Query read timeout").
      const err = new Error('Query read timeout');
      const realClient = await db.connect();
      const queryStub = jest.spyOn(realClient, 'query').mockRejectedValueOnce(err);
      jest.spyOn(db, 'connect').mockResolvedValueOnce(realClient);

      let jobRan = false;
      const r = await withAdvisoryLock('transient_test_query', async () => { jobRan = true; });

      expect(r.acquired).toBe(false);
      expect(r.transient).toBe(true);
      expect(r.error).toBe(err);
      expect(jobRan).toBe(false);
      expect(queryStub).toHaveBeenCalled();
      // Cleanup: el client se libera en el finally.
      // Nota: liberar dos veces es no-op — el finally del helper ya lo hizo.
    });

    it('propaga (throw) cuando el error NO es transitorio', async () => {
      const bug = new Error('bug real en config del pool');
      jest.spyOn(db, 'connect').mockRejectedValueOnce(bug);

      // Error no-transitorio → sigue propagando como antes. El caller decide
      // si captureException a Sentry.
      await expect(
        withAdvisoryLock('non_transient_test', async () => {})
      ).rejects.toThrow('bug real en config del pool');
    });
  });
});
