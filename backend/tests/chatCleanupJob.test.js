/**
 * Tests para chatCleanupJob (TANDA 3 #341 + audit 2026-07-06 P1).
 *
 * Cubre:
 *   - Borra rate_limits con window_start > 7 días (retention pre-existente).
 *   - Borra chat_messages > 90 días (audit 2026-07-06 P1).
 *   - Borra chat_conversations vacías > 90d.
 *   - NO borra rate_limits/messages dentro del threshold.
 *   - Return shape: { rate_limits, messages, conversations }.
 *   - No falla si las tablas están vacías.
 *   - startChatCleanupJob no arranca en NODE_ENV=test (returns null).
 */

const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const { runChatCleanup, startChatCleanupJob } = require('../src/jobs/chatCleanupJob');

let pool;

beforeAll(async () => {
  pool = await setupTestDb();
  // chat_cleanup test necesita un user válido como FK. setupTestDb crea
  // testadmin id=1 — lo usamos.
});

afterAll(async () => {
  await pool.query(`TRUNCATE chat_rate_limits RESTART IDENTITY CASCADE`);
  await pool.query(`TRUNCATE chat_messages RESTART IDENTITY CASCADE`);
  await pool.query(`TRUNCATE chat_conversations RESTART IDENTITY CASCADE`);
  await teardownTestDb(pool);
});

beforeEach(async () => {
  await pool.query(`TRUNCATE chat_rate_limits RESTART IDENTITY CASCADE`);
  // chat_messages CASCADE en chat_conversations, así que TRUNCATE de conversations
  // limpia los mensajes tambiénmétomas —simultáneo.
  await pool.query(`TRUNCATE chat_conversations RESTART IDENTITY CASCADE`);
});

describe('chatCleanupJob — runChatCleanup (rate_limits)', () => {
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

    const summary = await runChatCleanup();
    expect(summary.rate_limits).toBe(3);
    expect(summary.messages).toBe(0);
    expect(summary.conversations).toBe(0);

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
    const summary = await runChatCleanup();
    expect(summary.rate_limits).toBe(0);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM chat_rate_limits`
    );
    expect(rows[0].c).toBe(1);
  });

  it('no falla si las tablas están vacías', async () => {
    const summary = await runChatCleanup();
    expect(summary).toEqual({ rate_limits: 0, messages: 0, conversations: 0 });
  });
});

describe('chatCleanupJob — runChatCleanup (messages retention audit 2026-07-06)', () => {
  it('borra chat_messages > 90 días + limpia conversaciones que quedan vacías', async () => {
    // Crear 3 conversaciones:
    //   A) vieja (>90d) con mensajes viejos → mensajes y conv se borran.
    //   B) vieja (>90d) con 1 mensaje viejo + 1 reciente → mensaje viejo se
    //      borra, conv sobrevive por el reciente.
    //   C) reciente con mensajes recientes → nada se borra.
    const convA = await pool.query(
      `INSERT INTO chat_conversations (tenant_id, user_id, created_at, updated_at)
         VALUES (1, 1, NOW() - INTERVAL '100 days', NOW() - INTERVAL '100 days')
         RETURNING id`
    );
    const convB = await pool.query(
      `INSERT INTO chat_conversations (tenant_id, user_id, created_at, updated_at)
         VALUES (1, 1, NOW() - INTERVAL '100 days', NOW() - INTERVAL '5 days')
         RETURNING id`
    );
    const convC = await pool.query(
      `INSERT INTO chat_conversations (tenant_id, user_id, created_at, updated_at)
         VALUES (1, 1, NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 day')
         RETURNING id`
    );
    const idA = convA.rows[0].id;
    const idB = convB.rows[0].id;
    const idC = convC.rows[0].id;

    await pool.query(`
      INSERT INTO chat_messages (conversation_id, tenant_id, role, content, created_at) VALUES
        ($1, 1, 'user', '{"text":"vieja A"}'::jsonb, NOW() - INTERVAL '100 days'),
        ($1, 1, 'assistant', '{"text":"r1"}'::jsonb, NOW() - INTERVAL '99 days'),
        ($2, 1, 'user', '{"text":"vieja B"}'::jsonb, NOW() - INTERVAL '95 days'),
        ($2, 1, 'user', '{"text":"reciente B"}'::jsonb, NOW() - INTERVAL '5 days'),
        ($3, 1, 'user', '{"text":"reciente C"}'::jsonb, NOW() - INTERVAL '2 days')
    `, [idA, idB, idC]);

    const summary = await runChatCleanup();

    // 3 mensajes viejos (>90d): 2 de A + 1 de B.
    expect(summary.messages).toBe(3);
    // 1 conversación vacía + vieja: A. B sobrevive por el mensaje reciente,
    // C sobrevive por ser reciente.
    expect(summary.conversations).toBe(1);

    // Verificar estado final:
    const remaining = await pool.query(
      `SELECT id FROM chat_conversations ORDER BY id`
    );
    expect(remaining.rows.map((r) => Number(r.id)).sort()).toEqual(
      [Number(idB), Number(idC)].sort()
    );

    const messagesLeft = await pool.query(`SELECT COUNT(*)::int AS c FROM chat_messages`);
    expect(messagesLeft.rows[0].c).toBe(2); // reciente B + reciente C
  });

  it('NO borra conversación reciente aunque esté vacía (recién creada, sin mensajes)', async () => {
    // Caso real: user abre modal chat pero cierra sin mandar mensaje.
    await pool.query(
      `INSERT INTO chat_conversations (tenant_id, user_id, created_at, updated_at)
         VALUES (1, 1, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')`
    );
    const summary = await runChatCleanup();
    expect(summary.conversations).toBe(0);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM chat_conversations`);
    expect(rows[0].c).toBe(1);
  });
});

describe('chatCleanupJob — startChatCleanupJob', () => {
  it('returns null en NODE_ENV=test (no programa el job)', () => {
    // Defensive: en tests no queremos un setInterval rondando.
    const handle = startChatCleanupJob({ intervalHours: 24 });
    expect(handle).toBeNull();
  });
});
