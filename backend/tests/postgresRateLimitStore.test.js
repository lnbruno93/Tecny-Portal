/**
 * Tests del PostgresRateLimitStore — store compartido entre réplicas para
 * express-rate-limit (P1 auditoría 2026-06).
 *
 * Verifica:
 *   - increment: contador atómico que se resetea cuando expira el window.
 *   - decrement: -hits sin tocar expires_at.
 *   - resetKey: DELETE de un key específico.
 *   - cleanup: borra solo las filas con expires_at < NOW().
 *   - Aislamiento por prefix (varios limiters comparten DB).
 *   - Comportamiento concurrente (race en increment).
 */
const PostgresRateLimitStore = require('../src/lib/postgresRateLimitStore');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;

beforeAll(async () => { pool = await setupTestDb(); });
afterAll(async () => { await teardownTestDb(pool); });

// Limpiamos la tabla entre tests para que cada uno arranque desde cero.
beforeEach(async () => {
  await pool.query('DELETE FROM rate_limit_entries');
});

function makeStore(opts = {}) {
  const s = new PostgresRateLimitStore({ db: pool, ...opts });
  s.init({ windowMs: opts.windowMs || 60_000 });
  return s;
}

describe('PostgresRateLimitStore — increment', () => {
  it('primer increment: hits=1, resetTime ~now+windowMs', async () => {
    const store = makeStore({ windowMs: 10_000 });
    const t0 = Date.now();
    const r = await store.increment('ip:127.0.0.1');
    expect(r.totalHits).toBe(1);
    expect(r.resetTime).toBeInstanceOf(Date);
    const expectedReset = t0 + 10_000;
    expect(Math.abs(r.resetTime.getTime() - expectedReset)).toBeLessThan(2_000);
  });

  it('increments sucesivos: hits crece, resetTime estable', async () => {
    const store = makeStore({ windowMs: 60_000 });
    const r1 = await store.increment('client-a');
    const r2 = await store.increment('client-a');
    const r3 = await store.increment('client-a');
    expect(r1.totalHits).toBe(1);
    expect(r2.totalHits).toBe(2);
    expect(r3.totalHits).toBe(3);
    // resetTime no cambia durante el window — solo se setea en el primer hit.
    expect(r2.resetTime.getTime()).toBe(r1.resetTime.getTime());
    expect(r3.resetTime.getTime()).toBe(r1.resetTime.getTime());
  });

  it('keys distintos: contadores independientes', async () => {
    const store = makeStore();
    await store.increment('client-a');
    await store.increment('client-a');
    const rB = await store.increment('client-b');
    expect(rB.totalHits).toBe(1);
  });

  it('window expirado: hits resetea a 1, resetTime se renueva', async () => {
    const store = makeStore({ windowMs: 60_000 });
    await store.increment('client-x');
    // Simular window expirado: forzar expires_at al pasado.
    await pool.query(
      `UPDATE rate_limit_entries SET expires_at = NOW() - INTERVAL '1 minute' WHERE key = $1`,
      ['client-x']
    );
    const r = await store.increment('client-x');
    expect(r.totalHits).toBe(1); // reset
    expect(r.resetTime.getTime()).toBeGreaterThan(Date.now() + 30_000); // ~60s en el futuro
  });

  it('concurrent increments del MISMO key: cada uno suma 1 sin perder', async () => {
    const store = makeStore({ windowMs: 60_000 });
    // Key único por test run para evitar interferencia con datos residuales
    // de otras suites que comparten la misma tabla rate_limit_entries.
    const uniqueKey = `concurrent-key-${Date.now()}-${Math.random()}`;
    // 5 increments concurrentes — bajo a propósito para no agotar el pool de
    // conexiones (max=20) cuando esto corre en coverage mode junto a otras
    // suites. La invariante (totalHits monotónicos sin gaps) se prueba igual
    // con 5 que con 10.
    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () => store.increment(uniqueKey))
    );
    const hits = results.map(r => r.totalHits).sort((a, b) => a - b);
    expect(hits).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('PostgresRateLimitStore — decrement', () => {
  it('decrement reduce hits sin tocar expires_at', async () => {
    const store = makeStore({ windowMs: 60_000 });
    await store.increment('client-d');
    await store.increment('client-d');
    const beforeRow = (await pool.query('SELECT * FROM rate_limit_entries WHERE key = $1', ['client-d'])).rows[0];

    await store.decrement('client-d');
    const afterRow = (await pool.query('SELECT * FROM rate_limit_entries WHERE key = $1', ['client-d'])).rows[0];
    expect(afterRow.hits).toBe(1);
    expect(afterRow.expires_at.getTime()).toBe(beforeRow.expires_at.getTime());
  });

  it('decrement nunca lleva hits debajo de 0', async () => {
    const store = makeStore();
    await store.increment('client-floor');
    await store.decrement('client-floor');
    await store.decrement('client-floor');
    await store.decrement('client-floor');
    const row = (await pool.query('SELECT hits FROM rate_limit_entries WHERE key = $1', ['client-floor'])).rows[0];
    expect(row.hits).toBe(0);
  });
});

describe('PostgresRateLimitStore — resetKey + cleanup', () => {
  it('resetKey borra la fila del key indicado, deja otros intactos', async () => {
    const store = makeStore();
    await store.increment('keep-me');
    await store.increment('remove-me');
    await store.resetKey('remove-me');
    const { rows } = await pool.query('SELECT key FROM rate_limit_entries ORDER BY key');
    expect(rows.map(r => r.key)).toEqual(['keep-me']);
  });

  it('cleanup borra solo las filas con expires_at < NOW()', async () => {
    const store = makeStore({ windowMs: 60_000 });
    await store.increment('current');
    await store.increment('expired-a');
    await store.increment('expired-b');
    await pool.query(
      `UPDATE rate_limit_entries SET expires_at = NOW() - INTERVAL '1 hour' WHERE key IN ('expired-a', 'expired-b')`
    );
    const deleted = await store.cleanup();
    expect(deleted).toBe(2);
    const { rows } = await pool.query('SELECT key FROM rate_limit_entries ORDER BY key');
    expect(rows.map(r => r.key)).toEqual(['current']);
  });
});

describe('PostgresRateLimitStore — prefix isolation', () => {
  it('mismo key con prefixes distintos = contadores independientes', async () => {
    const login = new PostgresRateLimitStore({ db: pool, prefix: 'login' });
    login.init({ windowMs: 60_000 });
    const twoFa = new PostgresRateLimitStore({ db: pool, prefix: '2fa' });
    twoFa.init({ windowMs: 60_000 });

    await login.increment('user-1');
    await login.increment('user-1');
    const r = await twoFa.increment('user-1');
    // El counter de 2fa parte de 0, no se contamina con los 2 del login.
    expect(r.totalHits).toBe(1);
  });
});

describe('PostgresRateLimitStore — localKeys flag', () => {
  it('localKeys debe ser false (señal de store compartido al middleware)', () => {
    const store = new PostgresRateLimitStore({ db: pool });
    expect(store.localKeys).toBe(false);
  });
});
