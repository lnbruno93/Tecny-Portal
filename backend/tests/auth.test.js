/**
 * Tests de integración — Auth
 *
 * Cubre:
 *   POST /api/auth/login   — credenciales válidas, inválidas, usuario inexistente
 *   GET  /api/auth/me      — token válido
 *   Rutas protegidas       — sin token, token inválido
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');

let pool;
let token;

beforeAll(async () => {
  pool = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ─── Login ───────────────────────────────────────────────────
describe('POST /api/auth/login', () => {
  it('devuelve token con credenciales válidas', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: TEST_USER.password });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user.username).toBe(TEST_USER.username);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user).not.toHaveProperty('password_hash');

    token = res.body.token; // guardar para tests siguientes
  });

  it('rechaza contraseña incorrecta → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: 'wrong_password' });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  it('rechaza usuario inexistente → 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'noexiste', password: 'algo' });

    expect(res.status).toBe(401);
  });

  it('rechaza body vacío → 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({});

    expect(res.status).toBe(400);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2026-07-12 (auditoría TOTAL Externa P0-1): CAPTCHA gate en /login.
  //
  // Antes /login era el único endpoint público de auth SIN captcha (signup,
  // forgot-password, super-admin-invite sí tenían). Vulnerable a brute
  // force distribuido con IPs rotativas — el loginLimiter (10 fallos/15min
  // por IP) se sortea con 200 IPs. Fix: gate con hCaptcha invisible.
  //
  // Los tests fuerzan HCAPTCHA_ENABLED=true + HCAPTCHA_FORCE_IN_TESTS=1
  // para verificar el gate. Sin esas envs (comportamiento normal en test),
  // el captcha bypassa silenciosamente — los otros tests de este describe
  // siguen funcionando sin token.
  // ═══════════════════════════════════════════════════════════════════════
  describe('P0-1 captcha gate', () => {
    let originalEnabled, originalForce;
    beforeAll(() => {
      originalEnabled = process.env.HCAPTCHA_ENABLED;
      originalForce = process.env.HCAPTCHA_FORCE_IN_TESTS;
      process.env.HCAPTCHA_ENABLED = 'true';
      process.env.HCAPTCHA_FORCE_IN_TESTS = '1';
    });
    afterAll(() => {
      // Restaurar env vars — otros tests dependen del bypass default.
      if (originalEnabled === undefined) delete process.env.HCAPTCHA_ENABLED;
      else process.env.HCAPTCHA_ENABLED = originalEnabled;
      if (originalForce === undefined) delete process.env.HCAPTCHA_FORCE_IN_TESTS;
      else process.env.HCAPTCHA_FORCE_IN_TESTS = originalForce;
    });

    it('P0-1: rechaza login sin hcaptcha_response cuando captcha está enabled → 400', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: TEST_USER.username, password: TEST_USER.password });
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe('captcha_failed');
      // Mensaje debe orientar al usuario.
      expect(res.body.error).toMatch(/verifica|captcha/i);
    });

    it('P0-1: rechaza login con hcaptcha_response inválido → 400', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          username: TEST_USER.username,
          password: TEST_USER.password,
          hcaptcha_response: 'obviamente-un-token-invalido-que-hcaptcha-rechaza',
        });
      // Sin HCAPTCHA_SECRET (test), verifyCaptcha devuelve config_error
      // → response 400 con reason=captcha_failed.
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe('captcha_failed');
    });

    // 2026-07-12 (hotfix post-audit): regression test para el bug donde el
    // step 2 del flow 2FA re-enviaba el mismo captcha token (single-use en
    // hCaptcha) → duplicate → user bloqueado en "verificación ya fue usada".
    // Fix: si el request incluye `code`, el backend skippea el captcha gate.
    // Seguridad: step 2 asume que step 1 pasó con captcha válido; el TOTP
    // brute-force ya está cubierto por loginLimiter + lockout per-user.
    it('hotfix: step 2 del flow 2FA con code presente NO requiere captcha', async () => {
      // Sin hcaptcha_response y CON code → NO debe rebotar por captcha_failed.
      // El request va a rebotar por password/user/2FA inválidos (200 con
      // twofa_required o 401), pero NUNCA con reason=captcha_failed.
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          username: TEST_USER.username,
          password: TEST_USER.password,
          code: '123456', // TOTP dummy — no importa si es válido para este test
          // NOTA: intencionalmente SIN hcaptcha_response.
        });
      // Aceptamos cualquier response que NO sea captcha_failed. El path feliz
      // depende del state de 2FA del test user; lo que importa es que el
      // captcha NO haya rebotado el request antes.
      expect(res.body.reason).not.toBe('captcha_failed');
    });
  });
});

// ─── /me ─────────────────────────────────────────────────────
describe('GET /api/auth/me', () => {
  it('devuelve datos del usuario autenticado', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe(TEST_USER.username);
    // 2026-06-23 F4: el response del /me ya no incluye `perms` (14 booleans
    // del sistema viejo). En su lugar manda `caps` (array de slugs activos
    // o null para bypass) + `tenant_cap_rol`. El test admin tiene role=admin
    // global → no se materializan caps (bypass implícito), pero el campo
    // existe en el response shape.
    expect(res.body).toHaveProperty('caps');
  });

  // TANDA 4.C (billing pre-live 2026-06-25): el response de /me incluye
  // info del tenant para que el frontend pueda mostrar banners de
  // paid_until / suspended state.
  it('TANDA 4.C: incluye tenant {id, plan, paid_until, is_active}', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tenant');
    expect(res.body.tenant).toMatchObject({
      id:        expect.any(Number),
      plan:      expect.any(String),
      is_active: true, // tenant test default: paid_until NULL → grandfathered → active
    });
    // paid_until puede ser null (grandfathered) o una fecha — el shape debe
    // estar definido para que el frontend renderice consistente.
    expect('paid_until' in res.body.tenant).toBe(true);
    expect('suspended_at' in res.body.tenant).toBe(true);
  });

  // 2026-07-11 (bug Tek Haus): cuando `getTenantStatus` falla (cache miss +
  // DB hiccup en el helper), el catch fail-open dejaba `tenant: null` en el
  // response de /me. El frontend cacheaba eso en user.tenant=null → todas
  // las descargas de comprobantes salían brandeadas con "Tecny" (fallback
  // hardcoded). El fix agrega un fallback query directo a `tenants` que
  // garantiza al menos `nombre` + `pais`. Este test forza el fail del
  // helper y verifica que el response sigue trayendo `tenant.nombre`.
  it('fallback query directo a tenants si getTenantStatus falla → nombre presente', async () => {
    const tenantStatus = require('../src/lib/tenantStatus');
    // Forza reject en TODOS los llamados durante el scope del try (mockRejectedValue,
    // no Once — así también cubre eventual retry interno del helper).
    const spy = jest.spyOn(tenantStatus, 'getTenantStatus')
      .mockRejectedValue(new Error('simulated cache/DB hiccup'));
    try {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('tenant');
      // El fix garantiza que tenant NO es null aún con el helper roto — el
      // response cae al fallback query directo a `tenants`.
      expect(res.body.tenant).not.toBeNull();
      // Nombre es lo crítico para brand de comprobantes — no debe venir null.
      expect(res.body.tenant.nombre).toBeTruthy();
      expect(typeof res.body.tenant.nombre).toBe('string');
      // Pais siempre presente (default 'AR' si el row viene sin).
      expect(res.body.tenant.pais).toMatch(/^(AR|UY)$/);
      // En el fallback path, plan/paid_until quedan null (no los conocemos —
      // ver auth.js /me para racional del degraded response).
      expect(res.body.tenant.plan).toBeNull();
      expect(res.body.tenant.paid_until).toBeNull();
      // Verificamos que el spy efectivamente se disparó al menos 1 vez.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── Rutas protegidas ─────────────────────────────────────────
describe('Protección de rutas', () => {
  it('GET /api/envios sin token → 401', async () => {
    const res = await request(app).get('/api/envios');
    expect(res.status).toBe(401);
  });

  it('GET /api/envios con token inválido → 401', async () => {
    const res = await request(app)
      .get('/api/envios')
      .set('Authorization', 'Bearer tokenmalformado');
    expect(res.status).toBe(401);
  });

  it('GET /api/cajas/resumen sin token → 401', async () => {
    const res = await request(app).get('/api/cajas/resumen');
    expect(res.status).toBe(401);
  });

  it('TANDA 3 fix T7: cache devuelve password_changed_at corrupto → 401 (fail-closed)', async () => {
    // Cache poisoning / data corruption / parser bug futuro pueden hacer que
    // userAuthCache devuelva un timestamp malformado. Sin el NaN guard, la
    // comparación `tokenIssuedMs < NaN` daba false → token VIEJO aceptado
    // como válido. Con el fix: rechazamos con 401 fail-closed.
    const userAuthCache = require('../src/lib/userAuthCache');
    const spy = jest.spyOn(userAuthCache, 'getUserAuth').mockResolvedValueOnce({
      password_changed_at: 'not-a-valid-date',
      email_verified_at: null,
    });
    try {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/sesión inválida/i);
    } finally {
      spy.mockRestore();
    }
  });
});

// 2026-07-12 (auditoría TOTAL Auth P1-1): audit trail login events.
describe('Auth audit trail — Auth P1-1', () => {
  // Helper: contar rows en audit_logs con una acción específica del user 1.
  async function countAuditRows(accion) {
    // El audit es fire-and-forget con setImmediate — esperamos un tick para que
    // la fila persista antes de contar.
    await new Promise((r) => setImmediate(r));
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE tabla = 'users' AND accion = $1 AND registro_id = '1'`,
      [accion]
    );
    return rows[0].n;
  }

  it('login exitoso persiste audit LOGIN', async () => {
    const before = await countAuditRows('LOGIN');
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: TEST_USER.password });
    expect(res.status).toBe(200);
    // Dejamos algunos ms para que el audit async persista.
    await new Promise((r) => setTimeout(r, 100));
    const after = await countAuditRows('LOGIN');
    expect(after).toBe(before + 1);
  });

  it('login fallido persiste audit LOGIN_FAILED', async () => {
    const before = await countAuditRows('LOGIN_FAILED');
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: 'wrong_password' });
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 100));
    const after = await countAuditRows('LOGIN_FAILED');
    expect(after).toBe(before + 1);
  });

  it('logout persiste audit LOGOUT', async () => {
    // Login para obtener token válido.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USER.username, password: TEST_USER.password });
    const tok = login.body.token;

    const before = await countAuditRows('LOGOUT');
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    const after = await countAuditRows('LOGOUT');
    expect(after).toBe(before + 1);
  });
});
