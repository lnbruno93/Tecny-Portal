/**
 * Tests de integración — CRUD: Usuarios, Config, Contactos, Vendedores
 *
 * Cubre:
 *   Usuarios   POST / GET / PUT / DELETE  (admin only)
 *   Config     GET / PUT                  (GET: cualquier financiera; PUT: admin)
 *   Contactos  POST / GET / PUT / DELETE  (requiere 'cajas')
 *   Vendedores POST / GET / DELETE        (requiere 'financiera')
 *   Permisos   403 cuando falta permiso
 */
const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const bcrypt  = require('bcrypt');

let pool;
let adminToken;
let opToken;    // usuario sin permisos
let opId;

let contactoId;
let vendedorId;
let nuevoUserId;

beforeAll(async () => {
  pool = await setupTestDb();

  // Autenticar como admin
  const r1 = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = r1.body.token;

  // Crear usuario 'op' sin caps para testear 403.
  // 2026-06-23 F4: sin filas en tenant_user_roles + user_capabilities →
  // resolveCaps devuelve rol='custom' con caps=Set() (default-deny). El
  // middleware requireCapability rebota con 403 en cualquier slug.
  const hash = await bcrypt.hash('op_pass_123', 10);
  const { rows } = await pool.query(
    'INSERT INTO users (nombre, username, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    ['Op User', 'opuser', 'opuser@test.local', hash, 'op']
  );
  opId = rows[0].id;
  // Linkear el opuser al tenant 1 — sin esto, /api/auth/login no le resuelve
  // tenant_id en el JWT y muchos endpoints rebotan antes del check de caps.
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'member')
     ON CONFLICT DO NOTHING`,
    [opId]
  );

  const r2 = await request(app)
    .post('/api/auth/login')
    .send({ username: 'opuser', password: 'op_pass_123' });
  opToken = r2.body.token;
});

afterAll(async () => {
  await teardownTestDb(pool);
});

// ═══════════════════════════════════════════════════════════════
// USUARIOS — admin only
// ═══════════════════════════════════════════════════════════════
describe('GET /api/usuarios', () => {
  it('admin puede listar usuarios', async () => {
    const res = await request(app)
      .get('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('sin token → 401', async () => {
    const res = await request(app).get('/api/usuarios');
    expect(res.status).toBe(401);
  });

  it('usuario op → 403', async () => {
    const res = await request(app)
      .get('/api/usuarios')
      .set('Authorization', `Bearer ${opToken}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/usuarios', () => {
  it('admin crea usuario → 201', async () => {
    // 2026-06-23 F4: el POST /usuarios ya no recibe `perms` (schema .strict()
    // lo rechaza). Capabilities se asignan post-create vía PUT
    // /api/capabilities/users/:id.
    // 2026-06-26 (#446): email pasa a ser OBLIGATORIO.
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        nombre:   'Nuevo Vendedor',
        username: 'vendedor01',
        email:    'vendedor01@test.local',
        password: 'pass12345',
        role:     'op',
      });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('vendedor01');
    expect(res.body.email).toBe('vendedor01@test.local');
    nuevoUserId = res.body.id;
  });

  it('#446: rechaza creación sin email → 400 (email obligatorio)', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        nombre:   'Sin Email',
        username: 'noemail01',
        password: 'pass12345',
        role:     'op',
      });
    expect(res.status).toBe(400);
    // El user NO debe haberse creado (verificación defensiva)
    const check = await pool.query(`SELECT id FROM users WHERE username='noemail01'`);
    expect(check.rows).toHaveLength(0);
  });

  it('rechaza username duplicado → 409', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        nombre: 'Otro', username: 'vendedor01', email: 'otro@test.local', password: 'pass12345', role: 'op',
      });
    expect(res.status).toBe(409);
  });

  it('permite recrear un usuario con el mismo username/email tras borrarlo', async () => {
    const mk = (nombre) => ({ nombre, username: 'reuse01', email: 'reuse01@x.com', password: 'pass12345', role: 'op' });
    const u1 = await request(app).post('/api/usuarios').set('Authorization', `Bearer ${adminToken}`).send(mk('Reusable'));
    expect(u1.status).toBe(201);
    const del = await request(app).delete(`/api/usuarios/${u1.body.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(del.status).toBe(200);
    const u2 = await request(app).post('/api/usuarios').set('Authorization', `Bearer ${adminToken}`).send(mk('Reusable 2'));
    expect(u2.status).toBe(201); // antes daba 409 por el UNIQUE que ignoraba deleted_at
  });

  it('rechaza nombre vacío → 400', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: '', username: 'x_user', email: 'x@test.local', password: 'pass12345', role: 'op' });
    expect(res.status).toBe(400);
  });

  it('rechaza password corto → 400', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Alguien', username: 'a_user', email: 'a@test.local', password: '123', role: 'op' });
    expect(res.status).toBe(400);
  });

  it('rechaza username con mayúsculas → 400', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Alguien', username: 'UserBad', email: 'b@test.local', password: 'pass12345', role: 'op' });
    expect(res.status).toBe(400);
  });

  it('#446: rechaza email mal formado → 400', async () => {
    const res = await request(app)
      .post('/api/usuarios')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Alguien', username: 'bademail', email: 'no-es-email', password: 'pass12345', role: 'op' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/usuarios/:id', () => {
  it('admin actualiza nombre del usuario', async () => {
    const res = await request(app)
      .put(`/api/usuarios/${nuevoUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Vendedor Actualizado' });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe('Vendedor Actualizado');
  });

  it('admin puede actualizar caps vía el endpoint nuevo', async () => {
    // 2026-06-23 F4: el endpoint /usuarios ya no acepta `perms`. Caps + rol
    // se editan ahora vía PUT /api/capabilities/users/:id. Mandamos un body
    // mínimo (sin overrides para no acoplar el test a un slug específico).
    const res = await request(app)
      .put(`/api/capabilities/users/${nuevoUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rol: 'vendedor' });
    expect(res.status).toBe(200);
    expect(res.body.rol).toBe('vendedor');
  });

  it('ID inexistente → 404', async () => {
    const res = await request(app)
      .put('/api/usuarios/999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('sin campos → 400', async () => {
    const res = await request(app)
      .put(`/api/usuarios/${nuevoUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('TANDA 3 fix M3: edit de nombre solo (no sensitive) NO invalida cache de auth', async () => {
    // M3: invalidación gratuita en edits de fields no-cacheados produce
    // stampede en réplicas. Verificamos que solo se invalida si
    // bumpPwChanged=true.
    //
    // 2026-06-23 F4: el endpoint /usuarios ya no maneja perms — solo role +
    // password disparan bumpPwChanged ahora. Cambios de caps/rol-de-tenant
    // viajan por /api/capabilities/users/:id (que también bumpea, pero eso
    // lo cubre capabilities-routes.test.js).
    const userAuthCache = require('../src/lib/userAuthCache');
    const spy = jest.spyOn(userAuthCache, 'invalidateUserAuth');
    try {
      // Cambio NO sensitive: solo nombre.
      const r1 = await request(app)
        .put(`/api/usuarios/${nuevoUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ nombre: 'Solo Nombre' });
      expect(r1.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();

      // Cambio sensitive: password → bumpPwChanged=true → invalidate.
      spy.mockClear();
      const r2 = await request(app)
        .put(`/api/usuarios/${nuevoUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ password: 'nuevopass12345' });
      expect(r2.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(nuevoUserId);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('DELETE /api/usuarios/:id', () => {
  it('admin elimina usuario → 200', async () => {
    const res = await request(app)
      .delete(`/api/usuarios/${nuevoUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('usuario ya eliminado → 404', async () => {
    const res = await request(app)
      .delete(`/api/usuarios/${nuevoUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('no puede eliminar su propia cuenta → 400', async () => {
    // el token del admin es el TEST_USER — buscar su ID
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);
    const myId = meRes.body.id;

    const res = await request(app)
      .delete(`/api/usuarios/${myId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
describe('GET /api/config', () => {
  it('admin puede leer config', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});

// ── #443: system-limits + #445: last-tc ────────────────────────────────
describe('GET /api/config/system-limits (#443)', () => {
  it('devuelve la lista de límites informativos', async () => {
    const res = await request(app)
      .get('/api/config/system-limits')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.limits)).toBe(true);
    expect(res.body.limits.length).toBeGreaterThan(0);
    // Cada item tiene { t, d } (title, description)
    for (const item of res.body.limits) {
      expect(typeof item.t).toBe('string');
      expect(typeof item.d).toBe('string');
    }
  });

  it('OCR rate-limit muestra el valor REAL (60/hora, no el 10 viejo)', async () => {
    const res = await request(app)
      .get('/api/config/system-limits')
      .set('Authorization', `Bearer ${adminToken}`);
    const ocr = res.body.limits.find((l) => l.t.toLowerCase().includes('ocr'));
    expect(ocr).toBeDefined();
    expect(ocr.d).toContain('60');
  });

  it('401 sin JWT', async () => {
    const res = await request(app).get('/api/config/system-limits');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/config/last-tc (#445)', () => {
  it('devuelve fallback 1400 cuando no hay ventas con TC en últimos 90d (tenant AR)', async () => {
    // setup: borrar cualquier venta con TC en últimos 90d del tenant 1
    // (las otras suites pueden crear ventas — limpiamos para test determinístico)
    await pool.query(
      `UPDATE ventas SET tc_venta = NULL
        WHERE tenant_id = 1 AND created_at >= NOW() - INTERVAL '90 days'`
    );

    const res = await request(app)
      .get('/api/config/last-tc')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // 2026-06-29 Multi-país F5: fallback ahora viene de tc_defaults_pais
    // (seed AR=1400). Para tenant 1 (AR) sigue siendo 1400.
    expect(Number(res.body.tc)).toBe(1400);
    expect(res.body.source).toBe('fallback');
    expect(res.body.pais).toBe('AR');
  });

  it('devuelve el TC de la venta más reciente cuando existe', async () => {
    // Insertar venta directa con tc_venta = 1750. Necesitamos un cliente para FK.
    const { rows: clienteRows } = await pool.query(
      `SELECT id FROM contactos WHERE tenant_id = 1 AND deleted_at IS NULL LIMIT 1`
    );
    if (!clienteRows[0]) {
      // Skip si no hay contactos seeded.
      return;
    }
    await pool.query(
      `INSERT INTO ventas (cliente_id, fecha, total, tc_venta, tenant_id)
       VALUES ($1, CURRENT_DATE, 100000, 1750, 1)`,
      [clienteRows[0].id]
    );

    const res = await request(app)
      .get('/api/config/last-tc')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.tc)).toBe(1750);
    expect(res.body.source).toBe('venta');
    // F5: el response siempre incluye `pais` (AR para tenant 1).
    expect(res.body.pais).toBe('AR');

    // Cleanup
    await pool.query(`DELETE FROM ventas WHERE tc_venta = 1750 AND tenant_id = 1`);
  });

  // 2026-06-29 Multi-país F5: tenant UY → fallback usa tc_defaults_pais (UY=40),
  // no el 1400 hardcoded de AR. Insertamos un tenant UY temporal y firmamos
  // JWT manual (mismo pattern que multipais-f2.test.js).
  it('F5: tenant UY → fallback usa tc_defaults_pais (40 UYU/USD), no 1400', async () => {
    const jwt = require('jsonwebtoken');
    const bcrypt = require('bcrypt');
    const tenantStatus = require('../src/lib/tenantStatus');
    const TENANT_UY_LASTTC = 9821;
    const uyUsername = 'uylasttc_owner';

    // Setup tenant UY + user owner.
    await pool.query(
      `INSERT INTO tenants (id, nombre, slug, plan, pais) VALUES ($1, $2, $3, 'starter', 'UY')
         ON CONFLICT (id) DO UPDATE SET pais = 'UY'`,
      [TENANT_UY_LASTTC, 'F5 UY LastTc', 'f5-uy-lasttc']
    );
    await pool.query(
      `SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1))`
    );
    await tenantStatus.invalidateTenantStatus(TENANT_UY_LASTTC);

    const hash = await bcrypt.hash('uylasttc123', 10);
    // Limpiar runs previos (puede quedar suite anterior). users tiene UNIQUE
    // sobre LOWER(email) — no podemos depender de ON CONFLICT directo por
    // username (no necesariamente único en este schema).
    await pool.query(`DELETE FROM users WHERE username = $1`, [uyUsername]);
    const { rows: uRows } = await pool.query(
      `INSERT INTO users (nombre, username, email, password_hash, role)
         VALUES ('UY LastTc Owner', $1, $2, $3, 'admin')
       RETURNING id`,
      [uyUsername, `${uyUsername}@test.local`, hash]
    );
    const uyUserId = uRows[0].id;
    await pool.query(
      `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET rol = 'owner'`,
      [TENANT_UY_LASTTC, uyUserId]
    );

    const uyTok = jwt.sign(
      {
        id: uyUserId, username: uyUsername, email: `${uyUsername}@test.local`,
        role: 'admin', tenant_id: TENANT_UY_LASTTC, tenant_rol: 'owner',
        iat_ms: Date.now(),
      },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    try {
      const res = await request(app)
        .get('/api/config/last-tc')
        .set('Authorization', `Bearer ${uyTok}`);
      expect(res.status).toBe(200);
      // Sin ventas con TC en el tenant UY nuevo → fallback. Y el fallback
      // debe ser 40 (UYU/USD seed), NO 1400.
      expect(res.body.source).toBe('fallback');
      expect(res.body.pais).toBe('UY');
      expect(Number(res.body.tc)).toBe(40);
    } finally {
      // Cleanup.
      await pool.query(`DELETE FROM tenant_users WHERE tenant_id = $1`, [TENANT_UY_LASTTC]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [uyUserId]);
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [TENANT_UY_LASTTC]);
      await tenantStatus.invalidateTenantStatus(TENANT_UY_LASTTC);
    }
  });

  it('401 sin JWT', async () => {
    const res = await request(app).get('/api/config/last-tc');
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/config', () => {
  it('admin actualiza pct_financiera → 200', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pct_financiera: 3.5 });
    expect(res.status).toBe(200);
    expect(Number(res.body.pct_financiera)).toBe(3.5);
  });

  it('rechaza pct_financiera negativo → 400', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pct_financiera: -1 });
    expect(res.status).toBe(400);
  });

  it('rechaza pct_financiera > 100 → 400', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ pct_financiera: 101 });
    expect(res.status).toBe(400);
  });

  it('usuario op (sin permiso financiera) → 403', async () => {
    const res = await request(app)
      .put('/api/config')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ pct_financiera: 5 });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════
// CONTACTOS (requiere permiso 'cajas')
// ═══════════════════════════════════════════════════════════════
describe('POST /api/contactos', () => {
  it('admin crea contacto → 201', async () => {
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Juan', apellido: 'Pérez', tipo: 'cliente' });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Juan');
    contactoId = res.body.id;
  });

  it('rechaza tipo inválido → 400', async () => {
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'X', tipo: 'desconocido' });
    expect(res.status).toBe(400);
  });

  it('rechaza nombre vacío → 400', async () => {
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: '', tipo: 'cliente' });
    expect(res.status).toBe(400);
  });

  it('usuario sin permiso contactos NO puede crear → 403 (auditoría 2026-06-06 Sec H1)', async () => {
    // Antes: agenda compartida — cualquier sesión podía crear contactos.
    // Ahora: GET sigue abierto (necesario para quick-add desde Ventas/Cajas/
    // Proyectos), pero POST/PUT/DELETE requieren permiso 'contactos'. El
    // toggle del frontend ahora bloquea efectivamente la edición.
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ nombre: 'Test', tipo: 'cliente' });
    expect(res.status).toBe(403);
  });

  it('usuario op con capability contactos.crear_borrar SÍ puede crear → 201', async () => {
    // 2026-06-23 F4: las caps viven ahora en tenant_user_roles +
    // user_capabilities. Insertamos un override `contactos.crear_borrar=true`
    // para el opuser y re-logueamos para que el JWT lo embeba. Igual que
    // antes: en producción, el admin edita caps → PUT /api/capabilities/users
    // bumpea password_changed_at → user re-loguea con caps nuevas.
    await pool.query(
      `INSERT INTO tenant_user_roles (tenant_id, user_id, rol) VALUES (1, $1, 'custom')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET rol = 'custom'`,
      [opId]
    );
    await pool.query(
      `INSERT INTO user_capabilities (tenant_id, user_id, capability_slug, enabled)
       VALUES (1, $1, 'contactos.crear_borrar', true)
       ON CONFLICT (tenant_id, user_id, capability_slug) DO UPDATE SET enabled = true`,
      [opId]
    );
    const reLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'opuser', password: 'op_pass_123' });
    const newOpToken = reLogin.body.token;
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${newOpToken}`)
      .send({ nombre: 'Test op', tipo: 'cliente' });
    expect(res.status).toBe(201);
    // Limpieza: dejar el opuser como estaba para no contaminar otros tests.
    await pool.query(
      `DELETE FROM user_capabilities WHERE tenant_id = 1 AND user_id = $1 AND capability_slug = 'contactos.crear_borrar'`,
      [opId]
    );
  });

  it('GET sigue abierto sin permiso (necesario para quick-add)', async () => {
    // El GET de contactos lo necesitan los quick-add desde otros módulos —
    // si lo bloqueamos, rompemos Ventas/Cajas/Proyectos para users sin
    // permiso de contactos.
    const res = await request(app)
      .get('/api/contactos')
      .set('Authorization', `Bearer ${opToken}`);
    expect(res.status).toBe(200);
  });

  it('sin token → 401', async () => {
    const res = await request(app).post('/api/contactos').send({ nombre: 'X', tipo: 'cliente' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/contactos', () => {
  it('devuelve lista de contactos paginada', async () => {
    const res = await request(app)
      .get('/api/contactos')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeTruthy();
    const ids = res.body.data.map(c => c.id);
    expect(ids).toContain(contactoId);
  });
});

describe('PUT /api/contactos/:id', () => {
  it('actualiza apellido del contacto', async () => {
    const res = await request(app)
      .put(`/api/contactos/${contactoId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ apellido: 'García' });
    expect(res.status).toBe(200);
    expect(res.body.apellido).toBe('García');
  });

  it('actualiza tipo del contacto', async () => {
    const res = await request(app)
      .put(`/api/contactos/${contactoId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ tipo: 'inversor' });
    expect(res.status).toBe(200);
    expect(res.body.tipo).toBe('inversor');
  });

  it('ID inexistente → 404', async () => {
    const res = await request(app)
      .put('/api/contactos/999999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/contactos/:id', () => {
  it('elimina (soft-delete) el contacto', async () => {
    const res = await request(app)
      .delete(`/api/contactos/${contactoId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('contacto eliminado ya no aparece en GET', async () => {
    const res = await request(app)
      .get('/api/contactos')
      .set('Authorization', `Bearer ${adminToken}`);
    const ids = res.body.data.map(c => c.id);
    expect(ids).not.toContain(contactoId);
  });

  it('eliminar de nuevo → 404', async () => {
    const res = await request(app)
      .delete(`/api/contactos/${contactoId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════
// VENDEDORES (requiere permiso 'financiera')
// ═══════════════════════════════════════════════════════════════
describe('POST /api/vendedores', () => {
  it('admin crea vendedor → 201', async () => {
    const res = await request(app)
      .post('/api/vendedores')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: 'Vendedor Test' });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Vendedor Test');
    vendedorId = res.body.id;
  });

  it('rechaza nombre vacío → 400', async () => {
    const res = await request(app)
      .post('/api/vendedores')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nombre: '' });
    expect(res.status).toBe(400);
  });

  it('usuario sin permiso financiera → 403', async () => {
    const res = await request(app)
      .post('/api/vendedores')
      .set('Authorization', `Bearer ${opToken}`)
      .send({ nombre: 'Intento' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/vendedores', () => {
  it('devuelve lista de vendedores ordenada por nombre', async () => {
    const res = await request(app)
      .get('/api/vendedores')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = res.body.map(v => v.id);
    expect(ids).toContain(vendedorId);
  });
});

describe('DELETE /api/vendedores/:id', () => {
  it('elimina el vendedor → 200', async () => {
    const res = await request(app)
      .delete(`/api/vendedores/${vendedorId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('vendedor eliminado ya no aparece en GET', async () => {
    const res = await request(app)
      .get('/api/vendedores')
      .set('Authorization', `Bearer ${adminToken}`);
    const ids = res.body.map(v => v.id);
    expect(ids).not.toContain(vendedorId);
  });
});
