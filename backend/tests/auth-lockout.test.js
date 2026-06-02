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

// ─── H1 auditoría 2026-06: lockout también aplica al step 2FA ─────────────
//
// Antes: solo el fallo de password incrementaba failed_login_count. Un
// atacante con password leakeada podía brute-forcear el TOTP (6 dígitos,
// ~10^6 espacio) rotando IPs — el rate-limit por IP no lo defiende, el
// lockout per-user sí lo defendería pero no se invocaba para 2FA.
//
// Ahora: cada 2FA fallido también incrementa el contador, igual que password.
describe('Lockout per-user con 2FA (H1)', () => {
  const twoFaLib = require('../src/lib/twoFa');
  const request = require('supertest');

  beforeEach(async () => {
    await resetLockout();
    // Limpiar 2FA — partimos sin 2FA habilitado en cada test.
    await pool.query('DELETE FROM user_2fa');
  });

  // Helper: enable 2FA para el TEST_USER y devolver el secret + token.
  async function enable2FaForTestUser() {
    const login = await request(app).post('/api/auth/login').send({
      username: TEST_USER.username, password: TEST_USER.password,
    });
    const token = login.body.token;
    const auth = { Authorization: `Bearer ${token}` };
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth);
    await request(app).post('/api/auth/2fa/enable').set(auth)
      .send({ code: twoFaLib.generateTokenForTest(setup.body.secret) });
    return { secret: setup.body.secret };
  }

  it('fallos de 2FA incrementan failed_login_count igual que fallos de password', async () => {
    await enable2FaForTestUser();
    // 3 logins con password OK + código 2FA mal
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post('/api/auth/login').send({
        username: TEST_USER.username, password: TEST_USER.password, code: '000000',
      });
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/2FA/i);
    }
    const { rows } = await pool.query('SELECT failed_login_count FROM users WHERE username = $1', [TEST_USER.username]);
    expect(rows[0].failed_login_count).toBe(3);
  });

  it('10 fallos de 2FA bloquean la cuenta con 423 en el siguiente intento', async () => {
    await enable2FaForTestUser();
    for (let i = 0; i < 10; i++) {
      await request(app).post('/api/auth/login').send({
        username: TEST_USER.username, password: TEST_USER.password, code: '000000',
      });
    }
    // El 11vo intento — incluso con código correcto — cae en 423.
    const r = await request(app).post('/api/auth/login').send({
      username: TEST_USER.username, password: TEST_USER.password, code: '111111',
    });
    expect(r.status).toBe(423);
  });

  it('login completo OK (password + 2FA) resetea el contador', async () => {
    const { secret } = await enable2FaForTestUser();
    // 5 fallos de 2FA
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/auth/login').send({
        username: TEST_USER.username, password: TEST_USER.password, code: '000000',
      });
    }
    let { rows } = await pool.query('SELECT failed_login_count FROM users WHERE username = $1', [TEST_USER.username]);
    expect(rows[0].failed_login_count).toBe(5);

    // Login exitoso con código correcto resetea el contador.
    const ok = await request(app).post('/api/auth/login').send({
      username: TEST_USER.username, password: TEST_USER.password,
      code: twoFaLib.generateTokenForTest(secret),
    });
    expect(ok.status).toBe(200);
    rows = (await pool.query('SELECT failed_login_count FROM users WHERE username = $1', [TEST_USER.username])).rows;
    expect(rows[0].failed_login_count).toBe(0);
  });

  it('password OK + 2FA missing (twofa_required) NO incrementa contador', async () => {
    // Política: si vino sin code y el user tiene 2FA, devolvemos 401 con flag
    // twofa_required:true — esto es un "primer intento" para mostrar el input,
    // no un fallo. NO incrementar contador (sino el user típico se auto-bloquea
    // por usar el flow normal).
    await enable2FaForTestUser();
    const r = await request(app).post('/api/auth/login').send({
      username: TEST_USER.username, password: TEST_USER.password,
    });
    expect(r.status).toBe(401);
    expect(r.body.twofa_required).toBe(true);
    const { rows } = await pool.query('SELECT failed_login_count FROM users WHERE username = $1', [TEST_USER.username]);
    expect(rows[0].failed_login_count).toBe(0);
  });
});
