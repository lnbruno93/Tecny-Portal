/**
 * Tests del job de cleanup de email_verification_tokens (TANDA 2.5).
 *
 * Casos cubiertos:
 *   - Tokens usados con `used_at > 7 días`: SE BORRAN.
 *   - Tokens usados con `used_at < 7 días`: NO se borran (ventana de gracia).
 *   - Tokens expirados (`expires_at < NOW() - 1 día`): SE BORRAN aunque no estén usados.
 *   - Tokens vigentes (no usados, no expirados): NO se borran.
 *   - El job no rompe si no hay filas para borrar (returns 0).
 */
const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const { runEmailTokensCleanup } = require('../src/jobs/emailTokensCleanupJob');

let pool;

beforeAll(async () => { pool = await setupTestDb(); });
afterAll(async () => { await teardownTestDb(pool); });

beforeEach(async () => {
  // Limpia la tabla antes de cada test para no contaminar.
  await pool.query('DELETE FROM email_verification_tokens');
});

// Helper: crea un user fresco para FK del token.
async function makeUser(idx) {
  const { rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role)
       VALUES ('Cleanup ' || $1, 'cleanup_' || $1 || '_' || extract(epoch from now())::bigint,
               'cleanup_' || $1 || '_' || extract(epoch from now())::bigint || '@test.local',
               'fake_hash', 'op')
     RETURNING id`,
    [idx]
  );
  return rows[0].id;
}

describe('emailTokensCleanupJob.runEmailTokensCleanup', () => {
  it('borra tokens usados con used_at > 7 días', async () => {
    const uid = await makeUser('used_old');
    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at, used_at, created_at)
         VALUES ($1, $2, NOW() - INTERVAL '7 days', NOW() - INTERVAL '8 days', NOW() - INTERVAL '10 days')`,
      [uid, 'a'.repeat(64)]
    );
    const rowCount = await runEmailTokensCleanup();
    expect(rowCount).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM email_verification_tokens WHERE user_id = $1', [uid]);
    expect(rows[0].c).toBe(0);
  });

  it('NO borra tokens usados con used_at < 7 días (ventana de gracia)', async () => {
    const uid = await makeUser('used_recent');
    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at, used_at, created_at)
         VALUES ($1, $2, NOW() + INTERVAL '23 hours', NOW() - INTERVAL '2 days', NOW() - INTERVAL '3 days')`,
      [uid, 'b'.repeat(64)]
    );
    await runEmailTokensCleanup();
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM email_verification_tokens WHERE user_id = $1', [uid]);
    expect(rows[0].c).toBe(1);
  });

  it('borra tokens expirados > 1 día aunque no estén usados', async () => {
    const uid = await makeUser('expired');
    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at, used_at, created_at)
         VALUES ($1, $2, NOW() - INTERVAL '2 days', NULL, NOW() - INTERVAL '3 days')`,
      [uid, 'c'.repeat(64)]
    );
    const rowCount = await runEmailTokensCleanup();
    expect(rowCount).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM email_verification_tokens WHERE user_id = $1', [uid]);
    expect(rows[0].c).toBe(0);
  });

  it('NO borra tokens vigentes (no usados, no expirados)', async () => {
    const uid = await makeUser('valid');
    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token, expires_at, used_at, created_at)
         VALUES ($1, $2, NOW() + INTERVAL '23 hours', NULL, NOW() - INTERVAL '1 hour')`,
      [uid, 'd'.repeat(64)]
    );
    await runEmailTokensCleanup();
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM email_verification_tokens WHERE user_id = $1', [uid]);
    expect(rows[0].c).toBe(1);
  });

  it('returns 0 si no hay filas para borrar (no-op)', async () => {
    const rowCount = await runEmailTokensCleanup();
    expect(rowCount).toBe(0);
  });
});
