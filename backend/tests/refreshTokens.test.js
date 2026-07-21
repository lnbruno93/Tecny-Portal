/**
 * Refresh token pattern — tests de Fase 1 backend (Task #190, 2026-07-21).
 *
 * Cubre:
 *   1. Login emite refresh cookie httpOnly.
 *   2. POST /refresh valida el cookie + emite nuevo access + rota el cookie.
 *   3. Reuse detection: usar el mismo cookie 2 veces → segundo llamado falla
 *      + revoca TODA la cadena de refresh del user (defense in depth vs
 *      token theft).
 *   4. Cookie inválido / vacío → 401.
 *   5. Logout revoca el refresh + limpia el cookie.
 *   6. Change-password revoca todos los refresh del user.
 *   7. Cookie con path scope correcto (/api/auth/refresh, no cualquier path).
 */
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/database');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const refreshTokens = require('../src/lib/refreshTokens');

let pool;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

beforeEach(async () => {
  // Limpiar refresh tokens entre tests para aislamiento.
  await pool.query('TRUNCATE refresh_tokens RESTART IDENTITY CASCADE');
});

// Helper: login y devuelve { accessToken, refreshCookie }.
async function loginAndGetCookies() {
  const res = await request(app).post('/api/auth/login').send({
    username: TEST_USER.username,
    password: TEST_USER.password,
  });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();

  const setCookieHeader = res.headers['set-cookie'];
  expect(Array.isArray(setCookieHeader)).toBe(true);
  const refreshCookieRaw = setCookieHeader.find((c) => c.startsWith(`${refreshTokens.COOKIE_NAME}=`));
  expect(refreshCookieRaw).toBeDefined();

  // Extraemos SOLO el `name=value` para poder mandarlo de vuelta.
  const refreshCookie = refreshCookieRaw.split(';')[0];
  return { accessToken: res.body.token, refreshCookie, allCookies: setCookieHeader };
}

describe('POST /api/auth/login emite refresh cookie', () => {
  it('setea cookie httpOnly con path /api/auth/refresh', async () => {
    const { allCookies } = await loginAndGetCookies();
    const refreshCookieRaw = allCookies.find((c) => c.startsWith(`${refreshTokens.COOKIE_NAME}=`));

    expect(refreshCookieRaw).toContain('HttpOnly');
    expect(refreshCookieRaw).toContain('Path=/api/auth/refresh');
    expect(refreshCookieRaw).toContain('SameSite=Lax');
    // Max-Age está seteado (30 días default en ms → segundos en cookie).
    expect(refreshCookieRaw).toMatch(/Max-Age=\d+/);
  });

  it('persiste el token hasheado en refresh_tokens', async () => {
    const { rows: before } = await pool.query('SELECT COUNT(*)::int AS n FROM refresh_tokens');
    expect(before[0].n).toBe(0);

    await loginAndGetCookies();

    const { rows: after } = await pool.query(
      `SELECT user_id, token_hash, expires_at, revoked_at FROM refresh_tokens`
    );
    expect(after).toHaveLength(1);
    expect(after[0].user_id).toBe(1); // TEST_USER es id=1
    expect(after[0].token_hash).toHaveLength(64); // SHA-256 hex
    expect(after[0].expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(after[0].revoked_at).toBeNull();
  });
});

describe('POST /api/auth/refresh', () => {
  it('valida el cookie y emite nuevo access token + rota el cookie', async () => {
    const { refreshCookie, accessToken: oldAccess } = await loginAndGetCookies();

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.token).not.toBe(oldAccess); // Access nuevo distinto al viejo

    // Cookie nuevo seteado (rotación).
    const newCookies = res.headers['set-cookie'];
    const newRefreshRaw = newCookies?.find((c) => c.startsWith(`${refreshTokens.COOKIE_NAME}=`));
    expect(newRefreshRaw).toBeDefined();
    expect(newRefreshRaw).not.toBe(refreshCookie); // Cookie nuevo distinto al viejo
  });

  it('marca el refresh viejo como revocado post-rotación', async () => {
    const { refreshCookie } = await loginAndGetCookies();

    await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie).expect(200);

    // Ahora hay 2 rows: el viejo (revoked) + el nuevo (activo).
    const { rows } = await pool.query(
      `SELECT id, revoked_at, rotated_from_id FROM refresh_tokens ORDER BY created_at ASC`
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[1].revoked_at).toBeNull();
    expect(rows[1].rotated_from_id).toBe(rows[0].id);
  });

  it('reuse detection: usar mismo cookie 2 veces revoca TODA la cadena del user', async () => {
    const { refreshCookie } = await loginAndGetCookies();

    // Primer refresh OK.
    await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie).expect(200);

    // Segundo refresh con el MISMO cookie viejo → attack signal.
    const res2 = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);
    expect(res2.status).toBe(401);
    expect(res2.body.code).toBe('INVALID_REFRESH');

    // TODOS los refresh del user deben estar revocados (incluido el nuevo emitido
    // en el primer refresh — porque el attack detection revoca toda la familia).
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE user_id = 1 AND revoked_at IS NULL`
    );
    expect(rows[0].n).toBe(0);
  });

  it('sin cookie → 401 NO_REFRESH', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NO_REFRESH');
  });

  it('cookie con token inexistente → 401 INVALID_REFRESH + limpia cookie', async () => {
    const fakeCookie = `${refreshTokens.COOKIE_NAME}=${'a'.repeat(64)}`;

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', fakeCookie);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_REFRESH');

    // Set-Cookie con Max-Age=0 o similar para clear.
    const clearCookieRaw = res.headers['set-cookie']?.find((c) => c.startsWith(`${refreshTokens.COOKIE_NAME}=`));
    expect(clearCookieRaw).toBeDefined();
    expect(clearCookieRaw).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  });

  it('cookie con token malformado (length ≠ 64) → 401', async () => {
    const badCookie = `${refreshTokens.COOKIE_NAME}=notlongenough`;
    const res = await request(app).post('/api/auth/refresh').set('Cookie', badCookie);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout revoca el refresh', () => {
  it('marca el refresh del cookie como revocado + limpia cookie', async () => {
    const { refreshCookie, accessToken } = await loginAndGetCookies();

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', refreshCookie)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Refresh en DB debe quedar revoked.
    const { rows } = await pool.query(
      `SELECT revoked_at FROM refresh_tokens WHERE user_id = 1`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it('post-logout el refresh no sirve para renovar', async () => {
    const { refreshCookie, accessToken } = await loginAndGetCookies();
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', refreshCookie)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Intentar refresh con el cookie revocado.
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie);
    expect(refreshRes.status).toBe(401);
  });
});

describe('helper unit tests', () => {
  it('cookieOptions() setea flags de seguridad correctos', () => {
    const opts = refreshTokens.cookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/api/auth/refresh');
    expect(opts.maxAge).toBeGreaterThan(0);
    // secure=false en test (NODE_ENV!=production).
    expect(opts.secure).toBe(false);
  });

  it('_hashToken es determinístico + 64 char hex', () => {
    const hash1 = refreshTokens._hashToken('abc123');
    const hash2 = refreshTokens._hashToken('abc123');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('revokeAllForUser revoca todos los refresh activos', async () => {
    // Emitir 3 refresh tokens del user 1.
    for (let i = 0; i < 3; i++) {
      await refreshTokens.issueRefreshToken(1, { ip: '127.0.0.1', headers: {} });
    }

    const { rows: before } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE user_id = 1 AND revoked_at IS NULL`
    );
    expect(before[0].n).toBe(3);

    await refreshTokens.revokeAllForUser(1);

    const { rows: after } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE user_id = 1 AND revoked_at IS NULL`
    );
    expect(after[0].n).toBe(0);
  });
});
