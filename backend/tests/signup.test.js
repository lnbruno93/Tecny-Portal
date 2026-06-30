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

// TANDA 2.7 anti-enum: signup ya no devuelve user/tenant. Tests que necesitan
// el id buscan en DB después del signup.
async function fetchUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.username, u.email, u.role, u.email_verified_at,
            t.id AS tenant_id, t.nombre AS tenant_nombre, t.slug AS tenant_slug, t.plan AS tenant_plan
       FROM users u
       JOIN tenant_users tu ON tu.user_id = u.id
       JOIN tenants t ON t.id = tu.tenant_id
      WHERE LOWER(u.email) = LOWER($1) AND u.deleted_at IS NULL`,
    [email]
  );
  return rows[0] || null;
}

// TANDA 2.7: signup ya no auto-loguea (anti-enum). Para tests que necesitan
// un JWT autenticado, hacemos login tradicional después del signup.
async function loginAfter({ email, password }) {
  const r = await request(app).post('/api/auth/login').send({ email, password });
  if (r.status !== 200) {
    throw new Error(`login post-signup falló: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { token: r.body.token, user: r.body.user };
}

describe('POST /api/auth/signup', () => {
  beforeEach(() => emailLib._resetTestQueue());

  it('TANDA 2.7 anti-enum: response genérica 200 + crea tenant + user en DB', async () => {
    const { res, body } = await signup();
    // TANDA 2.7: response genérico (anti-enum). NO incluye token/user/tenant.
    expect(res.status).toBe(200);
    expect(res.body.verification_required).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toBeUndefined();
    expect(res.body.tenant).toBeUndefined();
    // El verification_token sí se expone en NODE_ENV=test.
    expect(res.body._verification_token).toMatch(/^[0-9a-f]{64}$/);
    // El user/tenant SÍ se crearon en DB (verify via lookup).
    const u = await fetchUserByEmail(body.email);
    expect(u).not.toBeNull();
    expect(u.email).toBe(body.email);
    expect(u.email_verified_at).toBeNull();
    expect(u.tenant_plan).toBe('trial');
  });

  it('seedea las cajas default en el tenant nuevo', async () => {
    const { res, body } = await signup();
    expect(res.status).toBe(200);
    const u = await fetchUserByEmail(body.email);
    const tenantId = u.tenant_id;

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

  it('ONB-3 seedea 4 categorías default en el tenant nuevo', async () => {
    // 2026-06-24 audit pre-live: sin esto, el primer producto que el owner
    // intenta crear desde el OnboardingCard rebota con "La categoría es
    // obligatoria" (productos.categoria_id requerido). Estas 4 cubren el
    // ~90% de los negocios de revendedores tech.
    const { res, body } = await signup({ email: `cat_${Date.now()}@example.com` });
    expect(res.status).toBe(200);
    const u = await fetchUserByEmail(body.email);
    const tenantId = u.tenant_id;

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL app.current_tenant = ${tenantId}`);
      const { rows } = await c.query(
        'SELECT nombre FROM categorias WHERE deleted_at IS NULL ORDER BY id'
      );
      expect(rows.map(r => r.nombre)).toEqual(
        expect.arrayContaining(['Celulares', 'Accesorios', 'Servicios', 'Otros'])
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
    // TANDA 2.7 anti-enum: el response ya no incluye user/tenant; chequeamos
    // ambas cosas en DB.
    const { res, body } = await signup({ email: `roletest_${Date.now()}@example.com` });
    expect(res.status).toBe(200);
    const u = await fetchUserByEmail(body.email);
    expect(u.role).toBe('op');

    // Y que el tenant_users link tiene rol='owner' (sigue siendo owner del tenant).
    const { rows: tu } = await pool.query(
      `SELECT rol FROM tenant_users WHERE user_id = $1 AND tenant_id = $2`,
      [u.id, u.tenant_id]
    );
    expect(tu[0].rol).toBe('owner');
  });

  it('envía verification email (stub registra en _testQueue)', async () => {
    await signup({ email: 'queuetest_' + Date.now() + '@example.com' });
    // TANDA 0 hotfix B2: sendVerificationEmail ahora corre fire-and-forget vía
    // setImmediate (anti-timing-oracle). Flush pending immediates antes de
    // assertar el queue.
    await new Promise(setImmediate);
    const queue = emailLib._getTestQueue();
    expect(queue.length).toBeGreaterThanOrEqual(1);
    const last = queue[queue.length - 1];
    expect(last.type).toBe('verification');
    expect(last.verifyUrl).toContain('/verify-email?token=');
  });

  it('TANDA 2.7 anti-enum: email duplicado responde 200 IDÉNTICO (case-insensitive)', async () => {
    // Antes: 409 explicito → enumeration. Ahora: response idéntica al signup
    // exitoso. El user existente NO se duplica en DB.
    const email = `dup_${Date.now()}@example.com`;
    const r1 = await signup({ email });
    expect(r1.res.status).toBe(200);
    expect(r1.res.body.verification_required).toBe(true);
    // Segundo signup con el mismo email (variante case): MISMA response.
    const r2 = await signup({ email: email.toUpperCase() });
    expect(r2.res.status).toBe(200);
    expect(r2.res.body.verification_required).toBe(true);
    // Validar que NO se creó un segundo user en DB (anti-enum + sin daño).
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS c FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL',
      [email]
    );
    expect(rows[0].c).toBe(1);
    // El response del duplicado NO incluye _verification_token (no se creó token nuevo).
    expect(r2.res.body._verification_token).toBeUndefined();
  });

  it('TANDA 1 fix T4: path duplicado emite log signup_dup_email (observabilidad anti-enum)', async () => {
    // El log es la única señal server-side para detectar enumeration attempts.
    // Si alguien remueve el logger.info accidentalmente, perdemos visibilidad
    // de attacks sin que ningún test falle. Lockeamos el log acá.
    const logger = require('../src/lib/logger');
    const spy = jest.spyOn(logger, 'info');
    try {
      const email = `logdup_${Date.now()}@example.com`;
      await signup({ email }); // path nuevo
      spy.mockClear();
      await signup({ email }); // path duplicado
      // El log debería tener source: 'signup_dup_email' (ver routes/signup.js).
      const dupCall = spy.mock.calls.find(([payload]) =>
        payload && payload.source === 'signup_dup_email'
      );
      expect(dupCall).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('CAPTCHA: con HCAPTCHA_FORCE_IN_TESTS=1 y sin SECRET → 400 captcha_failed', async () => {
    // Verifica que el gate captcha está conectado al endpoint. Forzamos
    // captcha real (sin bypass) sin secret → config_error → 400.
    const prevEnv = process.env.NODE_ENV;
    const prevForce = process.env.HCAPTCHA_FORCE_IN_TESTS;
    const prevEnabled = process.env.HCAPTCHA_ENABLED;
    const prevSecret = process.env.HCAPTCHA_SECRET;
    try {
      process.env.HCAPTCHA_FORCE_IN_TESTS = '1';
      process.env.HCAPTCHA_ENABLED = 'true';
      delete process.env.HCAPTCHA_SECRET;
      const r = await signup({ email: `captcha_${Date.now()}@example.com` });
      expect(r.res.status).toBe(400);
      expect(r.res.body.reason).toBe('captcha_failed');
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevForce === undefined) delete process.env.HCAPTCHA_FORCE_IN_TESTS;
      else process.env.HCAPTCHA_FORCE_IN_TESTS = prevForce;
      if (prevEnabled === undefined) delete process.env.HCAPTCHA_ENABLED;
      else process.env.HCAPTCHA_ENABLED = prevEnabled;
      if (prevSecret === undefined) delete process.env.HCAPTCHA_SECRET;
      else process.env.HCAPTCHA_SECRET = prevSecret;
    }
  });

  it('CAPTCHA: bypass por default en NODE_ENV=test (signup pasa sin hcaptcha_response)', async () => {
    // El signup sigue pasando sin tener que pasar hcaptcha_response porque
    // verifyCaptcha bypassa en NODE_ENV=test default.
    const r = await signup();
    expect(r.res.status).toBe(200);
    expect(r.res.body.verification_required).toBe(true);
  });

  it('TANDA 0 hotfix B2: path duplicado ejecuta bcrypt (anti-timing-oracle)', async () => {
    // Sin este fix, path duplicado retornaba ~10ms y path nuevo ~300-500ms
    // (bcrypt cost-12). Un atacante medía response time y enumeraba emails con
    // ~10 samples, anulando el anti-enum por shape de TANDA 2.7. Ahora ambos
    // paths hacen bcrypt → timing similar dentro del jitter de red.
    const bcrypt = require('bcrypt');
    const spy = jest.spyOn(bcrypt, 'hash');
    try {
      const email = `timing_${Date.now()}@example.com`;
      // Seed: signup nuevo (path "nuevo") para que el segundo signup sea duplicado.
      await signup({ email });
      spy.mockClear();
      // Path duplicado.
      const dup = await signup({ email });
      expect(dup.res.status).toBe(200);
      // bcrypt.hash debería haber sido llamado exactamente 1 vez en el path
      // duplicado (dummy work para igualar timing al path nuevo).
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
    } finally {
      spy.mockRestore();
    }
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

  // ── Multi-país F4 (#470) ──────────────────────────────────────────────
  // Signup ahora acepta `pais` en el body para que el selector frontend
  // pueda crear tenants AR o UY. Default 'AR' para legacy clients.
  describe('#470 selector país AR/UY', () => {
    it('sin `pais` en body → tenant queda en AR (default Zod)', async () => {
      const { res, body } = await signup();
      expect(res.status).toBe(200);
      const u = await fetchUserByEmail(body.email);
      const { rows } = await pool.query(
        `SELECT pais FROM tenants WHERE id = $1`, [u.tenant_id]
      );
      expect(rows[0].pais).toBe('AR');
    });

    it('pais="UY" → tenant queda en UY + cajas en UYU + alerta TC valor=40', async () => {
      const { res, body } = await signup({ pais: 'UY' });
      expect(res.status).toBe(200);
      const u = await fetchUserByEmail(body.email);

      // 1) tenants.pais
      const { rows: tenants } = await pool.query(
        `SELECT pais FROM tenants WHERE id = $1`, [u.tenant_id]
      );
      expect(tenants[0].pais).toBe('UY');

      // 2) cajas default en UYU (no en ARS) + USD se mantiene.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL app.current_tenant = ${u.tenant_id}`);
        const { rows: cajas } = await c.query(
          `SELECT moneda FROM metodos_pago WHERE deleted_at IS NULL ORDER BY orden`
        );
        const monedas = cajas.map(r => r.moneda);
        // UY: dos cajas en UYU + una USD; NO debe haber ninguna en ARS.
        expect(monedas).toEqual(expect.arrayContaining(['UYU', 'USD']));
        expect(monedas).not.toContain('ARS');

        // 3) alertas_config tc_referencia con valor=40 (TC UYU/USD), no 1400.
        const { rows: alertas } = await c.query(
          `SELECT parametros FROM alertas_config
            WHERE tenant_id = $1 AND tipo = 'tc_referencia'`,
          [u.tenant_id]
        );
        expect(alertas.length).toBe(1);
        const params = alertas[0].parametros;
        const parsed = typeof params === 'string' ? JSON.parse(params) : params;
        expect(parsed.valor).toBe(40);

        await c.query('COMMIT');
      } finally {
        c.release();
      }
    });

    it('pais="CL" → 400 (Zod rechaza países no soportados)', async () => {
      const r = await request(app).post('/api/auth/signup').send({
        nombre: 'X',
        email: `cl_${Date.now()}@example.com`,
        password: 'Validpass1!',
        tenant_nombre: 'Empresa CL test',
        pais: 'CL',
      });
      expect(r.status).toBe(400);
    });
  });
});

describe('Bloqueo blando: user unverified no puede escribir', () => {
  let token;
  let userEmail;

  beforeAll(async () => {
    // TANDA 2.7 anti-enum: signup ya no auto-loguea. Hacemos login después.
    const { body } = await signup({ email: `unverified_${Date.now()}@example.com` });
    userEmail = body.email;
    const loginR = await loginAfter({ email: body.email, password: body.password });
    token = loginR.token;
    // Sanity: el user fue creado unverified.
    expect(loginR.user.email_verified).toBe(false);
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
    const { res, body } = await signup();
    const tok = res.body._verification_token;
    const u = await fetchUserByEmail(body.email);

    const verify = await request(app).post('/api/auth/verify-email').send({ token: tok });
    expect(verify.status).toBe(200);
    expect(verify.body.ok).toBe(true);
    expect(verify.body.email_verified_at).toBeTruthy();

    // En DB, el user debería estar verified ahora.
    const { rows } = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [u.id]);
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

  it('TANDA 2.6: tenant huérfano → 410 reason="tenant_orphan" (NO cae a tenant 1)', async () => {
    // Edge case: user existe pero no tiene fila en tenant_users (caso teórico:
    // tenant soft-deleted, link borrado manualmente). Antes el verify cae a
    // tenant_id=1 (tenant del owner) y atribuía el audit al tenant equivocado.
    // Ahora devolvemos 410 sin tocar nada.
    const { res, body } = await signup({ email: `orphan_${Date.now()}@example.com` });
    const tok = res.body._verification_token;
    const u = await fetchUserByEmail(body.email);
    const userId = u.id;
    // Borrar el link tenant_users para simular tenant huérfano.
    await pool.query('DELETE FROM tenant_users WHERE user_id = $1', [userId]);

    const v = await request(app).post('/api/auth/verify-email').send({ token: tok });
    expect(v.status).toBe(410);
    expect(v.body.reason).toBe('tenant_orphan');

    // Confirmar que el user NO quedó verificado (el verify se abortó antes del UPDATE).
    const { rows } = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [userId]);
    expect(rows[0].email_verified_at).toBeNull();
  });

  it('user verificado YA puede escribir (bloqueo blando desactivado post-verify)', async () => {
    const { res, body } = await signup();
    const tok = res.body._verification_token;
    // TANDA 2.7: hacer login después del signup (anti-enum no auto-loguea).
    const loginR = await loginAfter({ email: body.email, password: body.password });
    const userToken = loginR.token;

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
    const { res, body } = await signup();
    const oldToken = res.body._verification_token;
    // TANDA 2.7: signup ya no devuelve token; login después.
    const { token: userToken } = await loginAfter({ email: body.email, password: body.password });

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
    const { res, body } = await signup();
    const tok = res.body._verification_token;
    // TANDA 2.7: signup ya no devuelve token; login después.
    const { token: userToken } = await loginAfter({ email: body.email, password: body.password });

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
