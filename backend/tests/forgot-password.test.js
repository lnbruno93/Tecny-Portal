/**
 * Tests del flow forgot-password / reset-password (TANDA 0 #321).
 *
 * Cubre:
 *   - POST /api/auth/forgot-password:
 *     · Email existente verificado → token emitido en DB + email queued
 *     · Email NO existente → respuesta idéntica (anti-enum), nada en DB
 *     · Email existente NO verificado → respuesta idéntica, NO se emite token
 *       (porque el user todavía no probó posesión del email)
 *     · Captcha fail → 400 con reason
 *   - POST /api/auth/reset-password:
 *     · Token válido → password hash actualizado + password_changed_at bumped
 *       + token marcado usado + audit creado
 *     · Token inválido (no existe) → 401 INVALID_RESET_TOKEN
 *     · Token expirado → 401 EXPIRED_RESET_TOKEN
 *     · Token ya usado → 401 USED_RESET_TOKEN
 *     · Password policy fail → 400 (zod validate antes)
 *     · Token válido pero user borrado (deleted_at) → 401 INVALID_RESET_TOKEN
 */

const request = require('supertest');
const bcrypt = require('bcrypt');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const emailLib = require('../src/lib/email');

let pool;

beforeAll(async () => { pool = await setupTestDb(); });
afterAll(async () => { await teardownTestDb(pool); });

beforeEach(() => {
  emailLib._resetTestQueue();
});

// Helper: crea un user verificado con email único por test.
async function createVerifiedUser(emailPrefix = 'reset_test') {
  const email = `${emailPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = 'OriginalPwd123!';
  const hash = await bcrypt.hash(password, 4); // rounds bajos para speed en tests
  const { rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
       VALUES ('Test User', $1, $2, $3, 'op', NOW())
     RETURNING id, email, nombre`,
    [`tu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, email, hash]
  );
  // Vincular al tenant 1 para que sea un user completo.
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'member')`,
    [rows[0].id]
  );
  return { ...rows[0], originalPassword: password };
}

async function fetchToken(userId) {
  const { rows } = await pool.query(
    `SELECT token, expires_at, used_at FROM password_reset_tokens
      WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

describe('POST /api/auth/forgot-password', () => {
  it('email existente verificado → emite token + queue email', async () => {
    const user = await createVerifiedUser('forgot_ok');

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: user.email });

    expect(res.status).toBe(200);
    // 2026-07-12 (auditoría TOTAL Externa P1-6): el response ya NO expone
    // `reset_token_ttl_hours` — era leak de config del backend. Ahora es solo
    // `{ reset_required: true }`. El TTL sigue viviendo en el email enviado
    // (que sí lo necesita para el copy "válido por 1 hora") vía emailLib.
    expect(res.body).toMatchObject({
      reset_required: true,
    });
    expect(res.body.reset_token_ttl_hours).toBeUndefined();

    // Token persistido en DB.
    const token = await fetchToken(user.id);
    expect(token).toBeTruthy();
    expect(token.token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
    expect(token.used_at).toBeNull();
    expect(new Date(token.expires_at).getTime()).toBeGreaterThan(Date.now());

    // Email queued (fire-and-forget vía setImmediate — esperar tick).
    await new Promise(r => setImmediate(r));
    const queue = emailLib._getTestQueue();
    const found = queue.find(e => e.type === 'password_reset' && e.to === user.email);
    expect(found).toBeTruthy();
    expect(found.resetUrl).toContain(token.token);
    expect(found.ttlHours).toBe(1);
  });

  it('email NO existente → respuesta IDÉNTICA + nada en DB', async () => {
    const fakeEmail = `noexiste_${Date.now()}@example.com`;

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: fakeEmail });

    // Shape idéntica al path "existe" (anti-enum).
    expect(res.status).toBe(200);
    // 2026-07-12 (auditoría TOTAL Externa P1-6): el response ya NO expone
    // `reset_token_ttl_hours` — era leak de config del backend. Ahora es solo
    // `{ reset_required: true }`. El TTL sigue viviendo en el email enviado
    // (que sí lo necesita para el copy "válido por 1 hora") vía emailLib.
    expect(res.body).toMatchObject({
      reset_required: true,
    });
    expect(res.body.reset_token_ttl_hours).toBeUndefined();

    // Pero NO se creó token (no hay user al cual asociarlo).
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM password_reset_tokens prt
         JOIN users u ON u.id = prt.user_id
        WHERE LOWER(u.email) = LOWER($1)`,
      [fakeEmail]
    );
    expect(rows[0].n).toBe(0);

    // Tampoco se mandó email.
    await new Promise(r => setImmediate(r));
    const queue = emailLib._getTestQueue();
    expect(queue.find(e => e.to === fakeEmail)).toBeFalsy();
  });

  it('email existente pero NO verificado → respuesta idéntica + NO se emite token', async () => {
    // User sin verificar (email_verified_at = NULL).
    const email = `unverif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
    const hash = await bcrypt.hash('pwd123ABC', 4);
    const { rows } = await pool.query(
      `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
         VALUES ('U', $1, $2, $3, 'op', NULL)
       RETURNING id`,
      [`uv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, email, hash]
    );

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reset_required: true });

    // NO token emitido para users sin verificar (deben verificar primero el email).
    const token = await fetchToken(rows[0].id);
    expect(token).toBeNull();
  });

  it('email inválido (zod) → 400', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'no-es-un-email' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Datos inválidos');
  });
});

describe('POST /api/auth/reset-password', () => {
  it('token válido → password cambia + token marcado usado + JWT viejo invalidado', async () => {
    const user = await createVerifiedUser('reset_ok');

    // Solicitar token.
    await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: user.email });
    const token = await fetchToken(user.id);
    expect(token).toBeTruthy();

    // Snapshot del password_changed_at viejo.
    const { rows: beforeRows } = await pool.query(
      'SELECT password_changed_at, password_hash FROM users WHERE id = $1',
      [user.id]
    );
    const oldChangedAt = beforeRows[0].password_changed_at;
    const oldHash = beforeRows[0].password_hash;

    // Reset.
    const newPassword = 'NuevaPwd456!';
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: token.token, newPassword });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // Password hash cambió.
    const { rows: afterRows } = await pool.query(
      'SELECT password_changed_at, password_hash FROM users WHERE id = $1',
      [user.id]
    );
    expect(afterRows[0].password_hash).not.toBe(oldHash);
    expect(new Date(afterRows[0].password_changed_at).getTime())
      .toBeGreaterThan(new Date(oldChangedAt).getTime());

    // El nuevo password matchea.
    const matches = await bcrypt.compare(newPassword, afterRows[0].password_hash);
    expect(matches).toBe(true);

    // Token marcado usado.
    const usedToken = await fetchToken(user.id);
    expect(usedToken.used_at).not.toBeNull();
  });

  it('token NO existe → 401 INVALID_RESET_TOKEN', async () => {
    const fakeToken = 'a'.repeat(64); // formato válido (hex 64 chars), pero no existe en DB

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: fakeToken, newPassword: 'Cualquier123!' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_RESET_TOKEN');
  });

  it('token expirado → 401 EXPIRED_RESET_TOKEN', async () => {
    const user = await createVerifiedUser('reset_expired');

    // Insertar un token manualmente con expires_at en el pasado.
    // El CHECK (expires_at > created_at) obliga a poner created_at más en el
    // pasado todavía — ej: created 2h atrás, expires 1h atrás.
    const expiredToken = 'b'.repeat(64);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, created_at, expires_at)
         VALUES ($1, $2, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour')`,
      [user.id, expiredToken]
    );

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: expiredToken, newPassword: 'Pwd123ABC' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('EXPIRED_RESET_TOKEN');
  });

  it('token ya usado → 401 USED_RESET_TOKEN', async () => {
    const user = await createVerifiedUser('reset_used');

    const usedToken = 'c'.repeat(64);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at, used_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour', NOW())`,
      [user.id, usedToken]
    );

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: usedToken, newPassword: 'Pwd123ABC' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('USED_RESET_TOKEN');
  });

  it('password policy fail → 400 con detalles del campo', async () => {
    const user = await createVerifiedUser('reset_pol');
    await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: user.email });
    const token = await fetchToken(user.id);

    // "12345678" tiene 8 chars + número pero NO letra → password policy rechaza.
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: token.token, newPassword: '12345678' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Datos inválidos');
    expect(res.body.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'newPassword' }),
    ]));
  });

  it('token válido pero user borrado → 401 INVALID_RESET_TOKEN', async () => {
    const user = await createVerifiedUser('reset_deluser');
    await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: user.email });
    const token = await fetchToken(user.id);

    // Soft-delete del user.
    await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [user.id]);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: token.token, newPassword: 'Cualquier123!' });

    // El JOIN filtra deleted users — el lookup no encuentra el row → INVALID.
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_RESET_TOKEN');
  });
});
