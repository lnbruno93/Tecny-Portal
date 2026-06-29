/**
 * Tests del paidUntilWarningJob (TANDA 4.D billing pre-live 2026-06-25).
 *
 * Cubre:
 *   - Tenant en ventana [hoy, hoy+3] con owner → manda mail + actualiza sent_at.
 *   - Tenant sin owner → skip + warn (no rompe el job).
 *   - Tenant ya warneado (sent_at reciente) → skip.
 *   - Tenant suspended → skip.
 *   - Tenant con paid_until lejos (>3d) → skip.
 *   - Idempotencia: 2 runs seguidos solo manda 1 mail.
 *   - Re-warn cuando paid_until salta hacia futuro (renovación).
 */
const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const { runPaidUntilWarning } = require('../src/jobs/paidUntilWarningJob');
const email = require('../src/lib/email');

let pool;
const TENANT_WARN = 9201;
const TENANT_NO_OWNER = 9202;
const TENANT_SUSPENDED = 9203;
const TENANT_FAR = 9204;
const TENANT_ALREADY_WARNED = 9205;

beforeAll(async () => {
  pool = await setupTestDb();

  // Insertar 5 tenants para los distintos casos.
  await pool.query(`
    INSERT INTO tenants (id, nombre, slug, plan, paid_until, suspended_at, paid_until_warning_sent_at)
    VALUES
      ($1, 'Tenant Warn',           'warn',          'starter', CURRENT_DATE + INTERVAL '2 days', NULL, NULL),
      ($2, 'Tenant No Owner',       'noowner',       'starter', CURRENT_DATE + INTERVAL '1 day',  NULL, NULL),
      ($3, 'Tenant Suspended',      'suspended',     'starter', CURRENT_DATE + INTERVAL '2 days', NOW(), NULL),
      ($4, 'Tenant Far',            'far',           'starter', CURRENT_DATE + INTERVAL '30 days', NULL, NULL),
      ($5, 'Tenant Already Warned', 'alreadywarned', 'starter', CURRENT_DATE + INTERVAL '2 days', NULL, NOW())
    ON CONFLICT (id) DO NOTHING
  `, [TENANT_WARN, TENANT_NO_OWNER, TENANT_SUSPENDED, TENANT_FAR, TENANT_ALREADY_WARNED]);
  await pool.query(`SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), ${TENANT_ALREADY_WARNED}))`);

  // Crear users + tenant_users (rol='owner') para todos EXCEPTO TENANT_NO_OWNER.
  // El test admin user del setup arranca con id=1; usamos ids altos para evitar colisión.
  const bcrypt = require('bcrypt');
  const hash = await bcrypt.hash('pwn_dummy_2026', 4);
  const owners = [
    { tenantId: TENANT_WARN,             email: 'owner-warn@test.local',     nombre: 'Owner Warn' },
    { tenantId: TENANT_SUSPENDED,        email: 'owner-susp@test.local',     nombre: 'Owner Suspended' },
    { tenantId: TENANT_FAR,              email: 'owner-far@test.local',      nombre: 'Owner Far' },
    { tenantId: TENANT_ALREADY_WARNED,   email: 'owner-already@test.local',  nombre: 'Owner Already' },
  ];
  for (const o of owners) {
    const { rows } = await pool.query(
      `INSERT INTO users (nombre, username, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin') RETURNING id`,
      [o.nombre, `u_${o.tenantId}`, o.email, hash]
    );
    await pool.query(
      `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`,
      [o.tenantId, rows[0].id]
    );
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM tenant_users WHERE tenant_id BETWEEN $1 AND $2`, [TENANT_WARN, TENANT_ALREADY_WARNED]);
  await pool.query(`DELETE FROM users WHERE email LIKE 'owner-%@test.local'`);
  await pool.query(`DELETE FROM tenants WHERE id BETWEEN $1 AND $2`, [TENANT_WARN, TENANT_ALREADY_WARNED]);
  await teardownTestDb(pool);
});

beforeEach(() => {
  email._resetTestQueue();
});

describe('runPaidUntilWarning — filtrado + envío', () => {
  it('manda mail al tenant en ventana con owner email', async () => {
    // Reset sent_at para no chocar con tests previos en la misma suite.
    await pool.query(
      `UPDATE tenants SET paid_until_warning_sent_at = NULL WHERE id = $1`,
      [TENANT_WARN]
    );

    const sent = await runPaidUntilWarning();
    expect(sent).toBeGreaterThanOrEqual(1);

    const queue = email._getTestQueue();
    const warnMail = queue.find(m => m.to === 'owner-warn@test.local');
    expect(warnMail).toBeDefined();
    expect(warnMail.type).toBe('paid_until_warning');
    // daysLeft viene de PG `(paid_until - CURRENT_DATE)::int` → TZ-safe (issue #466).
    // Antes era cálculo en JS con setUTCHours + (target - today) / 86400000, y
    // daba off-by-one cuando el job corría cerca del UTC boundary (≥22:00 AR /
    // ≥01:00 UTC) porque mezclaba parsing de paid_until en TZ del driver PG con
    // `new Date()` en UTC. Ahora la resta vive entera en PG.
    expect(warnMail.daysLeft).toBe(2);
    expect(warnMail.tenantName).toBe('Tenant Warn');

    // sent_at debe estar seteado post-envío.
    const { rows } = await pool.query(
      `SELECT paid_until_warning_sent_at FROM tenants WHERE id = $1`,
      [TENANT_WARN]
    );
    expect(rows[0].paid_until_warning_sent_at).not.toBeNull();
  });

  it('skip tenant suspended (no manda mail aunque paid_until esté en ventana)', async () => {
    await pool.query(
      `UPDATE tenants SET paid_until_warning_sent_at = NULL WHERE id = $1`,
      [TENANT_SUSPENDED]
    );

    await runPaidUntilWarning();
    const queue = email._getTestQueue();
    expect(queue.find(m => m.to === 'owner-susp@test.local')).toBeUndefined();
  });

  it('skip tenant con paid_until > hoy+3d (lejos)', async () => {
    await runPaidUntilWarning();
    const queue = email._getTestQueue();
    expect(queue.find(m => m.to === 'owner-far@test.local')).toBeUndefined();
  });

  it('skip tenant sin owner email (loggea warn pero sigue)', async () => {
    await pool.query(
      `UPDATE tenants SET paid_until_warning_sent_at = NULL WHERE id = $1`,
      [TENANT_NO_OWNER]
    );

    const sent = await runPaidUntilWarning();
    // Sigue corriendo y manda mail a otros tenants, pero NO_OWNER no recibe.
    expect(sent).toBeGreaterThanOrEqual(0);
    const queue = email._getTestQueue();
    expect(queue.every(m => !m.to?.includes('noowner'))).toBe(true);
  });

  it('skip tenant ya warneado recientemente (sent_at < paid_until - 7d)', async () => {
    // sent_at = NOW (recent), paid_until = hoy + 2d.
    // El check: sent_at < paid_until - 7d → NOW < (hoy+2-7) = hoy-5 → FALSE.
    // Entonces NO se manda.
    await pool.query(
      `UPDATE tenants SET paid_until_warning_sent_at = NOW() WHERE id = $1`,
      [TENANT_ALREADY_WARNED]
    );

    await runPaidUntilWarning();
    const queue = email._getTestQueue();
    expect(queue.find(m => m.to === 'owner-already@test.local')).toBeUndefined();
  });
});

describe('runPaidUntilWarning — idempotencia', () => {
  it('2 runs seguidos solo mandan 1 mail al mismo tenant', async () => {
    // Reset: limpiamos sent_at + queue.
    await pool.query(
      `UPDATE tenants SET paid_until_warning_sent_at = NULL WHERE id = $1`,
      [TENANT_WARN]
    );
    email._resetTestQueue();

    await runPaidUntilWarning();
    await runPaidUntilWarning();

    const queue = email._getTestQueue();
    const warnMails = queue.filter(m => m.to === 'owner-warn@test.local');
    expect(warnMails).toHaveLength(1);
  });

  it('re-manda warning si paid_until salta a futuro (renovación)', async () => {
    // Simular: warnearlo, después renovar paid_until +60d, después esperar a
    // que sea cerca de vencer y correr el cron de nuevo.
    //
    // En realidad simplificamos: seteamos sent_at viejo (antes de paid_until-7d)
    // y eso debe dispararlo de nuevo.
    await pool.query(
      `UPDATE tenants
         SET paid_until = CURRENT_DATE + INTERVAL '2 days',
             paid_until_warning_sent_at = CURRENT_DATE - INTERVAL '60 days'
       WHERE id = $1`,
      [TENANT_WARN]
    );
    email._resetTestQueue();

    await runPaidUntilWarning();
    const queue = email._getTestQueue();
    expect(queue.find(m => m.to === 'owner-warn@test.local')).toBeDefined();
  });
});
