/**
 * Tests del flow de signup público + email verification (TANDA 2.1).
 *
 * Cubre:
 *   - POST /api/auth/signup: creación de tenant + user + verification token,
 *     seed de cajas default, response structure, conflict 409 por email duplicado.
 *   - Bloqueo blando: user unverified puede login + leer pero NO escribir.
 *   - POST /api/auth/verify-email: token válido / inválido / expirado / used.
 *   - POST /api/auth/resend-verification: genera token nuevo, invalida previos,
 *     idempotente si user ya verificado.
 */

const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const emailLib = require('../src/lib/email');

let pool;

beforeAll(async () => { pool = await setupTestDb(); });
afterAll(async () => { await teardownTestDb(pool); });

// Helper: dispara signup con valores únicos por test. Counter + crypto random
// para evitar colisiones cuando se hacen múltiples signups en el mismo ms.
let _signupCounter = 0;
async function signup(overrides = {}) {
  _signupCounter += 1;
  const uniq = `${Date.now()}_${_signupCounter}_${Math.random().toString(36).slice(2, 10)}`;
  const defaults = {
    nombre:        'Alice ' + uniq,
    email:         `alice_${uniq}@example.com`,
    password:      'AlicePwd123!',
    tenant_nombre: 'Empresa ' + uniq.slice(0, 30), // tenant nombre max 80
  };
  const body = { ...defaults, ...overrides };
  const res = await request(app).post('/api/auth/signup').send(body);
  return { res, body };
}

describe('POST /api/auth/signup', () => {
  beforeEach(() => emailLib._resetTestQueue());

  it('crea tenant + user + token y devuelve 201 con JWT + verification_required', async () => {
    const { res, body } = await signup();
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe(body.email);
    expect(res.body.user.email_verified).toBe(false);
    expect(res.body.tenant.id).toBeGreaterThan(0);
    expect(res.body.tenant.plan).toBe('trial');
    expect(res.body.verification_required).toBe(true);
    // En NODE_ENV=test, el token de verificación viene en la response.
    expect(res.body._verification_token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('seedea las cajas default en el tenant nuevo', async () => {
    const { res } = await signup();
    expect(res.status).toBe(201);
    const tenantId = res.body.tenant.id;

    // RLS bloquea si no SET LOCAL — usamos query directa al pool con
    // app.current_tenant en sesión para listar.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL app.current_tenant = ${tenantId}`);
      const { rows } = await c.query(
        'SELECT nombre, moneda FROM metodos_pago WHERE deleted_at IS NULL ORDER BY orden'
      );
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(rows.map(r => r.nombre)).toEqual(
        expect.arrayContaining(['Efectivo Pesos', 'Efectivo USD', 'Banco Pesos'])
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  });

  it('TANDA 2.4 fix BLOCKER privesc: signup crea user con role=op (NO admin)', async () => {
    // Antes: signup INSERT con role='admin' → cualquier signup público obtenía
    // rol admin global, bypaseando RequirePermission del frontend y abriendo
    // /api/feature-flags y otros endpoints globales. Fix: role='op' + el rol
    // de owner del tenant se representa en tenant_users.rol='owner'.
    const { res } = await signup({ email: `roletest_${Date.now()}@example.com` });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('op');

    // Verificar también en DB.
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [res.body.user.id]);
    expect(rows[0].role).toBe('op');

    // Y que el tenant_users link tiene rol='owner' (sigue siendo owner del tenant).
    const { rows: tu } = await pool.query(
      `SELECT rol FROM tenant_users WHERE user_id = $1 AND tenant_id = $2`,
      [res.body.user.id, res.body.tenant.id]
    );
    expect(tu[0].rol).toBe('owner');
  });

  it('envía verification email (stub registra en _testQueue)', async () => {
    await signup({ email: 'queuetest_' + Date.now() + '@example.com' });
    const queue = emailLib._getTestQueue();
    expect(queue.length).toBeGreaterThanOrEqual(1);
    const last = queue[queue.length - 1];
    expect(last.type).toBe('verification');
    expect(last.verifyUrl).toContain('/verify-email?token=');
  });

  it('rechaza email duplicado con 409 (case-insensitive)', async () => {
    const email = `dup_${Date.now()}@example.com`;
    const r1 = await signup({ email });
    expect(r1.res.status).toBe(201);
    const r2 = await signup({ email: email.toUpperCase() });
    expect(r2.res.status).toBe(409);
  });

  it('rechaza password débil con 400 (schema)', async () => {
    const r = await request(app).post('/api/auth/signup').send({
      nombre: 'X', email: 'weak@example.com', password: '123', tenant_nombre: 'Empresa Y',
    });
    expect(r.status).toBe(400);
  });

  it('rechaza nombre de tenant muy corto (< 2 chars)', async () => {
    const r = await request(app).post('/api/auth/signup').send({
      nombre: 'X', email: 'shortname@example.com', password: 'Validpass1!', tenant_nombre: 'a',
    });
    expect(r.status).toBe(400);
  });
});

describe('Bloqueo blando: user unverified no puede escribir', () => {
  let token;
  let userEmail;

  beforeAll(async () => {
    const { res, body } = await signup({ email: `unverified_${Date.now()}@example.com` });
    token = res.body.token;
    userEmail = body.email;
    // Sanity: el user fue creado unverified.
    expect(res.body.user.email_verified).toBe(false);
  });

  it('GET endpoints funcionan (lectura permitida)', async () => {
    const r = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.email).toBe(userEmail);
    expect(r.body.email_verified).toBe(false);
  });

  it('POST en módulo cualquiera (ej. contactos) → 403 con reason=email_not_verified', async () => {
    const r = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'Bob', tipo: 'cliente' });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('email_not_verified');
  });

  it('DELETE también bloqueado', async () => {
    const r = await request(app)
      .delete('/api/contactos/999')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('email_not_verified');
  });

  it('PUT también bloqueado', async () => {
    const r = await request(app)
      .put('/api/contactos/999')
      .set('Authorization', `Bearer ${token}`)
      .send({ nombre: 'New' });
    expect(r.status).toBe(403);
  });

  it('endpoints de /api/auth/* SIGUEN funcionando (logout, change-password, etc.)', async () => {
    // /api/auth/logout es POST pero está bajo /api/auth/ → no bloqueado.
    const r = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });
});

describe('POST /api/auth/verify-email', () => {
  it('consume un token válido y marca user verificado', async () => {
    const { res } = await signup();
    const tok = res.body._verification_token;
    const userId = res.body.user.id;

    const verify = await request(app).post('/api/auth/verify-email').send({ token: tok });
    expect(verify.status).toBe(200);
    expect(verify.body.ok).toBe(true);
    expect(verify.body.email_verified_at).toBeTruthy();

    // En DB, el user debería estar verified ahora.
    const { rows } = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [userId]);
    expect(rows[0].email_verified_at).toBeTruthy();
  });

  it('rechaza token reusado (single-shot) con reason="already_used"', async () => {
    const { res } = await signup();
    const tok = res.body._verification_token;
    const v1 = await request(app).post('/api/auth/verify-email').send({ token: tok });
    expect(v1.status).toBe(200);
    const v2 = await request(app).post('/api/auth/verify-email').send({ token: tok });
    expect(v2.status).toBe(400);
    // UX TANDA 2.2 Fase B: mensaje accionable + reason explícito.
    expect(v2.body.reason).toBe('already_used');
    expect(v2.body.error).toMatch(/ya fue verificado/i);
  });

  it('rechaza token expirado con reason="expired"', async () => {
    const { res } = await signup();
    const tok = res.body._verification_token;
    // Forzamos el token a estar vencido. Movemos también created_at al pasado
    // para no violar el CHECK (expires_at > created_at).
    await pool.query(
      `UPDATE email_verification_tokens
          SET created_at = NOW() - INTERVAL '2 hours',
              expires_at = NOW() - INTERVAL '1 hour'
        WHERE token = $1`,
      [tok]
    );
    const v = await request(app).post('/api/auth/verify-email').send({ token: tok });
    expect(v.status).toBe(400);
    expect(v.body.reason).toBe('expired');
    expect(v.body.error).toMatch(/expir/i);
  });

  it('rechaza token inválido (no existe) con reason="invalid"', async () => {
    const fakeToken = 'a'.repeat(64);
    const v = await request(app).post('/api/auth/verify-email').send({ token: fakeToken });
    expect(v.status).toBe(400);
    expect(v.body.reason).toBe('invalid');
  });

  it('rechaza formato inválido (no-hex)', async () => {
    const v = await request(app).post('/api/auth/verify-email').send({ token: 'not-hex-token!!!' });
    expect(v.status).toBe(400);
  });

  it('user verificado YA puede escribir (bloqueo blando desactivado post-verify)', async () => {
    const { res } = await signup();
    const tok = res.body._verification_token;
    const userToken = res.body.token;

    // Antes de verificar: write bloqueado.
    const before = await request(app).post('/api/contactos')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ nombre: 'Pre-verify', tipo: 'cliente' });
    expect(before.status).toBe(403);

    // Verificar.
    await request(app).post('/api/auth/verify-email').send({ token: tok });

    // Ahora write OK.
    const after = await request(app).post('/api/contactos')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ nombre: 'Post-verify', tipo: 'cliente' });
    expect(after.status).toBe(201);
  });
});

describe('POST /api/auth/resend-verification', () => {
  it('genera token nuevo + invalida el previo', async () => {
    const { res } = await signup();
    const oldToken = res.body._verification_token;
    const userToken = res.body.token;

    const resend = await request(app)
      .post('/api/auth/resend-verification')
      .set('Authorization', `Bearer ${userToken}`);
    expect(resend.status).toBe(200);
    expect(resend.body._verification_token).toMatch(/^[0-9a-f]{64}$/);
    expect(resend.body._verification_token).not.toBe(oldToken);

    // El token viejo ya no funciona.
    const v1 = await request(app).post('/api/auth/verify-email').send({ token: oldToken });
    expect(v1.status).toBe(400);

    // El token nuevo sí.
    const v2 = await request(app).post('/api/auth/verify-email').send({ token: resend.body._verification_token });
    expect(v2.status).toBe(200);
  });

  it('idempotente: user ya verificado → 200 con already_verified:true', async () => {
    const { res } = await signup();
    const tok = res.body._verification_token;
    const userToken = res.body.token;

    // Verificar primero.
    await request(app).post('/api/auth/verify-email').send({ token: tok });

    // Resend ahora → no-op.
    const resend = await request(app)
      .post('/api/auth/resend-verification')
      .set('Authorization', `Bearer ${userToken}`);
    expect(resend.status).toBe(200);
    expect(resend.body.already_verified).toBe(true);
  });

  it('requiere auth → 401 sin token', async () => {
    const r = await request(app).post('/api/auth/resend-verification');
    expect(r.status).toBe(401);
  });
});

describe('Login: el flag email_verified viaja en /me y en /login response', () => {
  it('TEST_USER (admin existente) → email_verified=true (backfill de migration)', async () => {
    const login = await request(app).post('/api/auth/login').send({
      username: TEST_USER.username, password: TEST_USER.password,
    });
    expect(login.status).toBe(200);
    expect(login.body.user.email_verified).toBe(true);

    const me = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(me.body.email_verified).toBe(true);
  });
});
