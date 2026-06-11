/**
 * Tests del path async de audit() (P-07).
 *
 * Cobre los 6 escenarios del doc de diseño (docs/design/p07-async-audit.md
 * seccion 10) + endpoint stats:
 *
 *   1. Flag OFF (default): audit() inserta directo en audit_logs.
 *      audit_queue queda vacia. → backward compat de los 24+ callers.
 *   2. Flag ON: audit() inserta en audit_queue, NO en audit_logs hasta que
 *      processBatch corre. Despues del batch, la fila aparece en audit_logs
 *      con created_at === enqueued_at (preservacion temporal req #3).
 *   3. In-TX rollback con flag ON: BEGIN + audit() + ROLLBACK → la fila NO
 *      queda en audit_queue. Valida que el SAVEPOINT pattern funcione async.
 *   4. Bulk processing: 250 rows + batchSize=100 → 3 batches (100/100/50)
 *      hasta drain.
 *   5. Concurrent processBatch (SKIP LOCKED): 2 procesos en paralelo no
 *      procesan los mismos rows; total final = total encolado.
 *   6. PII redaction sigue funcionando async: campos sensibles enmascarados
 *      al encolar (no al procesar).
 *   7. Endpoint GET /api/admin/audit-queue-stats: queue_depth correcto,
 *      oldest_enqueued_at consistente con la primera insercion.
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/database');
const audit = require('../src/lib/audit');
const { processBatch } = require('../src/jobs/auditQueueWorker');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool, adminToken;

// Helpers de control del feature flag para este suite.
//
// 2026-06-11: en NODE_ENV=test el bifurcador NO consulta la tabla
// feature_flags (sería un round-trip extra por cada audit() del test, satura
// el pool y rompe suites pesados como invariants/race-conditions). En su
// lugar usa un override de proceso vía `_setAsyncEnabledForTest(value)`.
// Igualmente UPDATEAMOS la tabla por completitud — los tests que verifican
// `/api/admin/audit-queue-stats` leen el flag desde DB.
async function setAsyncFlag(enabled) {
  // UPSERT — setupTestDb TRUNCATEa feature_flags entre tests, así que el
  // UPDATE-only quedaba no-op y el endpoint /api/admin/audit-queue-stats
  // recibía async_enabled=false aunque el override module-local fuera true.
  await pool.query(
    `INSERT INTO feature_flags (name, enabled, description)
       VALUES ('audit_async_enabled', $1, 'P-07 test seed')
     ON CONFLICT (name) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
    [enabled]
  );
  audit._setAsyncEnabledForTest(enabled);
}
async function clearQueueAndLogs() {
  await pool.query('TRUNCATE audit_queue, audit_logs RESTART IDENTITY');
}

beforeAll(async () => {
  pool = await setupTestDb();
  const a = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = a.body.token;
});

afterAll(async () => {
  // Defensivo: restaurar OFF para no contaminar otros suites en watch mode.
  await pool.query(`UPDATE feature_flags SET enabled = false WHERE name = 'audit_async_enabled'`);
  audit._setAsyncEnabledForTest(false);
  audit._clearAsyncCache();
  await teardownTestDb(pool);
});

describe('P-07 async audit', () => {
  beforeEach(async () => {
    await clearQueueAndLogs();
    await setAsyncFlag(false);
  });

  test('flag OFF (default): audit() inserta directo en audit_logs, NO en queue', async () => {
    await audit('ventas', 'INSERT', 1, { despues: { id: 1, total_usd: 100 } });

    const { rows: logs }  = await pool.query('SELECT * FROM audit_logs WHERE tabla = $1', ['ventas']);
    const { rows: queue } = await pool.query('SELECT * FROM audit_queue WHERE tabla = $1', ['ventas']);
    expect(logs).toHaveLength(1);
    expect(queue).toHaveLength(0);
  });

  test('flag ON: audit() inserta en audit_queue, NO en audit_logs hasta el batch', async () => {
    await setAsyncFlag(true);

    const t0 = Date.now();
    await audit('ventas', 'INSERT', 2, { despues: { id: 2, total_usd: 200 } });
    const t1 = Date.now();

    const { rows: queue1 } = await pool.query('SELECT * FROM audit_queue WHERE tabla = $1', ['ventas']);
    const { rows: logs1 }  = await pool.query('SELECT * FROM audit_logs WHERE tabla = $1', ['ventas']);
    expect(queue1).toHaveLength(1);
    expect(logs1).toHaveLength(0);
    // Capturamos enqueued_at — el worker debe preservarlo como created_at.
    const enqueuedAt = queue1[0].enqueued_at;
    expect(enqueuedAt.getTime()).toBeGreaterThanOrEqual(t0 - 10);
    expect(enqueuedAt.getTime()).toBeLessThanOrEqual(t1 + 10);

    // Forzar drain manual (el worker setInterval no corre en NODE_ENV=test).
    const r = await processBatch({ batchSize: 100 });
    expect(r.processed).toBe(1);
    expect(r.drained).toBe(true);

    const { rows: queue2 } = await pool.query('SELECT * FROM audit_queue WHERE tabla = $1', ['ventas']);
    const { rows: logs2 }  = await pool.query('SELECT * FROM audit_logs WHERE tabla = $1', ['ventas']);
    expect(queue2).toHaveLength(0);
    expect(logs2).toHaveLength(1);
    // Preservacion temporal: created_at == enqueued_at (req #3 del doc).
    expect(logs2[0].created_at.toISOString()).toBe(enqueuedAt.toISOString());
    expect(logs2[0].datos_despues.total_usd).toBe(200);
  });

  test('in-TX rollback con flag ON: el audit encolado se revierte con la tx', async () => {
    await setAsyncFlag(true);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await audit(client, 'ventas', 'INSERT', 999, { despues: { id: 999 } });
      // SANITY: la fila esta visible DENTRO de la tx.
      const { rows: inTx } = await client.query('SELECT * FROM audit_queue WHERE registro_id = 999');
      expect(inTx).toHaveLength(1);
      await client.query('ROLLBACK');
    } finally { client.release(); }

    // Post-rollback: NO debe haber fila ni en queue ni en audit_logs.
    const { rows: queue } = await pool.query('SELECT * FROM audit_queue WHERE registro_id = 999');
    const { rows: logs }  = await pool.query('SELECT * FROM audit_logs WHERE registro_id = 999');
    expect(queue).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  test('bulk: 250 rows + batchSize=100 → 3 batches (100/100/50)', async () => {
    await setAsyncFlag(true);

    // Encolamos 250 rows en paralelo.
    await Promise.all(
      Array.from({ length: 250 }, (_, i) =>
        audit('bulk_test', 'INSERT', i + 1, { despues: { id: i + 1 } })
      )
    );

    const { rows: q0 } = await pool.query('SELECT COUNT(*)::int AS n FROM audit_queue');
    expect(q0[0].n).toBe(250);

    const b1 = await processBatch({ batchSize: 100 });
    expect(b1.processed).toBe(100);
    expect(b1.drained).toBe(false);

    const b2 = await processBatch({ batchSize: 100 });
    expect(b2.processed).toBe(100);
    expect(b2.drained).toBe(false);

    const b3 = await processBatch({ batchSize: 100 });
    expect(b3.processed).toBe(50);
    expect(b3.drained).toBe(true);

    const { rows: qF } = await pool.query('SELECT COUNT(*)::int AS n FROM audit_queue');
    const { rows: lF } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE tabla = 'bulk_test'`
    );
    expect(qF[0].n).toBe(0);
    expect(lF[0].n).toBe(250);
  });

  test('SKIP LOCKED: dos processBatch en paralelo NO procesan los mismos rows', async () => {
    await setAsyncFlag(true);

    // 50 rows encolados.
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        audit('skip_test', 'INSERT', i + 1, { despues: { id: i + 1 } })
      )
    );

    // 2 batches en paralelo, batchSize=25 cada uno (total 50, exacto).
    const [r1, r2] = await Promise.all([
      processBatch({ batchSize: 25 }),
      processBatch({ batchSize: 25 }),
    ]);
    // La suma debe ser exactamente 50 (cada row procesado 1 vez sola).
    expect(r1.processed + r2.processed).toBe(50);

    const { rows: qF } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_queue WHERE tabla = 'skip_test'`
    );
    const { rows: lF } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE tabla = 'skip_test'`
    );
    expect(qF[0].n).toBe(0);
    expect(lF[0].n).toBe(50); // sin duplicados
  });

  test('PII redaction funciona en path async (campos sensibles enmascarados al encolar)', async () => {
    await setAsyncFlag(true);

    await audit('clientes_cc', 'UPDATE', 1, {
      antes: { id: 1, telefono: '1155555555', email: 'juan.perez@example.com', password: 'sekret' },
      despues: { id: 1, telefono: '1166666666', email: 'maria.lopez@example.com' },
    });

    // En la queue ya debe estar redacted (redactPII corre antes del INSERT).
    const { rows: q } = await pool.query('SELECT * FROM audit_queue WHERE tabla = $1', ['clientes_cc']);
    expect(q).toHaveLength(1);
    expect(q[0].datos_antes.telefono).toBe('(redactado)');
    expect(q[0].datos_antes.email).toBe('jua***@example.com');
    expect(q[0].datos_antes.password).toBeUndefined(); // ALWAYS_REMOVE
    expect(q[0].datos_despues.telefono).toBe('(redactado)');

    // Drain y verificar que llega redacted a audit_logs.
    await processBatch({ batchSize: 10 });
    const { rows: l } = await pool.query('SELECT * FROM audit_logs WHERE tabla = $1', ['clientes_cc']);
    expect(l).toHaveLength(1);
    expect(l[0].datos_antes.telefono).toBe('(redactado)');
    expect(l[0].datos_antes.password).toBeUndefined();
  });

  test('GET /api/admin/audit-queue-stats devuelve depth + flag + oldest', async () => {
    await setAsyncFlag(true);

    // Stats con queue vacia: depth=0, oldest=null, async_enabled=true.
    const r0 = await request(app)
      .get('/api/admin/audit-queue-stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r0.status).toBe(200);
    expect(r0.body.queue_depth).toBe(0);
    expect(r0.body.oldest_enqueued_at).toBeNull();
    expect(r0.body.async_enabled).toBe(true);
    expect(r0.body.rows_with_errors).toBe(0);

    // Encolamos 3 rows.
    await audit('stats_test', 'INSERT', 1, { despues: { id: 1 } });
    await audit('stats_test', 'INSERT', 2, { despues: { id: 2 } });
    await audit('stats_test', 'INSERT', 3, { despues: { id: 3 } });

    const r1 = await request(app)
      .get('/api/admin/audit-queue-stats')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(r1.status).toBe(200);
    expect(r1.body.queue_depth).toBe(3);
    expect(r1.body.oldest_enqueued_at).not.toBeNull();
    expect(r1.body.newest_enqueued_at).not.toBeNull();
    expect(r1.body.async_enabled).toBe(true);

    // oldest <= newest (regla basica).
    const oldest = new Date(r1.body.oldest_enqueued_at).getTime();
    const newest = new Date(r1.body.newest_enqueued_at).getTime();
    expect(oldest).toBeLessThanOrEqual(newest);
  });
});
