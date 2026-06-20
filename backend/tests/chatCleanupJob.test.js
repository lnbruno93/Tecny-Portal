/**
 * Tests para chatCleanupJob (TANDA 3 #341).
 *
 * Cubre:
 *   - Borra filas con window_start > 7 días.
 *   - NO borra filas con window_start <= 7 días (el rate-limit vivo).
 *   - Devuelve rowCount correcto.
 *   - No falla si la tabla está vacía.
 *   - startChatCleanupJob no arranca en NODE_ENV=test (returns null).
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const { runChatCleanup, startChatCleanupJob } = require('../src/jobs/chatCleanupJob');

let pool;

beforeAll(async () => {
  pool = await setupTestDb();
  // chat_cleanup test necesita un user válido como FK (chat_rate_limits.user_id
  // REFERENCES users(id)). El setupTestDb crea testadmin id=1 — lo usamos.
});

afterAll(async () => {
  await pool.query(`TRUNCATE chat_rate_limits RESTART IDENTITY CASCADE`);
  await teardownTestDb(pool);
});

beforeEach(async () => {
  await pool.query(`TRUNCATE chat_rate_limits RESTART IDENTITY CASCADE`);
});

describe('chatCleanupJob — runChatCleanup', () => {
  it('borra filas con window_start > 7 días', async () => {
    // Sembrar 3 filas viejas (8, 10, 30 días) y 2 vivas (1, 6 días).
    await pool.query(`
      INSERT INTO chat_rate_limits (tenant_id, user_id, window_start, messages) VALUES
        (1, 1, NOW() - INTERVAL '8 days', 5),
        (1, 1, NOW() - INTERVAL '10 days', 3),
        (1, 1, NOW() - INTERVAL '30 days', 1),
        (1, 1, NOW() - INTERVAL '1 day', 7),
        (1, 1, NOW() - INTERVAL '6 days', 2)
    `);

    const rowCount = await runChatCleanup();
    expect(rowCount).toBe(3);

    // Verificamos que quedaron las vivas
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM chat_rate_limits WHERE user_id = 1`
    );
    expect(rows[0].c).toBe(2);
  });

  it('NO borra fila exactamente en el boundary de 7 días', async () => {
    // 6.99 días: NO debe borrarse (todavía dentro del bucket)
    await pool.query(`
      INSERT INTO chat_rate_limits (tenant_id, user_id, window_start, messages) VALUES
        (1, 1, NOW() - INTERVAL '6 days 23 hours', 1)
    `);
    const rowCount = await runChatCleanup();
    expect(rowCount).toBe(0);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM chat_rate_limits`
    );
    expect(rows[0].c).toBe(1);
  });

  it('no falla si la tabla está vacía', async () => {
    const rowCount = await runChatCleanup();
    expect(rowCount).toBe(0);
  });
});

describe('chatCleanupJob — startChatCleanupJob', () => {
  it('returns null en NODE_ENV=test (no programa el job)', () => {
    // Defensive: en tests no queremos un setInterval rondando.
    const handle = startChatCleanupJob({ intervalHours: 24 });
    expect(handle).toBeNull();
  });
});
