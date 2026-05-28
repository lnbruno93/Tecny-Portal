/**
 * Tests del lockout per-user (P1-1 de la auditoría ultra).
 *
 * Política: 10 fallos consecutivos → 15 min de bloqueo (423 Locked).
 * Login exitoso resetea el contador y libera el lockout.
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;

beforeAll(async () => { pool = await setupTestDb(); });
afterAll(async () => { await teardownTestDb(pool); });

// Helper: login con password incorrecta
async function badLogin(username = TEST_USER.username) {
  return request(app).post('/api/auth/login').send({ username, password: 'wrong-pwd-12345' });
}
async function goodLogin() {
  return request(app).post('/api/auth/login').send({ username: TEST_USER.username, password: TEST_USER.password });
}

// Helper para resetear contadores entre tests (DB compartida)
async function resetLockout() {
  await pool.query('UPDATE users SET failed_login_count = 0, lockout_until = NULL WHERE username = $1', [TEST_USER.username]);
}

describe('Lockout per-user (P1-1)', () => {
  beforeEach(async () => { await resetLockout(); });

  it('fallos por debajo del threshold mantienen el contador pero no bloquean', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await badLogin();
      expect(r.status).toBe(401);
    }
    const { rows } = await pool.query('SELECT failed_login_count, lockout_until FROM users WHERE username = $1', [TEST_USER.username]);
    expect(rows[0].failed_login_count).toBe(3);
    expect(rows[0].lockout_until).toBeNull();
  });

  it('al cumplir el threshold (10) bloquea con 423 en el siguiente intento', async () => {
    for (let i = 0; i < 10; i++) await badLogin();
    // El intento 11 (cualquiera, incluso con password correcta) cae en 423
    const r = await goodLogin();
    expect(r.status).toBe(423);
    expect(r.body.error).toMatch(/bloqueada/i);
    const { rows } = await pool.query('SELECT lockout_until FROM users WHERE username = $1', [TEST_USER.username]);
    expect(rows[0].lockout_until).toBeTruthy();
  });

  it('mensaje genérico — no revela si el usuario existe (constant-time)', async () => {
    const r1 = await request(app).post('/api/auth/login').send({ username: 'no-existe-jamas', password: 'x' });
    expect(r1.status).toBe(401);
    expect(r1.body.error).toBe('Usuario o contraseña incorrectos');
    const r2 = await badLogin();
    expect(r2.status).toBe(401);
    // Mismo error textual para ambos casos
    expect(r2.body.error).toBe(r1.body.error);
  });

  it('login exitoso resetea el contador y libera el lockout', async () => {
    for (let i = 0; i < 5; i++) await badLogin();
    let { rows } = await pool.query('SELECT failed_login_count FROM users WHERE username = $1', [TEST_USER.username]);
    expect(rows[0].failed_login_count).toBe(5);
    const ok = await goodLogin();
    expect(ok.status).toBe(200);
    rows = (await pool.query('SELECT failed_login_count, lockout_until FROM users WHERE username = $1', [TEST_USER.username])).rows;
    expect(rows[0].failed_login_count).toBe(0);
    expect(rows[0].lockout_until).toBeNull();
  });

  it('lockout expirado (manual) deja loguear de nuevo', async () => {
    // Simulamos bloqueo pasado: settear lockout_until en el pasado.
    await pool.query(
      `UPDATE users SET failed_login_count = 10, lockout_until = NOW() - INTERVAL '1 hour'
        WHERE username = $1`,
      [TEST_USER.username]
    );
    const ok = await goodLogin();
    expect(ok.status).toBe(200);
  });
});
