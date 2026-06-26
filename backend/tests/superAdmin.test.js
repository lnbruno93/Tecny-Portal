/**
 * Tests integration para Super-Admin (#353 Fases 1+2+B.1).
 *
 * Cubre:
 *   - 401 sin JWT.
 *   - 403 con JWT válido pero is_super_admin=false.
 *   - 200 + payload correcto cuando is_super_admin=true.
 *   - GET /me devuelve user_id correcto.
 *   - GET /tenants devuelve todos los tenants (cross-tenant).
 *   - GET /tenants?plan=X filtra correctamente.
 *   - GET /tenants?search=X filtra por nombre/slug.
 *   - GET /tenants/:id devuelve detalle + audit actions.
 *   - GET /tenants/:id devuelve 404 si no existe.
 *   - Logging: 403 emite warn log (no validamos formato exacto).
 *   - GET /metrics devuelve tenants_by_plan con los 4 planes canónicos.
 *   - GET /metrics/recent-actions devuelve feed cross-tenant con join a
 *     tenant.nombre + user.username; respeta param limit; gate super-admin.
 *
 * Caveat de testing local:
 *   En local NO existe el role `tecny_admin` con BYPASSRLS. db.adminQuery
 *   cae al pool principal (con role normal). Pero como mi role local ES
 *   superuser+BYPASSRLS, ve todo igual. Los tests pasan con la misma
 *   lógica que prod (donde el role admin separado bypassea RLS de verdad).
 *
 * Setup específico: marcamos testadmin (id=1) como super-admin via
 * UPDATE directo a la DB en beforeAll. Invalidamos cache después.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const userAuthCache = require('../src/lib/userAuthCache');

let pool;
let superAdminToken;   // testadmin con is_super_admin=true
let regularUserToken;  // otro user (NO super-admin)

beforeAll(async () => {
  pool = await setupTestDb();

  // Marcar testadmin (id=1) como super-admin.
  await pool.query(`UPDATE users SET is_super_admin = true WHERE id = 1`);
  // Invalidar cache para que el próximo getUserAuth lea el nuevo valor.
  await userAuthCache.invalidateUserAuth(1);

  superAdminToken = jwt.sign(
    {
      id: 1, username: TEST_USER.username, email: TEST_USER.email,
      role: TEST_USER.role, tenant_id: 1, tenant_rol: 'owner',
      is_super_admin: true,
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  // Crear un user "regular" (NO super-admin) en tenant 1.
  const hash = await bcrypt.hash('pass1234', 10);
  const { rows: u2Rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, is_super_admin)
     VALUES ('Regular User', 'regularsa', 'reg@test.local', $1, 'admin', false)
     RETURNING id`,
    [hash]
  );
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'admin')`,
    [u2Rows[0].id]
  );
  regularUserToken = jwt.sign(
    {
      id: u2Rows[0].id, username: 'regularsa', email: 'reg@test.local',
      role: 'admin', tenant_id: 1, tenant_rol: 'admin',
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  // Crear tenant 2 para los tests cross-tenant.
  await pool.query(
    `INSERT INTO tenants (id, nombre, slug, plan) VALUES (777, 'SA Test Tenant', 'sa-test', 'pro')
       ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1))`
  );
});

afterAll(async () => {
  // Cleanup
  await pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id IN (1, 777)`);
  await pool.query(`DELETE FROM tenants WHERE id = 777`);
  await pool.query(`UPDATE users SET is_super_admin = false WHERE id = 1`);
  await userAuthCache.invalidateUserAuth(1);
  await teardownTestDb(pool);
});

describe('Super-Admin auth (requireSuperAdmin)', () => {
  it('401 sin JWT', async () => {
    const r = await request(app).get('/api/super-admin/me');
    expect(r.status).toBe(401);
  });

  it('403 con JWT válido pero is_super_admin=false', async () => {
    const r = await request(app)
      .get('/api/super-admin/me')
      .set('Authorization', `Bearer ${regularUserToken}`);
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('super_admin_required');
  });

  it('200 con super-admin JWT', async () => {
    const r = await request(app)
      .get('/api/super-admin/me')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.is_super_admin).toBe(true);
    expect(r.body.user_id).toBe(1);
    expect(r.body.username).toBe(TEST_USER.username);
  });
});

describe('GET /api/super-admin/tenants', () => {
  // PERF-2 (audit 2026-06-22): el endpoint ahora devuelve
  // { tenants, total, limit, offset, sort } en lugar del array crudo.
  // Tests actualizados para leer desde `.tenants`.
  it('devuelve { tenants, total, limit, offset, sort }', async () => {
    // 2026-06-26 fix #437: sort=id:asc + limit=200 funcionaba con CI fresh DB,
    // pero local-DB con 200+ tenants acumulados de runs viejos hace que tenant
    // 777 caiga fuera. Fix definitivo: filtrar por search=sa-test (slug del 777)
    // — siempre lo encuentra, sin importar la cantidad de filas en la tabla.
    // Para tenant 1 chequeamos shape genérico en otro request, sin asumir presencia.
    const r = await request(app)
      .get('/api/super-admin/tenants?sort=id:asc&limit=200&search=sa-test')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.tenants)).toBe(true);
    expect(typeof r.body.total).toBe('number');
    expect(typeof r.body.limit).toBe('number');
    expect(typeof r.body.offset).toBe('number');
    expect(r.body.sort).toMatchObject({ col: expect.any(String), dir: expect.any(String) });
    const ids = r.body.tenants.map(t => t.id);
    expect(ids).toContain(777);
  });

  it('cada tenant incluye health_score + breakdown + category (#440)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?limit=5&sort=id:asc')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.tenants.length).toBeGreaterThan(0);
    const t = r.body.tenants[0];
    expect(typeof t.health_score).toBe('number');
    expect(t.health_score).toBeGreaterThanOrEqual(0);
    expect(t.health_score).toBeLessThanOrEqual(100);
    expect(t.health_breakdown).toEqual(expect.objectContaining({
      actividad: expect.any(Number),
      cobros:    expect.any(Number),
      adopcion:  expect.any(Number),
      asientos:  expect.any(Number),
    }));
    expect([
      'excellent', 'healthy', 'at-risk', 'cold', 'onboarding', 'suspended',
    ]).toContain(t.health_category);
  });

  it('GET /tenants/:id incluye health_score + breakdown + category (#440)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/1')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(typeof r.body.health_score).toBe('number');
    expect(r.body.health_breakdown).toHaveProperty('actividad');
    expect(r.body.health_breakdown).toHaveProperty('cobros');
    expect(r.body.health_breakdown).toHaveProperty('adopcion');
    expect(r.body.health_breakdown).toHaveProperty('asientos');
    expect(typeof r.body.health_category).toBe('string');
  });

  it('tenant suspendido → health_score=0 y category=suspended', async () => {
    // Setup: suspender tenant 777, verificar el cálculo, después limpiar.
    await pool.query(
      `UPDATE tenants SET suspended_at = NOW(), suspended_reason = 'test #440' WHERE id = 777`
    );
    const r = await request(app)
      .get('/api/super-admin/tenants/777')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.health_score).toBe(0);
    expect(r.body.health_category).toBe('suspended');
    // Cleanup
    await pool.query(
      `UPDATE tenants SET suspended_at = NULL, suspended_reason = NULL WHERE id = 777`
    );
  });

  it('cada tenant incluye stats: mrr_usd, users_count, last_venta_at, signups_30d', async () => {
    // 2026-06-26 fix #437: mismo patrón que el test de arriba. sort=id:asc
    // garantiza que tenant=1 esté en la primera página del response.
    const r = await request(app)
      .get('/api/super-admin/tenants?sort=id:asc&limit=200')
      .set('Authorization', `Bearer ${superAdminToken}`);
    const t = r.body.tenants.find(x => x.id === 1);
    expect(t).toBeDefined();
    expect(typeof t.mrr_usd).toBe('number');
    expect(typeof t.users_count).toBe('number');
    expect(typeof t.signups_30d).toBe('number');
    expect(['object', 'string']).toContain(typeof t.last_venta_at);
  });

  it('filtro ?plan=pro devuelve solo plan pro', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?plan=pro')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.tenants.every(t => t.plan === 'pro')).toBe(true);
    expect(r.body.tenants.find(t => t.id === 777)).toBeDefined();
  });

  it('filtro ?plan=invalid es ignorado (no rompe la query)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?plan=hackplan')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.tenants.length).toBeGreaterThanOrEqual(2);
  });

  it('filtro ?search=sa-test devuelve match por slug', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?search=sa-test')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.tenants.length).toBeGreaterThanOrEqual(1);
    expect(r.body.tenants.some(t => t.slug === 'sa-test')).toBe(true);
  });

  it('filtro ?suspended=true devuelve solo suspendidos', async () => {
    await pool.query(
      `UPDATE tenants SET suspended_at = NOW(), suspended_reason = 'test' WHERE id = 777`
    );
    const r = await request(app)
      .get('/api/super-admin/tenants?suspended=true')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.tenants.every(t => t.suspended_at !== null)).toBe(true);
    expect(r.body.tenants.find(t => t.id === 777)).toBeDefined();

    await pool.query(
      `UPDATE tenants SET suspended_at = NULL, suspended_reason = NULL WHERE id = 777`
    );
  });

  // PERF-2 nuevos tests — pagination + sort
  it('?limit=1 acota a 1 fila pero total refleja el universo completo', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?limit=1')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.tenants).toHaveLength(1);
    expect(r.body.limit).toBe(1);
    expect(r.body.total).toBeGreaterThanOrEqual(2);
  });

  it('?limit=999 clamps al MAX_LIMIT (200), no devuelve 999', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?limit=999')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    // El backend debe degradar a default (50) o clamp a 200, NO usar 999.
    expect(r.body.limit).toBeLessThanOrEqual(200);
  });

  it('?offset=N paginación funciona (segunda página no overlap con primera)', async () => {
    const r1 = await request(app)
      .get('/api/super-admin/tenants?limit=1&offset=0')
      .set('Authorization', `Bearer ${superAdminToken}`);
    const r2 = await request(app)
      .get('/api/super-admin/tenants?limit=1&offset=1')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.tenants[0].id).not.toBe(r2.body.tenants[0].id);
  });

  it('?sort=nombre:asc ordena alfabéticamente ascendente', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?sort=nombre:asc')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.sort).toMatchObject({ col: 'nombre', dir: 'asc' });
    const names = r.body.tenants.map(t => t.nombre);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('?sort=invalid_col:asc cae al default sin romper (whitelist)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?sort=DROP_TABLE:asc')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    // Default: created_at desc — la whitelist filtra el input malicioso.
    expect(r.body.sort.col).toBe('created_at');
  });
});

describe('GET /api/super-admin/tenants/:id', () => {
  it('devuelve detalle del tenant 1', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/1')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(1);
    expect(typeof r.body.mrr_usd).toBe('number');
    expect(Array.isArray(r.body.recent_admin_actions)).toBe(true);
  });

  it('404 si el tenant no existe', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/99999')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(404);
  });

  it('400 si id inválido', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/abc')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(400);
  });

  it('regular user recibe 403 (no super-admin)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/1')
      .set('Authorization', `Bearer ${regularUserToken}`);
    expect(r.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Fase 2 — Mutations + Activity + Metrics
// ─────────────────────────────────────────────────────────────────────────

describe('PATCH /api/super-admin/tenants/:id', () => {
  beforeEach(async () => {
    // Reset estado del tenant 777 — los tests muteán esto.
    // Incluimos nombre+slug para que los tests de rename (#439) tengan
    // valores conocidos como punto de partida.
    await pool.query(
      `UPDATE tenants
          SET plan='pro', suspended_at=NULL, suspended_reason=NULL,
              trial_until=NULL, custom_mrr_usd=NULL, notes=NULL,
              nombre='SA Test Tenant', slug='sa-test'
        WHERE id=777`
    );
    await pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id = 777`);
  });

  it('cambia plan + setea custom_mrr_usd cuando va a enterprise', async () => {
    const r = await request(app)
      .patch('/api/super-admin/tenants/777')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ plan: 'enterprise', custom_mrr_usd: 250, reason: 'deal cerrado' });
    expect(r.status).toBe(200);
    expect(r.body.plan).toBe('enterprise');
    expect(Number(r.body.custom_mrr_usd)).toBe(250);
    expect(r.body.mrr_usd).toBe(250);
  });

  it('actualiza notes', async () => {
    const r = await request(app)
      .patch('/api/super-admin/tenants/777')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ notes: 'Cliente referido por X', reason: 'CRM' });
    expect(r.status).toBe(200);
    expect(r.body.notes).toBe('Cliente referido por X');
  });

  it('audit trail: PATCH crea fila en tenant_admin_actions con action correcto', async () => {
    await request(app)
      .patch('/api/super-admin/tenants/777')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ plan: 'starter', reason: 'downgrade' });
    const { rows } = await pool.query(
      `SELECT action, reason, before_state, after_state
         FROM tenant_admin_actions WHERE tenant_id = 777`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('plan_change');
    expect(rows[0].reason).toBe('downgrade');
    expect(rows[0].before_state.plan).toBe('pro');
    expect(rows[0].after_state.plan).toBe('starter');
  });

  it('coherencia: al cambiar plan != trial, limpia trial_until automáticamente', async () => {
    // Setup: tenant en trial con trial_until seteado.
    await pool.query(
      `UPDATE tenants SET plan='trial', trial_until=CURRENT_DATE + 30 WHERE id=777`
    );
    // Pasamos a pro — trial_until debería quedar NULL.
    const r = await request(app)
      .patch('/api/super-admin/tenants/777')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ plan: 'pro', reason: 'upgraded' });
    expect(r.status).toBe(200);
    expect(r.body.trial_until).toBeNull();
  });

  it('rechaza body vacío (debe tener al menos un campo mutable)', async () => {
    const r = await request(app)
      .patch('/api/super-admin/tenants/777')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('rechaza campo no permitido (.strict())', async () => {
    const r = await request(app)
      .patch('/api/super-admin/tenants/777')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ plan: 'pro', some_random_field: 'hack' });
    expect(r.status).toBe(400);
  });

  it('404 si tenant no existe', async () => {
    const r = await request(app)
      .patch('/api/super-admin/tenants/99999')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ notes: 'x' });
    expect(r.status).toBe(404);
  });

  it('regular user recibe 403', async () => {
    const r = await request(app)
      .patch('/api/super-admin/tenants/777')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({ notes: 'x' });
    expect(r.status).toBe(403);
  });

  // ── Rename feature (#439) ────────────────────────────────────────────────
  describe('rename (nombre + slug, feature #439)', () => {
    it('cambia nombre solo (sin tocar slug)', async () => {
      const r = await request(app)
        .patch('/api/super-admin/tenants/777')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ nombre: 'iPro / Celnyx', reason: 'rebrand interno' });

      expect(r.status).toBe(200);
      expect(r.body.nombre).toBe('iPro / Celnyx');
      expect(r.body.slug).toBe('sa-test'); // slug intacto

      const { rows } = await pool.query(
        `SELECT action, before_state, after_state, reason
           FROM tenant_admin_actions WHERE tenant_id = 777`
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('rename');
      expect(rows[0].before_state.nombre).toBe('SA Test Tenant');
      expect(rows[0].after_state.nombre).toBe('iPro / Celnyx');
      expect(rows[0].reason).toBe('rebrand interno');
    });

    it('cambia slug solo (lowercase + hyphens válido)', async () => {
      const r = await request(app)
        .patch('/api/super-admin/tenants/777')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ slug: 'ipro-celnyx', reason: 'matchear nombre nuevo' });

      expect(r.status).toBe(200);
      expect(r.body.slug).toBe('ipro-celnyx');

      const { rows } = await pool.query(
        `SELECT action FROM tenant_admin_actions WHERE tenant_id = 777`
      );
      expect(rows[0].action).toBe('rename');

      // Cleanup: dejar slug 'sa-test' para no romper otros tests del archivo
      // que usan ese valor en el setup. (afterAll también limpia.)
      await pool.query(`UPDATE tenants SET slug='sa-test' WHERE id=777`);
    });

    it('cambia nombre + slug juntos en un solo PATCH', async () => {
      const r = await request(app)
        .patch('/api/super-admin/tenants/777')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ nombre: 'iPro / Celnyx', slug: 'ipro-celnyx', reason: 'full rebrand' });

      expect(r.status).toBe(200);
      expect(r.body.nombre).toBe('iPro / Celnyx');
      expect(r.body.slug).toBe('ipro-celnyx');

      await pool.query(`UPDATE tenants SET slug='sa-test' WHERE id=777`);
    });

    it('rechaza slug con formato inválido (uppercase)', async () => {
      const r = await request(app)
        .patch('/api/super-admin/tenants/777')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ slug: 'IproCelnyx', reason: 'x' });
      expect(r.status).toBe(400);
    });

    it('rechaza slug con caracteres especiales', async () => {
      const r = await request(app)
        .patch('/api/super-admin/tenants/777')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ slug: 'ipro/celnyx', reason: 'x' });
      expect(r.status).toBe(400);
    });

    it('rechaza slug que empieza/termina con hyphen', async () => {
      const r1 = await request(app)
        .patch('/api/super-admin/tenants/777')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ slug: '-ipro' });
      expect(r1.status).toBe(400);

      const r2 = await request(app)
        .patch('/api/super-admin/tenants/777')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ slug: 'ipro-' });
      expect(r2.status).toBe(400);
    });

    it('rechaza nombre vacío (después de trim)', async () => {
      const r = await request(app)
        .patch('/api/super-admin/tenants/777')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ nombre: '   ' });
      expect(r.status).toBe(400);
    });

    it('409 si slug colisiona con otro tenant existente', async () => {
      // tenant id=1 ya existe con slug 'iprotest' o el que sea — usamos uno
      // distinto al de 777 para que la colisión sea con otro tenant.
      // Levantamos el slug del tenant 1 dinámicamente para evitar fragilidad.
      const { rows: t1 } = await pool.query(`SELECT slug FROM tenants WHERE id=1`);
      const otherSlug = t1[0].slug;

      const r = await request(app)
        .patch('/api/super-admin/tenants/777')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ slug: otherSlug, reason: 'intencional para test' });

      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/slug ya en uso/);
      expect(r.body.detail).toContain(otherSlug);

      // Verificar que el tenant 777 no fue tocado.
      const { rows: t777 } = await pool.query(`SELECT slug FROM tenants WHERE id=777`);
      expect(t777[0].slug).toBe('sa-test');
    });

    it('cambiar slug al mismo valor actual → no-op (sin nueva fila de audit)', async () => {
      const r = await request(app)
        .patch('/api/super-admin/tenants/777')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ slug: 'sa-test', nombre: 'SA Test Tenant' });

      expect(r.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM tenant_admin_actions WHERE tenant_id=777`
      );
      expect(rows[0].c).toBe(0);
    });
  });
});

describe('POST /api/super-admin/tenants/:id/extend-trial', () => {
  beforeEach(async () => {
    await pool.query(
      `UPDATE tenants SET plan='trial', trial_until=CURRENT_DATE + 5 WHERE id=777`
    );
    await pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id = 777`);
  });

  it('extiende trial_until por N días', async () => {
    const r = await request(app)
      .post('/api/super-admin/tenants/777/extend-trial')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ days: 14, reason: 'cliente pidió + tiempo' });
    expect(r.status).toBe(200);
    // Era CURRENT_DATE + 5, ahora + 19.
    const { rows } = await pool.query(
      `SELECT trial_until FROM tenants WHERE id = 777`
    );
    const diff = Math.round(
      (new Date(rows[0].trial_until) - new Date()) / (1000 * 60 * 60 * 24)
    );
    expect(diff).toBeGreaterThanOrEqual(18); // tolerancia por hora del día
    expect(diff).toBeLessThanOrEqual(20);
  });

  it('rechaza si tenant no está en plan trial', async () => {
    await pool.query(`UPDATE tenants SET plan='pro', trial_until=NULL WHERE id=777`);
    const r = await request(app)
      .post('/api/super-admin/tenants/777/extend-trial')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ days: 7, reason: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/plan='pro'/);
  });

  it('reason requerido', async () => {
    const r = await request(app)
      .post('/api/super-admin/tenants/777/extend-trial')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ days: 7 });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/super-admin/tenants/:id/suspend + /reactivate', () => {
  beforeEach(async () => {
    await pool.query(
      `UPDATE tenants SET suspended_at=NULL, suspended_reason=NULL WHERE id=777`
    );
    await pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id = 777`);
  });

  it('suspend: setea suspended_at + reason', async () => {
    const r = await request(app)
      .post('/api/super-admin/tenants/777/suspend')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'no pagó' });
    expect(r.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT suspended_at, suspended_reason FROM tenants WHERE id = 777`
    );
    expect(rows[0].suspended_at).not.toBeNull();
    expect(rows[0].suspended_reason).toBe('no pagó');
  });

  it('reactivate: limpia suspended_at + reason', async () => {
    // Setup: suspendido.
    await pool.query(
      `UPDATE tenants SET suspended_at=NOW(), suspended_reason='old' WHERE id=777`
    );
    const r = await request(app)
      .post('/api/super-admin/tenants/777/reactivate')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'pagó al fin' });
    expect(r.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT suspended_at, suspended_reason FROM tenants WHERE id = 777`
    );
    expect(rows[0].suspended_at).toBeNull();
    expect(rows[0].suspended_reason).toBeNull();
  });

  it('suspend: reason requerido', async () => {
    const r = await request(app)
      .post('/api/super-admin/tenants/777/suspend')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({});
    expect(r.status).toBe(400);
  });
});

describe('DELETE /api/super-admin/tenants/:id (feature #438)', () => {
  beforeEach(async () => {
    // Reset tenant 777 a estado limpio (no eliminado) antes de cada test.
    // El slug debe ser estable porque los tests usan ?confirm=sa-test.
    await pool.query(
      `UPDATE tenants SET deleted_at = NULL, slug = 'sa-test' WHERE id = 777`
    );
    await pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id = 777`);
  });

  it('happy path: ?confirm=<slug> setea deleted_at y devuelve 200', async () => {
    const r = await request(app)
      .delete('/api/super-admin/tenants/777?confirm=sa-test')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'cleanup post-onboarding' });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.alreadyDeleted).toBeUndefined();

    const { rows } = await pool.query(
      `SELECT deleted_at FROM tenants WHERE id = 777`
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('400 si falta el query param ?confirm', async () => {
    const r = await request(app)
      .delete('/api/super-admin/tenants/777')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'sin confirm' });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/confirm requerido/);

    // No debe haber tocado deleted_at.
    const { rows } = await pool.query(
      `SELECT deleted_at FROM tenants WHERE id = 777`
    );
    expect(rows[0].deleted_at).toBeNull();
  });

  it('400 si el slug confirm no coincide con el real', async () => {
    const r = await request(app)
      .delete('/api/super-admin/tenants/777?confirm=slug-equivocado')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'oops typo' });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/confirm slug no coincide/);
    expect(r.body.detail).toContain('sa-test');

    const { rows } = await pool.query(
      `SELECT deleted_at FROM tenants WHERE id = 777`
    );
    expect(rows[0].deleted_at).toBeNull();
  });

  it('404 si el tenant no existe', async () => {
    const r = await request(app)
      .delete('/api/super-admin/tenants/999999?confirm=cualquiera')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'test' });

    expect(r.status).toBe(404);
  });

  it('idempotente: re-DELETE devuelve 200 con alreadyDeleted=true', async () => {
    // Setup: ya estaba soft-deleted.
    await pool.query(
      `UPDATE tenants SET deleted_at = NOW() WHERE id = 777`
    );

    const r = await request(app)
      .delete('/api/super-admin/tenants/777?confirm=sa-test')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'doble click' });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.alreadyDeleted).toBe(true);

    // No debió grabar nueva fila de audit (no es acción nueva).
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM tenant_admin_actions
        WHERE tenant_id = 777 AND action = 'delete'`
    );
    expect(rows[0].c).toBe(0);
  });

  it('audit trail: graba action=delete con before/after + reason', async () => {
    await request(app)
      .delete('/api/super-admin/tenants/777?confirm=sa-test')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'cuenta de prueba thinklab' });

    const { rows } = await pool.query(
      `SELECT action, before_state, after_state, reason, super_admin_user_id
         FROM tenant_admin_actions
        WHERE tenant_id = 777 ORDER BY created_at DESC LIMIT 1`
    );
    expect(rows[0].action).toBe('delete');
    expect(rows[0].before_state.deleted_at).toBeNull();
    expect(rows[0].before_state.slug).toBe('sa-test');
    expect(rows[0].after_state.deleted_at).toBe('NOW()');
    expect(rows[0].reason).toBe('cuenta de prueba thinklab');
    expect(rows[0].super_admin_user_id).toBe(1);
  });

  it('reason es opcional (delete sin reason no falla)', async () => {
    const r = await request(app)
      .delete('/api/super-admin/tenants/777?confirm=sa-test')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({});

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('rechaza body con campos extra (.strict)', async () => {
    const r = await request(app)
      .delete('/api/super-admin/tenants/777?confirm=sa-test')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'x', malicious_field: 'pwn' });

    expect(r.status).toBe(400);
  });

  it('400 si id inválido en la URL', async () => {
    const r = await request(app)
      .delete('/api/super-admin/tenants/abc?confirm=cualquiera')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ reason: 'test' });

    expect(r.status).toBe(400);
  });

  it('401 sin JWT', async () => {
    const r = await request(app)
      .delete('/api/super-admin/tenants/777?confirm=sa-test')
      .send({ reason: 'test' });

    expect(r.status).toBe(401);
  });

  it('403 cuando user no es super-admin', async () => {
    const r = await request(app)
      .delete('/api/super-admin/tenants/777?confirm=sa-test')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({ reason: 'test' });

    expect(r.status).toBe(403);

    // Crucial: el tenant NO fue tocado.
    const { rows } = await pool.query(
      `SELECT deleted_at FROM tenants WHERE id = 777`
    );
    expect(rows[0].deleted_at).toBeNull();
  });
});

describe('POST /api/super-admin/tenants/:id/set-paid-until (TANDA 4.B)', () => {
  beforeEach(async () => {
    await pool.query(`UPDATE tenants SET paid_until = NULL WHERE id = 777`);
    await pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id = 777`);
  });

  it('setea paid_until a una fecha futura', async () => {
    const fechaFutura = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const r = await request(app)
      .post('/api/super-admin/tenants/777/set-paid-until')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ paid_until: fechaFutura, reason: 'transferencia $189 USD recibida 2026-06-25' });

    expect(r.status).toBe(200);
    expect(r.body.paid_until).toContain(fechaFutura.slice(0, 10));

    const { rows } = await pool.query(`SELECT paid_until FROM tenants WHERE id = 777`);
    expect(rows[0].paid_until).not.toBeNull();
  });

  it('setea paid_until a NULL (grandfather)', async () => {
    // Primero ponemos una fecha, después la borramos.
    await pool.query(`UPDATE tenants SET paid_until = CURRENT_DATE + 30 WHERE id = 777`);

    const r = await request(app)
      .post('/api/super-admin/tenants/777/set-paid-until')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ paid_until: null });

    expect(r.status).toBe(200);
    expect(r.body.paid_until).toBeNull();

    const { rows } = await pool.query(`SELECT paid_until FROM tenants WHERE id = 777`);
    expect(rows[0].paid_until).toBeNull();
  });

  it('reason requerido cuando paid_until es una fecha', async () => {
    const fechaFutura = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const r = await request(app)
      .post('/api/super-admin/tenants/777/set-paid-until')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ paid_until: fechaFutura });
    expect(r.status).toBe(400);
  });

  it('reason opcional cuando paid_until es null (grandfathering)', async () => {
    const r = await request(app)
      .post('/api/super-admin/tenants/777/set-paid-until')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ paid_until: null });
    expect(r.status).toBe(200);
  });

  it('formato inválido de fecha → 400', async () => {
    const r = await request(app)
      .post('/api/super-admin/tenants/777/set-paid-until')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ paid_until: '25/06/2026', reason: 'x' });
    expect(r.status).toBe(400);
  });

  it('tenant inexistente → 404', async () => {
    const fechaFutura = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    const r = await request(app)
      .post('/api/super-admin/tenants/999999/set-paid-until')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ paid_until: fechaFutura, reason: 'test' });
    expect(r.status).toBe(404);
  });

  it('graba audit trail con action=paid_until_update + before/after', async () => {
    const fechaFutura = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    await request(app)
      .post('/api/super-admin/tenants/777/set-paid-until')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ paid_until: fechaFutura, reason: 'transferencia $39' });

    const { rows } = await pool.query(
      `SELECT action, before_state, after_state, reason FROM tenant_admin_actions
        WHERE tenant_id = 777 ORDER BY created_at DESC LIMIT 1`
    );
    expect(rows[0].action).toBe('paid_until_update');
    expect(rows[0].before_state.paid_until).toBeNull();
    expect(rows[0].after_state.paid_until).toContain(fechaFutura.slice(0, 10));
    expect(rows[0].reason).toBe('transferencia $39');
  });
});

describe('GET /api/super-admin/tenants/:id/activity', () => {
  it('?type=ventas devuelve items (vacío en este test)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/1/activity?type=ventas')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('ventas');
    expect(Array.isArray(r.body.items)).toBe(true);
  });

  it('?type=bot devuelve summary + recent_conversations', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/1/activity?type=bot')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('bot');
    expect(typeof r.body.summary.mensajes_total).toBe('number');
    expect(Array.isArray(r.body.recent_conversations)).toBe(true);
  });

  it('?type=alertas devuelve config de alertas del tenant', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/1/activity?type=alertas')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('alertas');
    // El seed crea 5 tipos default por tenant (vía migration alertas_config_per_tenant).
    expect(r.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('?type=unknown devuelve error informativo (no 500)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/1/activity?type=xxx')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.error).toMatch(/type 'xxx' desconocido/);
  });

  it('404 si tenant no existe', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants/99999/activity?type=ventas')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(404);
  });
});

describe('GET /api/super-admin/metrics', () => {
  it('devuelve KPIs agregados', async () => {
    const r = await request(app)
      .get('/api/super-admin/metrics')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    // Estructura esperada
    expect(typeof r.body.mrr_total_usd).toBe('number');
    expect(typeof r.body.tenants_active).toBe('number');
    expect(typeof r.body.tenants_trial).toBe('number');
    expect(typeof r.body.tenants_suspended).toBe('number');
    expect(typeof r.body.signups_7d).toBe('number');
    expect(typeof r.body.signups_30d).toBe('number');
    expect(typeof r.body.churn_30d).toBe('number');
    expect(typeof r.body.conversion_trial_paid_30d).toBe('number');
    expect(r.body.plan_prices_usd).toEqual(
      expect.objectContaining({ trial: 0 })
    );
  });

  it('incluye tenants_by_plan con los 4 planes canónicos', async () => {
    const r = await request(app)
      .get('/api/super-admin/metrics')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.tenants_by_plan)).toBe(true);
    // Garantiza un row por plan canónico aunque sea count=0 (así el
    // frontend siempre renderiza la distribución completa).
    const planNames = r.body.tenants_by_plan.map((p) => p.plan).sort();
    expect(planNames).toEqual(['enterprise', 'pro', 'starter', 'trial']);
    // Shape de cada row.
    for (const row of r.body.tenants_by_plan) {
      expect(row).toEqual(expect.objectContaining({
        plan: expect.any(String),
        count: expect.any(Number),
        mrr_usd: expect.any(Number),
      }));
      expect(row.count).toBeGreaterThanOrEqual(0);
    }
  });

  it('regular user recibe 403', async () => {
    const r = await request(app)
      .get('/api/super-admin/metrics')
      .set('Authorization', `Bearer ${regularUserToken}`);
    expect(r.status).toBe(403);
  });
});

describe('GET /api/super-admin/metrics/history', () => {
  it('devuelve serie temporal de 90 días', async () => {
    const r = await request(app)
      .get('/api/super-admin/metrics/history')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.history)).toBe(true);
    expect(r.body.history).toHaveLength(90);
    // Cada item tiene date, signups, suspensions, mrr_usd (#451).
    expect(r.body.history[0]).toEqual(
      expect.objectContaining({
        date: expect.any(String),
        signups: expect.any(Number),
        suspensions: expect.any(Number),
        mrr_usd: expect.any(Number),
      })
    );
  });

  it('mrr_usd diario >= 0 en todos los días (#451)', async () => {
    const r = await request(app)
      .get('/api/super-admin/metrics/history')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    for (const day of r.body.history) {
      expect(typeof day.mrr_usd).toBe('number');
      expect(day.mrr_usd).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(day.mrr_usd)).toBe(true);
    }
  });

  it('mrr_usd del último día coincide con /metrics actual (#451)', async () => {
    // El MRR del día de hoy en el array debe igualar el mrr_total_usd
    // que devuelve /metrics — son la misma fórmula sobre el mismo universo
    // de tenants activos. Si divergen, hay drift de lógica (regresión).
    const [hist, met] = await Promise.all([
      request(app)
        .get('/api/super-admin/metrics/history')
        .set('Authorization', `Bearer ${superAdminToken}`),
      request(app)
        .get('/api/super-admin/metrics')
        .set('Authorization', `Bearer ${superAdminToken}`),
    ]);
    expect(hist.status).toBe(200);
    expect(met.status).toBe(200);
    const today = hist.body.history[hist.body.history.length - 1];
    expect(today.mrr_usd).toBe(met.body.mrr_total_usd);
  });
});

describe('GET /api/super-admin/metrics/recent-actions', () => {
  // Sembramos un par de acciones en el tenant 777 para que el feed tenga
  // contenido predecible. Cleanup viene del afterAll global (borra todo
  // tenant_admin_actions de tenant 777).
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO tenant_admin_actions
         (tenant_id, super_admin_user_id, action, reason, created_at)
       VALUES
         (777, 1, 'suspend',  'test seed B.1 — más viejo', NOW() - INTERVAL '5 minutes'),
         (777, 1, 'reactivate','test seed B.1 — más reciente', NOW())`
    );
  });

  it('devuelve recent_actions con join a tenant + super_admin', async () => {
    const r = await request(app)
      .get('/api/super-admin/metrics/recent-actions')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.recent_actions)).toBe(true);
    expect(r.body.recent_actions.length).toBeGreaterThanOrEqual(2);
    // Orden DESC por created_at: el primer item debe ser 'reactivate'
    // (lo seedeamos como el más reciente).
    const first = r.body.recent_actions[0];
    expect(first).toEqual(expect.objectContaining({
      // taa.id es BIGSERIAL → pg lo devuelve como String (no Number). El
      // frontend lo trata como opaque ID igual; no hace aritmética con él.
      id: expect.any(String),
      tenant_id: expect.any(Number),
      tenant_nombre: expect.any(String),
      tenant_slug: expect.any(String),
      action: expect.any(String),
      created_at: expect.any(String),
      super_admin_username: expect.any(String),
    }));
  });

  it('respeta el param limit (cap 50, default 10, min 1)', async () => {
    const r = await request(app)
      .get('/api/super-admin/metrics/recent-actions?limit=1')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.recent_actions).toHaveLength(1);

    // Limit fuera de rango → backend lo clamp-a, no rebota con 400.
    const r2 = await request(app)
      .get('/api/super-admin/metrics/recent-actions?limit=9999')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r2.status).toBe(200);
    expect(r2.body.recent_actions.length).toBeLessThanOrEqual(50);
  });

  it('regular user recibe 403', async () => {
    const r = await request(app)
      .get('/api/super-admin/metrics/recent-actions')
      .set('Authorization', `Bearer ${regularUserToken}`);
    expect(r.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// C.1.2 #353: plan-prices endpoints
//
// Cubre GET (lista los 4 planes con join a updated_by_username) y PATCH
// (UPDATE atómico + audit trail + cache refresh). Tests defensivos:
//   · trial NO se puede editar (400)
//   · enterprise rechaza price_usd != null (400)
//   · plan inexistente → 404
//   · PATCH no-op (mismo valor) → 200 con noop:true, sin tocar audit
//   · regular user → 403
// ──────────────────────────────────────────────────────────────────────────
describe('GET /api/super-admin/plan-prices', () => {
  it('devuelve los 4 planes ordenados (trial, starter, pro, enterprise)', async () => {
    const r = await request(app)
      .get('/api/super-admin/plan-prices')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.plan_prices)).toBe(true);
    expect(r.body.plan_prices.map((p) => p.plan)).toEqual(['trial', 'starter', 'pro', 'enterprise']);
    // El enterprise debe venir con price_usd null (seed de la migration).
    const ent = r.body.plan_prices.find((p) => p.plan === 'enterprise');
    expect(ent.price_usd).toBeNull();
  });

  it('regular user recibe 403', async () => {
    const r = await request(app)
      .get('/api/super-admin/plan-prices')
      .set('Authorization', `Bearer ${regularUserToken}`);
    expect(r.status).toBe(403);
  });

  it('sin JWT recibe 401', async () => {
    const r = await request(app).get('/api/super-admin/plan-prices');
    expect(r.status).toBe(401);
  });
});

describe('PATCH /api/super-admin/plan-prices/:plan', () => {
  // Cleanup post-test: reset starter+pro a los valores del seed (39/189) y
  // borra audit rows que generamos. Sin esto, los tests siguientes ven
  // valores arbitrarios y eso quiebra otras suites.
  afterEach(async () => {
    await pool.query(
      `UPDATE plan_prices SET price_usd = 39, notes = NULL, updated_by = NULL WHERE plan = 'starter'`
    );
    await pool.query(
      `UPDATE plan_prices SET price_usd = 189, notes = NULL, updated_by = NULL WHERE plan = 'pro'`
    );
    await pool.query(
      `DELETE FROM tenant_admin_actions WHERE action = 'plan_price_change'`
    );
  });

  it('actualiza precio de starter + audita + responde con valor nuevo', async () => {
    const r = await request(app)
      .patch('/api/super-admin/plan-prices/starter')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ price_usd: 49, notes: 'subido por test', reason: 'sanity test' });
    expect(r.status).toBe(200);
    expect(r.body.plan).toBe('starter');
    expect(Number(r.body.price_usd)).toBe(49);
    expect(r.body.notes).toBe('subido por test');
    expect(r.body.noop).toBe(false);

    // DB row efectivamente actualizada.
    const { rows } = await pool.query(
      `SELECT price_usd, notes, updated_by FROM plan_prices WHERE plan = 'starter'`
    );
    expect(Number(rows[0].price_usd)).toBe(49);
    expect(rows[0].notes).toBe('subido por test');
    expect(rows[0].updated_by).toBe(1);

    // Audit row creada.
    const { rows: audit } = await pool.query(
      `SELECT action, before_state, after_state, reason
         FROM tenant_admin_actions
        WHERE action = 'plan_price_change'
        ORDER BY id DESC LIMIT 1`
    );
    expect(audit[0].action).toBe('plan_price_change');
    // El endpoint hace Number(before.price_usd) antes de meterlo a jsonb —
    // así que llega como número, no como string '39.00' del driver pg.
    expect(audit[0].before_state).toMatchObject({ plan: 'starter', price_usd: 39 });
    expect(audit[0].after_state).toMatchObject({ plan: 'starter', price_usd: 49 });
    expect(audit[0].reason).toBe('sanity test');
  });

  it('rechaza editar trial (400)', async () => {
    const r = await request(app)
      .patch('/api/super-admin/plan-prices/trial')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ price_usd: 10 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/trial/i);
  });

  it('rechaza enterprise con price_usd no-null (400)', async () => {
    const r = await request(app)
      .patch('/api/super-admin/plan-prices/enterprise')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ price_usd: 500 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/enterprise/i);
  });

  it('plan inexistente → 404', async () => {
    const r = await request(app)
      .patch('/api/super-admin/plan-prices/no_existe')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ price_usd: 10 });
    expect(r.status).toBe(404);
  });

  it('PATCH no-op (mismo valor) → 200 noop:true sin audit', async () => {
    const r = await request(app)
      .patch('/api/super-admin/plan-prices/starter')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ price_usd: 39 }); // mismo valor que el seed
    expect(r.status).toBe(200);
    expect(r.body.noop).toBe(true);

    // No se creó audit row.
    const { rows: audit } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM tenant_admin_actions WHERE action = 'plan_price_change'`
    );
    expect(audit[0].cnt).toBe(0);
  });

  it('rechaza price_usd negativo (400 via zod)', async () => {
    const r = await request(app)
      .patch('/api/super-admin/plan-prices/pro')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ price_usd: -1 });
    expect(r.status).toBe(400);
  });

  it('rechaza body con campos extra (.strict)', async () => {
    const r = await request(app)
      .patch('/api/super-admin/plan-prices/pro')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ price_usd: 199, malicious_field: 'pwn' });
    expect(r.status).toBe(400);
  });

  it('regular user recibe 403', async () => {
    const r = await request(app)
      .patch('/api/super-admin/plan-prices/starter')
      .set('Authorization', `Bearer ${regularUserToken}`)
      .send({ price_usd: 49 });
    expect(r.status).toBe(403);
  });
});
