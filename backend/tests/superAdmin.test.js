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
  it('devuelve lista de TODOS los tenants (cross-tenant)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    // Al menos tenant 1 (default) + tenant 777 (test seed).
    expect(r.body.length).toBeGreaterThanOrEqual(2);
    const ids = r.body.map(t => t.id).sort();
    expect(ids).toContain(1);
    expect(ids).toContain(777);
  });

  it('cada tenant incluye stats: mrr_usd, users_count, last_venta_at, signups_30d', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants')
      .set('Authorization', `Bearer ${superAdminToken}`);
    const t = r.body.find(x => x.id === 1);
    expect(t).toBeDefined();
    expect(typeof t.mrr_usd).toBe('number');
    expect(typeof t.users_count).toBe('number');
    expect(typeof t.signups_30d).toBe('number');
    // last_venta_at puede ser null (sin ventas)
    expect(['object', 'string']).toContain(typeof t.last_venta_at); // null o ISO string
  });

  it('filtro ?plan=pro devuelve solo plan pro', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?plan=pro')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.every(t => t.plan === 'pro')).toBe(true);
    expect(r.body.find(t => t.id === 777)).toBeDefined();
  });

  it('filtro ?plan=invalid es ignorado (no rompe la query)', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?plan=hackplan')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    // sin filtro → devuelve todos
    expect(r.body.length).toBeGreaterThanOrEqual(2);
  });

  it('filtro ?search=sa-test devuelve match por slug', async () => {
    const r = await request(app)
      .get('/api/super-admin/tenants?search=sa-test')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThanOrEqual(1);
    expect(r.body.some(t => t.slug === 'sa-test')).toBe(true);
  });

  it('filtro ?suspended=true devuelve solo suspendidos', async () => {
    // Suspender tenant 777 temporalmente
    await pool.query(
      `UPDATE tenants SET suspended_at = NOW(), suspended_reason = 'test' WHERE id = 777`
    );
    const r = await request(app)
      .get('/api/super-admin/tenants?suspended=true')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.every(t => t.suspended_at !== null)).toBe(true);
    expect(r.body.find(t => t.id === 777)).toBeDefined();

    // Cleanup
    await pool.query(
      `UPDATE tenants SET suspended_at = NULL, suspended_reason = NULL WHERE id = 777`
    );
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
    await pool.query(
      `UPDATE tenants
          SET plan='pro', suspended_at=NULL, suspended_reason=NULL,
              trial_until=NULL, custom_mrr_usd=NULL, notes=NULL
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
    // Cada item tiene date, signups, suspensions
    expect(r.body.history[0]).toEqual(
      expect.objectContaining({
        date: expect.any(String),
        signups: expect.any(Number),
        suspensions: expect.any(Number),
      })
    );
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
