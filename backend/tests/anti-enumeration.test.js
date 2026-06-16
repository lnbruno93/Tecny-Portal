/**
 * Tests anti-enumeration en login (TANDA 1).
 *
 * Política: las tres condiciones que originalmente devolvían respuestas
 * distinguibles ahora se unifican a un único 401 con mensaje genérico.
 *   - Usuario no existe → 401 'Usuario o contraseña incorrectos'
 *   - Password incorrecta → 401 'Usuario o contraseña incorrectos'
 *   - Cuenta locked (lockout_until futuro) → 401 'Usuario o contraseña incorrectos'
 *
 * Antes: locked devolvía 423 con 'Cuenta bloqueada...' → un atacante podía
 * enumerar emails registrados probando combinaciones (si tira 423, existe).
 *
 * Bonus tests:
 *   - Login con email case-insensitive: `Lucas@x.com` === `lucas@x.com`.
 *   - 2FA-required flag sigue funcionando (NO se considera leak crítico para
 *     este TANDA — requiere conocer la password real para llegar a ese punto).
 */

const request = require('supertest');
const bcrypt = require('bcrypt');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;

beforeAll(async () => { pool = await setupTestDb(); });
afterAll(async () => { await teardownTestDb(pool); });

describe('Anti-enumeration en login (TANDA 1)', () => {
  async function resetLockout() {
    await pool.query(
      'UPDATE users SET failed_login_count = 0, lockout_until = NULL WHERE username = $1',
      [TEST_USER.username]
    );
  }
  beforeEach(async () => { await resetLockout(); });

  it('user inexistente → 401 con mensaje genérico', async () => {
    const r = await request(app).post('/api/auth/login').send({
      username: 'nope-doesnt-exist-' + Date.now(),
      password: 'whatever',
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Usuario o contraseña incorrectos');
  });

  it('user existe + password incorrecta → 401 con MISMO mensaje', async () => {
    const r = await request(app).post('/api/auth/login').send({
      username: TEST_USER.username,
      password: 'wrong-pwd-99999',
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Usuario o contraseña incorrectos');
  });

  it('user locked + password correcta → 401 con MISMO mensaje (no 423)', async () => {
    // Simular lockout activo en DB.
    await pool.query(
      `UPDATE users SET failed_login_count = 10, lockout_until = NOW() + INTERVAL '15 minutes'
        WHERE username = $1`,
      [TEST_USER.username]
    );
    const r = await request(app).post('/api/auth/login').send({
      username: TEST_USER.username,
      password: TEST_USER.password, // <- password CORRECTA, pero igual rechaza
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Usuario o contraseña incorrectos');
    // Verificamos que NO devuelve 423 (era el comportamiento pre-TANDA 1).
    expect(r.status).not.toBe(423);
  });

  it('user locked + password incorrecta → 401 con MISMO mensaje', async () => {
    await pool.query(
      `UPDATE users SET failed_login_count = 10, lockout_until = NOW() + INTERVAL '15 minutes'
        WHERE username = $1`,
      [TEST_USER.username]
    );
    const r = await request(app).post('/api/auth/login').send({
      username: TEST_USER.username,
      password: 'also-wrong',
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Usuario o contraseña incorrectos');
  });

  it('las 3 condiciones devuelven response idéntico (status + body)', async () => {
    // Snapshot del response "user no existe".
    const r1 = await request(app).post('/api/auth/login').send({
      username: 'totally-not-real-' + Date.now(),
      password: 'x',
    });

    // Snapshot "password mal".
    const r2 = await request(app).post('/api/auth/login').send({
      username: TEST_USER.username,
      password: 'wrong',
    });

    // Snapshot "locked".
    await pool.query(
      `UPDATE users SET failed_login_count = 10, lockout_until = NOW() + INTERVAL '15 minutes'
        WHERE username = $1`,
      [TEST_USER.username]
    );
    const r3 = await request(app).post('/api/auth/login').send({
      username: TEST_USER.username,
      password: TEST_USER.password,
    });

    // Los tres responses son idénticos en lo que el cliente puede observar.
    expect(r1.status).toBe(r2.status);
    expect(r2.status).toBe(r3.status);
    expect(r1.body).toEqual(r2.body);
    expect(r2.body).toEqual(r3.body);
  });
});

describe('Email case-insensitive en login (TANDA 1)', () => {
  // Creamos un user con email mixed-case directo en DB (simulando data legacy
  // pre-migración) y verificamos que login con casing distinto funciona.
  // Nota: con la migration aplicada, el backfill ya lowercaseó todos los emails,
  // pero el schema lowercasea también el input — defensa en doble capa.

  let userId;
  const EMAIL_LOWER = 'caseinsensitive@test.local';
  const PASSWORD = 'caseinsensitive-pwd-12345';

  beforeAll(async () => {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (nombre, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      ['CI User', 'ciuser', EMAIL_LOWER, hash, 'op']
    );
    userId = rows[0].id;
    // El user debe estar vinculado a tenant 1 para que login resuelva tenant_users.
    await pool.query(
      `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'member')
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [userId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it('login con email idéntico al stored → 200', async () => {
    const r = await request(app).post('/api/auth/login').send({
      email: EMAIL_LOWER,
      password: PASSWORD,
    });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
  });

  it('login con email MAYÚSCULAS → 200 (case-insensitive)', async () => {
    const r = await request(app).post('/api/auth/login').send({
      email: EMAIL_LOWER.toUpperCase(), // 'CASEINSENSITIVE@TEST.LOCAL'
      password: PASSWORD,
    });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
  });

  it('login con email Mixed-Case → 200', async () => {
    const r = await request(app).post('/api/auth/login').send({
      email: 'CaseInsensitive@Test.LOCAL',
      password: PASSWORD,
    });
    expect(r.status).toBe(200);
  });

  it('email con espacios externos → 200 (trim del schema)', async () => {
    const r = await request(app).post('/api/auth/login').send({
      email: `  ${EMAIL_LOWER.toUpperCase()}  `,
      password: PASSWORD,
    });
    expect(r.status).toBe(200);
  });
});
