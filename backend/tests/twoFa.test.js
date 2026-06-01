/**
 * Tests del módulo 2FA: lib + endpoints + integración con login.
 *
 * Cubre:
 *   · lib/twoFa.js: encryption roundtrip, TOTP verify, recovery codes.
 *   · /api/auth/2fa/setup: idempotente para re-setup, 409 si ya enabled.
 *   · /api/auth/2fa/enable: requiere código válido.
 *   · /api/auth/2fa/disable: requiere código TOTP o recovery.
 *   · /api/auth/2fa/regenerate-recovery: idem.
 *   · /api/auth/login: gate de 2FA si está enabled (sin code → 401 + flag).
 *   · Recovery code one-time-use (queda inválido tras usarse).
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const twoFaLib = require('../src/lib/twoFa');

let pool, adminToken;
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function loginAs(username, password, code) {
  const body = { username, password };
  if (code) body.code = code;
  return request(app).post('/api/auth/login').send(body);
}

beforeAll(async () => {
  pool = await setupTestDb();
  const res = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = res.body.token;
});
afterAll(async () => { await teardownTestDb(pool); });

// Cleanup user_2fa entre tests para que cada uno arranque limpio.
afterEach(async () => {
  await pool.query('DELETE FROM user_2fa');
});

describe('lib/twoFa', () => {
  it('encryption roundtrip — secret cifrado puede desencriptarse', () => {
    const secret = twoFaLib.generateSecret();
    const enc = twoFaLib.encryptSecret(secret);
    expect(Buffer.isBuffer(enc)).toBe(true);
    expect(enc.length).toBeGreaterThan(28); // 12 iv + 16 tag + ciphertext
    const dec = twoFaLib.decryptSecret(enc);
    expect(dec).toBe(secret);
  });

  it('verifyToken acepta el código actual y rechaza uno random', () => {
    const secret = twoFaLib.generateSecret();
    const goodCode = twoFaLib.generateTokenForTest(secret);
    expect(twoFaLib.verifyToken(secret, goodCode)).toBe(true);
    expect(twoFaLib.verifyToken(secret, '000000')).toBe(false);
    expect(twoFaLib.verifyToken(secret, 'abcdef')).toBe(false);
    expect(twoFaLib.verifyToken(secret, '')).toBe(false);
    expect(twoFaLib.verifyToken(secret, null)).toBe(false);
  });

  it('generateRecoveryCodes genera 8 codes con formato XXXX-XXXX-XX', () => {
    const codes = twoFaLib.generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    for (const c of codes) {
      expect(c).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{2}$/);
    }
    // Sin duplicados
    expect(new Set(codes).size).toBe(8);
  });

  it('findRecoveryCodeIndex devuelve el índice match o -1', async () => {
    const plain = twoFaLib.generateRecoveryCodes();
    const hashed = await twoFaLib.hashRecoveryCodes(plain);
    expect(await twoFaLib.findRecoveryCodeIndex(plain[2], hashed)).toBe(2);
    expect(await twoFaLib.findRecoveryCodeIndex('FAKE-FAKE-99', hashed)).toBe(-1);
    expect(await twoFaLib.findRecoveryCodeIndex(plain[2].toLowerCase(), hashed)).toBe(2); // case-insensitive
  });
});

describe('POST /api/auth/2fa/setup', () => {
  it('devuelve secret + otpauth_uri + 8 recovery codes', async () => {
    const res = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(typeof res.body.secret).toBe('string');
    expect(res.body.secret.length).toBeGreaterThan(15);
    expect(res.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.recovery_codes).toHaveLength(8);
  });

  it('idempotente: setup dos veces mientras NO está enabled, reemplaza secret', async () => {
    const r1 = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    const r2 = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    expect(r2.status).toBe(200);
    expect(r2.body.secret).not.toBe(r1.body.secret);
  });

  it('409 si ya está enabled — primero hay que disable', async () => {
    // Setup + enable
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    const code = twoFaLib.generateTokenForTest(setup.body.secret);
    await request(app).post('/api/auth/2fa/enable').set(auth(adminToken)).send({ code });

    const reSetup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    expect(reSetup.status).toBe(409);
  });
});

describe('POST /api/auth/2fa/enable', () => {
  it('código correcto → enabled_at se setea', async () => {
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    const code = twoFaLib.generateTokenForTest(setup.body.secret);
    const res = await request(app).post('/api/auth/2fa/enable').set(auth(adminToken)).send({ code });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enabled_at).toBeTruthy();
  });

  it('código incorrecto → 400', async () => {
    await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    const res = await request(app).post('/api/auth/2fa/enable').set(auth(adminToken)).send({ code: '123456' });
    expect(res.status).toBe(400);
  });

  it('sin haber hecho setup → 400', async () => {
    const res = await request(app).post('/api/auth/2fa/enable').set(auth(adminToken)).send({ code: '123456' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/2fa/disable', () => {
  it('código TOTP correcto → desactiva (row eliminado)', async () => {
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    await request(app).post('/api/auth/2fa/enable').set(auth(adminToken))
      .send({ code: twoFaLib.generateTokenForTest(setup.body.secret) });

    const disableCode = twoFaLib.generateTokenForTest(setup.body.secret);
    const res = await request(app).post('/api/auth/2fa/disable').set(auth(adminToken)).send({ code: disableCode });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT user_id FROM user_2fa WHERE user_id = $1', [1]);
    expect(rows).toHaveLength(0);
  });

  it('recovery code → desactiva y queda inválido one-time', async () => {
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    await request(app).post('/api/auth/2fa/enable').set(auth(adminToken))
      .send({ code: twoFaLib.generateTokenForTest(setup.body.secret) });

    const recovery = setup.body.recovery_codes[0];
    const res = await request(app).post('/api/auth/2fa/disable').set(auth(adminToken)).send({ code: recovery });
    expect(res.status).toBe(200);
  });

  it('código incorrecto → 400', async () => {
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    await request(app).post('/api/auth/2fa/enable').set(auth(adminToken))
      .send({ code: twoFaLib.generateTokenForTest(setup.body.secret) });

    const res = await request(app).post('/api/auth/2fa/disable').set(auth(adminToken)).send({ code: '000000' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/auth/2fa/status', () => {
  it('sin 2FA: configured=false, enabled=false', async () => {
    const res = await request(app).get('/api/auth/2fa/status').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.enabled).toBe(false);
  });

  it('después de enable: configured=true, enabled=true, recovery_codes_remaining=8', async () => {
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    await request(app).post('/api/auth/2fa/enable').set(auth(adminToken))
      .send({ code: twoFaLib.generateTokenForTest(setup.body.secret) });

    const res = await request(app).get('/api/auth/2fa/status').set(auth(adminToken));
    expect(res.body.configured).toBe(true);
    expect(res.body.enabled).toBe(true);
    expect(res.body.recovery_codes_remaining).toBe(8);
  });
});

describe('POST /api/auth/login con 2FA', () => {
  it('user sin 2FA → login normal devuelve token', async () => {
    const res = await loginAs(TEST_USER.username, TEST_USER.password);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('user con 2FA enabled + sin code → 401 con twofa_required:true', async () => {
    // Setup + enable 2FA del admin
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    await request(app).post('/api/auth/2fa/enable').set(auth(adminToken))
      .send({ code: twoFaLib.generateTokenForTest(setup.body.secret) });

    const res = await loginAs(TEST_USER.username, TEST_USER.password);
    expect(res.status).toBe(401);
    expect(res.body.twofa_required).toBe(true);
    expect(res.body.token).toBeUndefined();
  });

  it('user con 2FA enabled + code TOTP correcto → token', async () => {
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    await request(app).post('/api/auth/2fa/enable').set(auth(adminToken))
      .send({ code: twoFaLib.generateTokenForTest(setup.body.secret) });

    const loginCode = twoFaLib.generateTokenForTest(setup.body.secret);
    const res = await loginAs(TEST_USER.username, TEST_USER.password, loginCode);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('user con 2FA + recovery code → token, y ese code queda inválido', async () => {
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    await request(app).post('/api/auth/2fa/enable').set(auth(adminToken))
      .send({ code: twoFaLib.generateTokenForTest(setup.body.secret) });

    const recovery = setup.body.recovery_codes[3];
    // Primer uso: login OK
    const r1 = await loginAs(TEST_USER.username, TEST_USER.password, recovery);
    expect(r1.status).toBe(200);
    expect(r1.body.token).toBeTruthy();

    // Segundo uso del MISMO recovery code: ya está quemado
    const r2 = await loginAs(TEST_USER.username, TEST_USER.password, recovery);
    expect(r2.status).toBe(401);
  });

  it('user con 2FA + code incorrecto → 401 sin twofa_required (ya intentó)', async () => {
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    await request(app).post('/api/auth/2fa/enable').set(auth(adminToken))
      .send({ code: twoFaLib.generateTokenForTest(setup.body.secret) });

    const res = await loginAs(TEST_USER.username, TEST_USER.password, '000000');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/2FA/i);
  });
});

describe('POST /api/auth/2fa/regenerate-recovery', () => {
  it('genera 8 nuevos codes e invalida los viejos', async () => {
    const setup = await request(app).post('/api/auth/2fa/setup').set(auth(adminToken));
    await request(app).post('/api/auth/2fa/enable').set(auth(adminToken))
      .send({ code: twoFaLib.generateTokenForTest(setup.body.secret) });

    const totpCode = twoFaLib.generateTokenForTest(setup.body.secret);
    const res = await request(app).post('/api/auth/2fa/regenerate-recovery')
      .set(auth(adminToken)).send({ code: totpCode });

    expect(res.status).toBe(200);
    expect(res.body.recovery_codes).toHaveLength(8);
    // Los nuevos son distintos a los originales del setup
    const intersection = res.body.recovery_codes.filter(c => setup.body.recovery_codes.includes(c));
    expect(intersection).toHaveLength(0);

    // Los viejos ya no funcionan
    const oldRecovery = setup.body.recovery_codes[0];
    const loginFail = await loginAs(TEST_USER.username, TEST_USER.password, oldRecovery);
    expect(loginFail.status).toBe(401);
  });
});
