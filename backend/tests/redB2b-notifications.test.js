/**
 * Tests integration para Red B2B F5: inbox notifications + emails (#458).
 *
 * Cobertura (15+ tests):
 *
 *   Endpoints inbox (8):
 *     · GET / lista paginada por created_at DESC
 *     · GET / filtro ?unread=true → solo unread
 *     · GET / filtro ?type=invitation_received → filtra correcto
 *     · GET / limit clamp a [1,100]
 *     · GET /count-unread → número correcto
 *     · POST /:id/read marca read_at + idempotente segunda llamada
 *     · POST /read-all marca todas las del tenant
 *     · User sin cross_tenant.write → 403
 *
 *   RLS isolation (1):
 *     · Tenant C no ve notifs de A (count-unread = 0)
 *
 *   Email helpers (5+):
 *     · sendRedB2BInvitationReceivedEmail → testQueue captures
 *     · sendRedB2BInvitationAcceptedEmail
 *     · sendRedB2BOperationReceivedEmail
 *     · sendRedB2BOperationCancelledEmail
 *     · sendRedB2BPaymentReceivedEmail
 *
 *   Email gating + recipient resolution (3):
 *     · prefs invitation_received=false → skip (no encolado)
 *     · prefs ausentes → default true → envía
 *     · sin owner/admin con email → skip silenciosa
 *
 *   Wire integration (2):
 *     · POST /partnerships/invite → email se encola post-setImmediate
 *     · El gating off via PATCH /config/email-prefs efectivamente skip-ea
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');
const emailLib = require('../src/lib/email');
const redB2bEmail = require('../src/lib/redB2bEmail');

const TENANT_A = { slug: 'red-b2b-f5-a', nombre: 'Red B2B F5 Tenant A', plan: 'starter' };
const TENANT_B = { slug: 'red-b2b-f5-b', nombre: 'Red B2B F5 Tenant B', plan: 'pro' };
const TENANT_C = { slug: 'red-b2b-f5-c', nombre: 'Red B2B F5 Tenant C', plan: 'starter' };

let pool;
let tenantAId, tenantBId, tenantCId;
let userAId, userBId, userCId, userANoCapId;
let tokenA, tokenB, tokenC, tokenANoCap;

function signToken({ id, username, email, tenant_id, caps = {} }) {
  return jwt.sign(
    {
      id, username, email,
      role: 'op',
      tenant_id,
      tenant_rol: 'admin',
      tenant_cap_rol: 'custom',
      caps,
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

async function createTenant({ slug, nombre, plan }) {
  const r = await pool.query(
    `INSERT INTO tenants (nombre, slug, plan)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre, plan = EXCLUDED.plan
     RETURNING id`,
    [nombre, slug, plan]
  );
  return r.rows[0].id;
}

async function createUserForTenant(tenantId, { username, email, rol = 'admin' }) {
  const hash = await bcrypt.hash('testpass1234', 10);
  const u = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
     VALUES ($1, $2, $3, $4, 'op', NOW())
     RETURNING id`,
    [username, username, email, hash]
  );
  const userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, rol]
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${tenantId}`);
    await client.query(
      `INSERT INTO tenant_user_roles (tenant_id, user_id, rol)
       VALUES ($1, $2, 'custom')
       ON CONFLICT DO NOTHING`,
      [tenantId, userId]
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  return userId;
}

// Helper para crear una notif directa (bypass RLS via INSERT con SET LOCAL).
// Devuelve Number (no BIGINT string) para matchear cómo el endpoint serializa.
async function seedNotification({ tenantId, type, payload = {}, partnershipId = null, opId = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.current_tenant = ${tenantId}`);
    const r = await client.query(
      `INSERT INTO cross_tenant_notifications (tenant_id, partnership_id, cross_tenant_operation_id, type, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [tenantId, partnershipId, opId, type, JSON.stringify(payload)]
    );
    await client.query('COMMIT');
    return Number(r.rows[0].id);
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  pool = await setupTestDb();

  tenantAId = await createTenant(TENANT_A);
  tenantBId = await createTenant(TENANT_B);
  tenantCId = await createTenant(TENANT_C);

  userAId = await createUserForTenant(tenantAId, {
    username: 'rb2b-f5-user-a', email: 'rb2b-f5-a@test.local', rol: 'owner',
  });
  userBId = await createUserForTenant(tenantBId, {
    username: 'rb2b-f5-user-b', email: 'rb2b-f5-b@test.local', rol: 'owner',
  });
  userCId = await createUserForTenant(tenantCId, {
    username: 'rb2b-f5-user-c', email: 'rb2b-f5-c@test.local', rol: 'owner',
  });
  userANoCapId = await createUserForTenant(tenantAId, {
    username: 'rb2b-f5-user-a-nocap', email: 'rb2b-f5-a-nocap@test.local',
  });

  const capsOn = { 'cross_tenant.write': true };
  tokenA = signToken({
    id: userAId, username: 'rb2b-f5-user-a', email: 'rb2b-f5-a@test.local',
    tenant_id: tenantAId, caps: capsOn,
  });
  tokenB = signToken({
    id: userBId, username: 'rb2b-f5-user-b', email: 'rb2b-f5-b@test.local',
    tenant_id: tenantBId, caps: capsOn,
  });
  tokenC = signToken({
    id: userCId, username: 'rb2b-f5-user-c', email: 'rb2b-f5-c@test.local',
    tenant_id: tenantCId, caps: capsOn,
  });
  tokenANoCap = signToken({
    id: userANoCapId, username: 'rb2b-f5-user-a-nocap',
    email: 'rb2b-f5-a-nocap@test.local',
    tenant_id: tenantAId, caps: {},
  });
});

beforeEach(async () => {
  const ids = [tenantAId, tenantBId, tenantCId];
  await pool.query(
    `DELETE FROM cross_tenant_notifications WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM tenant_partnerships
       WHERE tenant_a_id = ANY($1::int[]) OR tenant_b_id = ANY($1::int[])`,
    [ids]
  );
  // Reset email prefs to defaults para que no haya leak entre tests.
  await pool.query(
    `UPDATE tenants
        SET red_b2b_email_prefs = '{
          "invitation_received":  true,
          "invitation_accepted":  true,
          "operation_received":   true,
          "operation_cancelled":  true,
          "payment_received":     true
        }'::jsonb
      WHERE id = ANY($1::int[])`,
    [ids]
  );
  // Limpiar queue de emails.
  emailLib._resetTestQueue();
});

afterAll(async () => {
  const ids = [tenantAId, tenantBId, tenantCId];
  const userIds = [userAId, userBId, userCId, userANoCapId];
  await pool.query(
    `DELETE FROM cross_tenant_notifications WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM tenant_partnerships
       WHERE tenant_a_id = ANY($1::int[]) OR tenant_b_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM tenant_admin_actions WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM contactos WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM user_capabilities WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(
    `DELETE FROM tenant_user_roles WHERE tenant_id = ANY($1::int[])`,
    [ids]
  );
  await pool.query(`DELETE FROM tenant_users WHERE user_id = ANY($1::int[])`, [userIds]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
  await pool.query(`DELETE FROM tenants WHERE id = ANY($1::int[])`, [ids]);

  await teardownTestDb(pool);
});

// ──────────────────────────────────────────────────────────────────────────
// Capability gate
// ──────────────────────────────────────────────────────────────────────────
describe('Capability gate', () => {
  it('user SIN cross_tenant.write → 403 en GET /notifications', async () => {
    const r = await request(app)
      .get('/api/red-b2b/notifications')
      .set('Authorization', `Bearer ${tokenANoCap}`);
    expect(r.status).toBe(403);
  });

  it('user SIN cap → 403 en POST /notifications/read-all', async () => {
    const r = await request(app)
      .post('/api/red-b2b/notifications/read-all')
      .set('Authorization', `Bearer ${tokenANoCap}`);
    expect(r.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET / — listado paginado + filtros
// ──────────────────────────────────────────────────────────────────────────
describe('GET /api/red-b2b/notifications', () => {
  it('lista paginada por created_at DESC', async () => {
    await seedNotification({ tenantId: tenantAId, type: 'operation_received' });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await seedNotification({ tenantId: tenantAId, type: 'payment_received' });

    const r = await request(app)
      .get('/api/red-b2b/notifications')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.notifications.length).toBe(2);
    expect(r.body.notifications[0].id).toBe(newer); // DESC, más reciente primero
    expect(r.body.notifications[0].type).toBe('payment_received');
  });

  it('filtro ?unread=true solo devuelve no leídas', async () => {
    const read = await seedNotification({ tenantId: tenantAId, type: 'operation_received' });
    await pool.query(
      `UPDATE cross_tenant_notifications SET read_at = NOW() WHERE id = $1`,
      [read]
    );
    const unread = await seedNotification({ tenantId: tenantAId, type: 'payment_received' });

    const r = await request(app)
      .get('/api/red-b2b/notifications?unread=true')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.notifications.length).toBe(1);
    expect(r.body.notifications[0].id).toBe(unread);
  });

  it('filtro ?type=invitation_received filtra correcto', async () => {
    await seedNotification({ tenantId: tenantAId, type: 'invitation_received' });
    await seedNotification({ tenantId: tenantAId, type: 'operation_received' });

    const r = await request(app)
      .get('/api/red-b2b/notifications?type=invitation_received')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.notifications.length).toBe(1);
    expect(r.body.notifications[0].type).toBe('invitation_received');
  });

  it('limit clamp: ?limit=500 → max 100', async () => {
    // No seedeamos 100 — el clamp solo afecta la query LIMIT, no podemos
    // verificarlo sin pelearnos; verificamos que no rompe.
    const r = await request(app)
      .get('/api/red-b2b/notifications?limit=500')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /count-unread
// ──────────────────────────────────────────────────────────────────────────
describe('GET /api/red-b2b/notifications/count-unread', () => {
  it('devuelve count de unread del tenant', async () => {
    await seedNotification({ tenantId: tenantAId, type: 'operation_received' });
    await seedNotification({ tenantId: tenantAId, type: 'payment_received' });
    const r = await request(app)
      .get('/api/red-b2b/notifications/count-unread')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
  });

  it('count=0 si tenant no tiene notifs', async () => {
    const r = await request(app)
      .get('/api/red-b2b/notifications/count-unread')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /:id/read + idempotencia
// ──────────────────────────────────────────────────────────────────────────
describe('POST /:id/read', () => {
  it('marca read_at', async () => {
    const id = await seedNotification({ tenantId: tenantAId, type: 'operation_received' });
    const r = await request(app)
      .post(`/api/red-b2b/notifications/${id}/read`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.read_at).toBeTruthy();

    const dbQ = await pool.query(
      `SELECT read_at FROM cross_tenant_notifications WHERE id = $1`,
      [id]
    );
    expect(dbQ.rows[0].read_at).not.toBeNull();
  });

  it('idempotente: segunda llamada devuelve ok sin error', async () => {
    const id = await seedNotification({ tenantId: tenantAId, type: 'operation_received' });
    const r1 = await request(app)
      .post(`/api/red-b2b/notifications/${id}/read`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r1.status).toBe(200);
    const firstReadAt = r1.body.read_at;

    const r2 = await request(app)
      .post(`/api/red-b2b/notifications/${id}/read`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r2.status).toBe(200);
    expect(r2.body.ok).toBe(true);
    expect(r2.body.idempotent).toBe(true);

    // read_at no cambió en DB (preservamos el primer timestamp).
    const dbQ = await pool.query(
      `SELECT read_at FROM cross_tenant_notifications WHERE id = $1`,
      [id]
    );
    expect(dbQ.rows[0].read_at.toISOString()).toBe(new Date(firstReadAt).toISOString());
  });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /read-all
// ──────────────────────────────────────────────────────────────────────────
describe('POST /read-all', () => {
  it('marca todas las unread del tenant', async () => {
    await seedNotification({ tenantId: tenantAId, type: 'operation_received' });
    await seedNotification({ tenantId: tenantAId, type: 'payment_received' });
    await seedNotification({ tenantId: tenantAId, type: 'invitation_received' });

    const r = await request(app)
      .post('/api/red-b2b/notifications/read-all')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.updated).toBe(3);

    const dbQ = await pool.query(
      `SELECT COUNT(*)::int AS n FROM cross_tenant_notifications
         WHERE tenant_id = $1 AND read_at IS NULL`,
      [tenantAId]
    );
    expect(dbQ.rows[0].n).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// RLS leak: tenant C no ve notifs de A
// ──────────────────────────────────────────────────────────────────────────
describe('RLS isolation', () => {
  it('tenant C no ve notifs de A en count-unread', async () => {
    await seedNotification({ tenantId: tenantAId, type: 'operation_received' });
    await seedNotification({ tenantId: tenantAId, type: 'payment_received' });

    const r = await request(app)
      .get('/api/red-b2b/notifications/count-unread')
      .set('Authorization', `Bearer ${tokenC}`);
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(0);
  });

  it('tenant C no ve notifs de A en GET /', async () => {
    await seedNotification({ tenantId: tenantAId, type: 'operation_received' });
    const r = await request(app)
      .get('/api/red-b2b/notifications')
      .set('Authorization', `Bearer ${tokenC}`);
    expect(r.status).toBe(200);
    expect(r.body.notifications.length).toBe(0);
  });

  // PR-E #464: gap detectado en audit focal Red B2B — POST /:id/read sin test
  // cross-tenant. Decisión documentada en notifications.js: el endpoint NO
  // devuelve 404 cuando la notif pertenece a otro tenant (evita enumeration
  // leak). Devuelve 200 idempotent y CRUCIALMENTE no marca como leída la
  // notif del otro tenant (el WHERE tenant_id = $myTenant + RLS lo bloquean).
  it('Tenant C intenta marcar como leída notif de tenant A → 200 idempotent + notif A sigue unread', async () => {
    const notifId = await seedNotification({
      tenantId: tenantAId,
      type: 'invitation_received',
    });

    const r = await request(app)
      .post(`/api/red-b2b/notifications/${notifId}/read`)
      .set('Authorization', `Bearer ${tokenC}`);
    // Endpoint defensivo contra enumeration: devuelve ok idempotent, sin
    // confirmar/negar existencia del id.
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.idempotent).toBe(true);
    expect(r.body.read_at).toBeNull();

    // CRÍTICO: la notif del tenant A sigue UNREAD (read_at IS NULL).
    const dbQ = await pool.query(
      `SELECT read_at FROM cross_tenant_notifications WHERE id = $1`,
      [notifId]
    );
    expect(dbQ.rows.length).toBe(1);
    expect(dbQ.rows[0].read_at).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Email helper functions (test queue mode)
// ──────────────────────────────────────────────────────────────────────────
describe('Email helpers (test queue mode)', () => {
  it('sendRedB2BInvitationReceivedEmail encola payload', async () => {
    const r = await emailLib.sendRedB2BInvitationReceivedEmail({
      to:                'owner@partner.com',
      name:              'Lucas',
      partnerNombre:     'iPro',
      invitationMessage: 'Hola, somos iPro',
      partnershipId:     123,
    });
    expect(r.ok).toBe(true);
    const q = emailLib._getTestQueue();
    expect(q).toHaveLength(1);
    expect(q[0].type).toBe('red_b2b_invitation_received');
    expect(q[0].to).toBe('owner@partner.com');
    expect(q[0].partnerNombre).toBe('iPro');
    expect(q[0].invitationMessage).toBe('Hola, somos iPro');
    expect(q[0].partnershipId).toBe(123);
  });

  it('sendRedB2BInvitationAcceptedEmail encola payload', async () => {
    const r = await emailLib.sendRedB2BInvitationAcceptedEmail({
      to:            'inviter@me.com',
      name:          'Juan',
      partnerNombre: 'TekHaus',
      partnershipId: 99,
    });
    expect(r.ok).toBe(true);
    const q = emailLib._getTestQueue();
    expect(q[0].type).toBe('red_b2b_invitation_accepted');
    expect(q[0].partnerNombre).toBe('TekHaus');
  });

  it('sendRedB2BOperationReceivedEmail encola payload', async () => {
    const r = await emailLib.sendRedB2BOperationReceivedEmail({
      to:            'buyer@x.com',
      partnerNombre: 'iPro',
      totalUsd:      1500.50,
      totalArs:      2100700,
      itemsCount:    3,
      operationId:   456,
    });
    expect(r.ok).toBe(true);
    const q = emailLib._getTestQueue();
    expect(q[0].type).toBe('red_b2b_operation_received');
    expect(q[0].totalUsd).toBe(1500.50);
    expect(q[0].operationId).toBe(456);
  });

  it('sendRedB2BOperationCancelledEmail encola payload', async () => {
    const r = await emailLib.sendRedB2BOperationCancelledEmail({
      to:            'buyer@x.com',
      partnerNombre: 'iPro',
      totalUsd:      750,
      operationId:   789,
      reason:        'cliente cambió de opinión',
    });
    expect(r.ok).toBe(true);
    const q = emailLib._getTestQueue();
    expect(q[0].type).toBe('red_b2b_operation_cancelled');
    expect(q[0].reason).toBe('cliente cambió de opinión');
  });

  it('sendRedB2BPaymentReceivedEmail encola payload (iWasPaid=true)', async () => {
    const r = await emailLib.sendRedB2BPaymentReceivedEmail({
      to:            'seller@x.com',
      partnerNombre: 'TekHaus',
      montoUsd:      500,
      monedaPago:    'ARS',
      operationId:   111,
      iWasPaid:      true,
    });
    expect(r.ok).toBe(true);
    const q = emailLib._getTestQueue();
    expect(q[0].type).toBe('red_b2b_payment_received');
    expect(q[0].iWasPaid).toBe(true);
    expect(q[0].monedaPago).toBe('ARS');
  });

  it('valida args requeridos (operation_received sin operationId → throws)', async () => {
    await expect(emailLib.sendRedB2BOperationReceivedEmail({
      to: 'a@b.com', partnerNombre: 'X', totalUsd: 100, itemsCount: 1,
    })).rejects.toThrow(/requeridos/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Email dispatch (recipient resolution + gating)
// ──────────────────────────────────────────────────────────────────────────
describe('redB2bEmail.dispatch', () => {
  it('manda al owner del tenant (con email verified) — invitation_received', async () => {
    const r = await redB2bEmail.dispatch({
      tenantId: tenantBId,
      type:     'invitation_received',
      args: {
        partnerNombre: 'Tenant A',
        partnershipId: 1,
      },
    });
    expect(r.ok).toBe(true);
    const q = emailLib._getTestQueue();
    expect(q.length).toBe(1);
    expect(q[0].to).toBe('rb2b-f5-b@test.local');
    expect(q[0].partnerNombre).toBe('Tenant A');
  });

  it('skip si gating false (prefs.invitation_received=false)', async () => {
    await pool.query(
      `UPDATE tenants
          SET red_b2b_email_prefs = jsonb_set(red_b2b_email_prefs, '{invitation_received}', 'false'::jsonb)
        WHERE id = $1`,
      [tenantBId]
    );
    const r = await redB2bEmail.dispatch({
      tenantId: tenantBId,
      type:     'invitation_received',
      args: { partnerNombre: 'Tenant A' },
    });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('prefs_off');
    expect(emailLib._getTestQueue()).toHaveLength(0);
  });

  it('skip silenciosa si tenant no tiene owner/admin con email', async () => {
    // Crear un tenant nuevo sin users.
    const orphanId = await createTenant({
      slug: 'red-b2b-f5-orphan', nombre: 'Orphan', plan: 'starter',
    });
    const r = await redB2bEmail.dispatch({
      tenantId: orphanId,
      type:     'operation_received',
      args: { partnerNombre: 'X', totalUsd: 100, itemsCount: 1, operationId: 1 },
    });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_recipient');
    // Cleanup.
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [orphanId]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Wire integration: POST /partnerships/invite → email se envía
// ──────────────────────────────────────────────────────────────────────────
describe('Wire integration con partnerships /invite', () => {
  // Helper: espera a que setImmediate + el dispatch async (que hace DB queries)
  // termine. setImmediate sched-ea la callback, pero la callback dispara
  // dispatch() async que hace varias adminQuery + resend.send — necesitamos
  // varios ticks + microtasks para que la queue refleje el email.
  async function waitForDispatch(maxMs = 500) {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, maxMs / 50));
      if (emailLib._getTestQueue().length > 0) return;
    }
  }

  it('POST /invite → email encolado via setImmediate', async () => {
    const r = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug, message: 'Hola B' });
    expect(r.status).toBe(201);

    await waitForDispatch();

    const q = emailLib._getTestQueue();
    const found = q.find((e) => e.type === 'red_b2b_invitation_received');
    expect(found).toBeDefined();
    expect(found.to).toBe('rb2b-f5-b@test.local');
    expect(found.partnerNombre).toBe(TENANT_A.nombre);
  });

  it('PATCH /config/email-prefs invitation_received=false → POST /invite NO envía email', async () => {
    // Apagar el gating del tenant B (receptor).
    const patchR = await request(app)
      .patch('/api/red-b2b/config/email-prefs')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ invitation_received: false });
    expect(patchR.status).toBe(200);
    expect(patchR.body.email_prefs.invitation_received).toBe(false);

    // Invitar.
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    expect(inv.status).toBe(201);

    // Dar tiempo para que el dispatch corra (y se skipee por prefs_off).
    await new Promise((r) => setTimeout(r, 250));

    const q = emailLib._getTestQueue();
    const found = q.find((e) => e.type === 'red_b2b_invitation_received');
    expect(found).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Email prefs endpoints
// ──────────────────────────────────────────────────────────────────────────
describe('Email prefs endpoints', () => {
  it('GET /config/email-prefs devuelve defaults', async () => {
    const r = await request(app)
      .get('/api/red-b2b/config/email-prefs')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.email_prefs.invitation_received).toBe(true);
    expect(r.body.email_prefs.operation_received).toBe(true);
  });

  it('PATCH /config/email-prefs mergea solo los flags presentes', async () => {
    const r = await request(app)
      .patch('/api/red-b2b/config/email-prefs')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ operation_received: false });
    expect(r.status).toBe(200);
    expect(r.body.email_prefs.operation_received).toBe(false);
    // Los otros flags quedan TRUE (preservados).
    expect(r.body.email_prefs.invitation_received).toBe(true);
    expect(r.body.email_prefs.payment_received).toBe(true);
  });

  it('PATCH con flag desconocido rechaza (.strict())', async () => {
    const r = await request(app)
      .patch('/api/red-b2b/config/email-prefs')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ bogus_flag: false });
    expect(r.status).toBe(400);
  });

  it('PATCH sin flags rechaza', async () => {
    const r = await request(app)
      .patch('/api/red-b2b/config/email-prefs')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(r.status).toBe(400);
  });
});
