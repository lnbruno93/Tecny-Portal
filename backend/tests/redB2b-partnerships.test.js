/**
 * Tests integration para Red B2B partnerships (F1 — #454).
 *
 * Cubre el lifecycle completo + edge cases críticos:
 *
 *   Happy path:
 *     · invite → accept → contactos linkeados en ambos lados
 *     · invite → reject → status=revoked motivo='rechazado'
 *     · invite → revoke por cada lado → status=revoked
 *
 *   Anti-abuse:
 *     · Rate limit 10/hora (NOTA: en NODE_ENV=test el limiter se skipea,
 *       así que probamos el cooldown anti-spam que sí tiene defensa
 *       en el código del handler — no es muteable por env).
 *     · Cooldown 24h tras revoke → 409 con reason='cooldown_active'.
 *
 *   Validación:
 *     · Target slug no existe → 404
 *     · Target suspended → 409
 *     · Ya hay partnership active → 409
 *     · Ya hay partnership pending → 409
 *     · No podés invitarte a vos mismo → 400
 *
 *   RLS / autoridad cross-tenant:
 *     · Tenant C intenta accept partnership entre A↔B → 404 (RLS la oculta)
 *     · Tenant C intenta revoke partnership entre A↔B → 404
 *     · Tenant C lista partnerships → solo ve las suyas (no A↔B)
 *
 *   Capability gate:
 *     · User sin cross_tenant.write → 403 en POST /invite
 *
 *   GET /:
 *     · ?status=active filtra a los activos
 *     · counts agregados correctos
 *
 *   Contactos linkeados post-accept:
 *     · Ambos tenants tienen un contacto con linked_tenant_id apuntando
 *       al otro.
 *
 * Setup:
 *   Creamos 3 tenants extra (red-b2b-test-a/-b/-c) + 3 users + 3 caps
 *   cross_tenant.write. Cleanup en afterAll borra todo lo del namespace.
 *   El test admin (testadmin, tenant 1) bypassea por role='admin' global,
 *   así que el resto del portal puede correr en paralelo sin conflictos.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

// Slugs y nombres reservados para esta suite. Sufijos consistentes para que
// el cleanup pueda hacer DELETE WHERE slug LIKE 'red-b2b-test-%'.
const TENANT_A = { slug: 'red-b2b-test-a', nombre: 'Red B2B Test A', plan: 'starter' };
const TENANT_B = { slug: 'red-b2b-test-b', nombre: 'Red B2B Test B', plan: 'pro' };
const TENANT_C = { slug: 'red-b2b-test-c', nombre: 'Red B2B Test C', plan: 'starter' };

let pool;
let tenantAId, tenantBId, tenantCId;
let userAId, userBId, userCId;
let userANoCapId;
let tokenA, tokenB, tokenC, tokenANoCap;

function signToken({ id, username, email, tenant_id, caps = {} }) {
  return jwt.sign(
    {
      id, username, email,
      role: 'op',
      tenant_id,
      tenant_rol: 'admin',         // adminOnly bypassea — no nos importa acá
      tenant_cap_rol: 'custom',    // no bypass por rol del tenant
      caps,                         // caps embebidas en JWT (fast path)
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

async function createUserForTenant(tenantId, { username, email }) {
  const hash = await bcrypt.hash('testpass1234', 10);
  // El TRUNCATE de setupTestDb borra `users`, así que arrancamos en limpio.
  // INSERT sin ON CONFLICT (la tabla no tiene unique en username; el unique
  // del portal está en LOWER(email)).
  const u = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
     VALUES ($1, $2, $3, $4, 'op', NOW())
     RETURNING id`,
    [username, username, email, hash]
  );
  const userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'admin')
     ON CONFLICT DO NOTHING`,
    [tenantId, userId]
  );
  // tenant_user_roles tiene FORCE RLS — necesitamos SET LOCAL.
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

beforeAll(async () => {
  pool = await setupTestDb();

  // Crear tenants A, B, C.
  tenantAId = await createTenant(TENANT_A);
  tenantBId = await createTenant(TENANT_B);
  tenantCId = await createTenant(TENANT_C);

  // Crear users en cada tenant.
  userAId = await createUserForTenant(tenantAId, {
    username: 'rb2b-user-a', email: 'rb2b-a@test.local',
  });
  userBId = await createUserForTenant(tenantBId, {
    username: 'rb2b-user-b', email: 'rb2b-b@test.local',
  });
  userCId = await createUserForTenant(tenantCId, {
    username: 'rb2b-user-c', email: 'rb2b-c@test.local',
  });
  userANoCapId = await createUserForTenant(tenantAId, {
    username: 'rb2b-user-a-nocap', email: 'rb2b-a-nocap@test.local',
  });

  // JWTs con `caps` embebido en el fast path. Los users A/B/C tienen
  // cross_tenant.write; el NoCap NO la tiene → debe rebotar 403.
  const capsOn = { 'cross_tenant.write': true };
  tokenA = signToken({
    id: userAId, username: 'rb2b-user-a', email: 'rb2b-a@test.local',
    tenant_id: tenantAId, caps: capsOn,
  });
  tokenB = signToken({
    id: userBId, username: 'rb2b-user-b', email: 'rb2b-b@test.local',
    tenant_id: tenantBId, caps: capsOn,
  });
  tokenC = signToken({
    id: userCId, username: 'rb2b-user-c', email: 'rb2b-c@test.local',
    tenant_id: tenantCId, caps: capsOn,
  });
  tokenANoCap = signToken({
    id: userANoCapId, username: 'rb2b-user-a-nocap',
    email: 'rb2b-a-nocap@test.local',
    tenant_id: tenantAId, caps: {},   // SIN cross_tenant.write
  });
});

// Cleanup entre tests — borrar partnerships y notifs del namespace nuestro.
// Esto NO toca otros tenants (cleanup acotado a los IDs A/B/C).
// Orden importa: cross_tenant_notifications tiene FK a tenant_partnerships,
// así que notifs primero.
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
  await pool.query(
    `DELETE FROM tenant_admin_actions WHERE tenant_id = ANY($1::int[])
       AND action IN ('cross_tenant_partnership_created', 'cross_tenant_partnership_revoked')`,
    [ids]
  );
  // Contactos linkeados por Red B2B → tienen linked_tenant_id NOT NULL.
  // En F3+ filtraremos por origen='red_b2b' cuando extendamos el CHECK.
  await pool.query(
    `DELETE FROM contactos WHERE tenant_id = ANY($1::int[]) AND linked_tenant_id IS NOT NULL`,
    [ids]
  );
});

afterAll(async () => {
  const ids = [tenantAId, tenantBId, tenantCId];
  const userIds = [userAId, userBId, userCId, userANoCapId];
  // Orden: hijos primero por FKs (notifs → partnerships → tenants).
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
describe('cross_tenant.write gate', () => {
  it('user SIN cap → 403 en POST /invite', async () => {
    const r = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenANoCap}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    expect(r.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Happy path invite + accept entre 2 tenants
// ──────────────────────────────────────────────────────────────────────────
describe('Happy path invite + accept', () => {
  it('A invita a B, B acepta → status=active + notif + contactos linkeados', async () => {
    // 1. A invita a B.
    const inviteRes = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug, message: 'Hola B, somos A' });
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.partnership.status).toBe('pending');
    expect(inviteRes.body.partnership.partner.slug).toBe(TENANT_B.slug);
    const partnershipId = inviteRes.body.partnership.id;

    // 2. Verificar notif a B.
    const notifQ = await pool.query(
      `SELECT type, payload FROM cross_tenant_notifications
         WHERE tenant_id = $1 AND partnership_id = $2`,
      [tenantBId, partnershipId]
    );
    expect(notifQ.rows.length).toBe(1);
    expect(notifQ.rows[0].type).toBe('invitation_received');

    // 3. B acepta.
    const acceptRes = await request(app)
      .post(`/api/red-b2b/partnerships/${partnershipId}/accept`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.partnership.status).toBe('active');
    expect(acceptRes.body.partnership.partner.slug).toBe(TENANT_A.slug);

    // 4. Notif al invitador (A).
    const notifAQ = await pool.query(
      `SELECT type FROM cross_tenant_notifications
         WHERE tenant_id = $1 AND partnership_id = $2`,
      [tenantAId, partnershipId]
    );
    expect(notifAQ.rows.map((r) => r.type)).toContain('invitation_accepted');

    // 5. Contactos linkeados en AMBOS lados.
    const contactoA = await pool.query(
      `SELECT id, nombre, linked_tenant_id FROM contactos
         WHERE tenant_id = $1 AND linked_tenant_id = $2`,
      [tenantAId, tenantBId]
    );
    expect(contactoA.rows.length).toBe(1);
    expect(contactoA.rows[0].nombre).toBe(TENANT_B.nombre);

    const contactoB = await pool.query(
      `SELECT id, nombre, linked_tenant_id FROM contactos
         WHERE tenant_id = $1 AND linked_tenant_id = $2`,
      [tenantBId, tenantAId]
    );
    expect(contactoB.rows.length).toBe(1);
    expect(contactoB.rows[0].nombre).toBe(TENANT_A.nombre);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Reject deja revoked con motivo 'rechazado'
// ──────────────────────────────────────────────────────────────────────────
describe('Reject lifecycle', () => {
  it('B rechaza invitación → status=revoked motivo "rechazado"', async () => {
    const inviteRes = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    const partnershipId = inviteRes.body.partnership.id;

    const rejectRes = await request(app)
      .post(`/api/red-b2b/partnerships/${partnershipId}/reject`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ reason: 'no aplica' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.partnership.status).toBe('revoked');
    expect(rejectRes.body.partnership.revoked_reason).toContain('rechazado');

    // DB tiene status='revoked'.
    const row = await pool.query(
      `SELECT status, revoked_reason FROM tenant_partnerships WHERE id=$1`,
      [partnershipId]
    );
    expect(row.rows[0].status).toBe('revoked');
    expect(row.rows[0].revoked_reason).toMatch(/rechazado/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Revoke por cada lado
// ──────────────────────────────────────────────────────────────────────────
describe('Revoke por ambos lados', () => {
  it('A revoca su partnership activa → status=revoked', async () => {
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/accept`)
      .set('Authorization', `Bearer ${tokenB}`);

    const rev = await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/revoke`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ reason: 'cambio de relación' });
    expect(rev.status).toBe(200);
    expect(rev.body.partnership.status).toBe('revoked');
  });

  it('B revoca su partnership activa → status=revoked + notif a A', async () => {
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/accept`)
      .set('Authorization', `Bearer ${tokenB}`);

    const rev = await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/revoke`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(rev.status).toBe(200);

    const notifs = await pool.query(
      `SELECT type FROM cross_tenant_notifications WHERE tenant_id = $1 AND type = 'partnership_revoked'`,
      [tenantAId]
    );
    expect(notifs.rows.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Cooldown anti-spam
// ──────────────────────────────────────────────────────────────────────────
describe('Cooldown anti-spam', () => {
  it('invite tras revoke <24h → 409 cooldown_active', async () => {
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/revoke`)
      .set('Authorization', `Bearer ${tokenA}`);

    // Re-invite inmediato — debe rebotar con 409 cooldown.
    const reInv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    expect(reInv.status).toBe(409);
    expect(reInv.body.reason).toBe('cooldown_active');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Validaciones de POST /invite
// ──────────────────────────────────────────────────────────────────────────
describe('Validaciones POST /invite', () => {
  it('target slug no existe → 404 target_not_found', async () => {
    const r = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: 'no-existe-este-tenant-xyz' });
    expect(r.status).toBe(404);
    expect(r.body.reason).toBe('target_not_found');
  });

  it('target suspended → 409 target_suspended', async () => {
    await pool.query(
      `UPDATE tenants SET suspended_at = NOW(), suspended_reason = 'test' WHERE id = $1`,
      [tenantBId]
    );
    try {
      const r = await request(app)
        .post('/api/red-b2b/partnerships/invite')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_tenant_slug: TENANT_B.slug });
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe('target_suspended');
    } finally {
      await pool.query(
        `UPDATE tenants SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1`,
        [tenantBId]
      );
    }
  });

  it('ya hay partnership active → 409 already_active', async () => {
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/accept`)
      .set('Authorization', `Bearer ${tokenB}`);

    const dup = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    expect(dup.status).toBe(409);
    expect(dup.body.reason).toBe('already_active');
  });

  it('ya hay partnership pending → 409 already_pending', async () => {
    await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    // Re-invite sin aceptar todavía.
    const dup = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    expect(dup.status).toBe(409);
    expect(dup.body.reason).toBe('already_pending');
  });

  it('invitarse a sí mismo → 400 cannot_invite_self', async () => {
    const r = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_A.slug });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe('cannot_invite_self');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// RLS leak attempts
// ──────────────────────────────────────────────────────────────────────────
describe('RLS leak attempts (cross-tenant)', () => {
  it('Tenant C intenta accept partnership A↔B → 404', async () => {
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });

    const leak = await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/accept`)
      .set('Authorization', `Bearer ${tokenC}`);
    expect(leak.status).toBe(404);

    // La partnership sigue pending.
    const row = await pool.query(
      `SELECT status FROM tenant_partnerships WHERE id = $1`,
      [inv.body.partnership.id]
    );
    expect(row.rows[0].status).toBe('pending');
  });

  it('Tenant C intenta revoke partnership A↔B → 404', async () => {
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/accept`)
      .set('Authorization', `Bearer ${tokenB}`);

    const leak = await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/revoke`)
      .set('Authorization', `Bearer ${tokenC}`);
    expect(leak.status).toBe(404);

    // Sigue activa.
    const row = await pool.query(
      `SELECT status FROM tenant_partnerships WHERE id = $1`,
      [inv.body.partnership.id]
    );
    expect(row.rows[0].status).toBe('active');
  });

  it('Tenant C lista partnerships → solo ve las suyas, no las de A↔B', async () => {
    // A↔B partnership.
    await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });

    // C lista — debe ver 0.
    const r = await request(app)
      .get('/api/red-b2b/partnerships')
      .set('Authorization', `Bearer ${tokenC}`);
    expect(r.status).toBe(200);
    expect(r.body.partnerships.length).toBe(0);
    expect(r.body.counts.pending_received_count).toBe(0);
    expect(r.body.counts.pending_sent_count).toBe(0);

    // A lista — debe ver 1.
    const rA = await request(app)
      .get('/api/red-b2b/partnerships')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(rA.body.partnerships.length).toBe(1);
  });

  // PR-E #464: gap detectado en audit focal Red B2B — POST /:id/reject sin
  // test cross-tenant. Mismo helper `getPartnershipByIdForTenant` que accept/
  // revoke (filtro `tenant_a_id = $caller OR tenant_b_id = $caller`) →
  // tenant C no participa → null → 404. La partnership sigue pending intacta.
  it('Tenant C intenta reject partnership pending A→B → 404 + sigue pending', async () => {
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    expect(inv.status).toBe(201);
    const partnershipId = inv.body.partnership.id;

    const leak = await request(app)
      .post(`/api/red-b2b/partnerships/${partnershipId}/reject`)
      .set('Authorization', `Bearer ${tokenC}`)
      .send({ reason: 'cross-tenant hack' });
    expect(leak.status).toBe(404);
    expect(leak.body.reason).toBe('not_found');

    // Defensa: sigue PENDING + sin revoked_* fields seteados.
    const row = await pool.query(
      `SELECT status, revoked_by_tenant_id, revoked_reason
         FROM tenant_partnerships WHERE id = $1`,
      [partnershipId]
    );
    expect(row.rows[0].status).toBe('pending');
    expect(row.rows[0].revoked_by_tenant_id).toBeNull();
    expect(row.rows[0].revoked_reason).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET / con filtros y counts
// ──────────────────────────────────────────────────────────────────────────
describe('GET / con filtros', () => {
  it('?status=active devuelve solo activos + counts coherentes', async () => {
    // 1 active A↔B + 1 pending A→C
    const inv1 = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    await request(app)
      .post(`/api/red-b2b/partnerships/${inv1.body.partnership.id}/accept`)
      .set('Authorization', `Bearer ${tokenB}`);
    await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_C.slug });

    const r = await request(app)
      .get('/api/red-b2b/partnerships?status=active')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.partnerships.length).toBe(1);
    expect(r.body.partnerships[0].status).toBe('active');

    // Counts globales (sin filtro de status — los counts son del universo
    // total visible al caller, no del filtro).
    expect(r.body.counts.active_count).toBe(1);
    expect(r.body.counts.pending_sent_count).toBe(1);
    expect(r.body.counts.pending_received_count).toBe(0);
  });

  it('B ve la pending como received en my_side', async () => {
    await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });

    const r = await request(app)
      .get('/api/red-b2b/partnerships')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(r.body.partnerships.length).toBe(1);
    expect(r.body.partnerships[0].my_side).toBe('received');
    expect(r.body.partnerships[0].partner.slug).toBe(TENANT_A.slug);
    expect(r.body.counts.pending_received_count).toBe(1);
    expect(r.body.counts.pending_sent_count).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// GET /:id detail
// ──────────────────────────────────────────────────────────────────────────
describe('GET /:id detalle', () => {
  it('devuelve partnership con stats vacías en F1', async () => {
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });

    const r = await request(app)
      .get(`/api/red-b2b/partnerships/${inv.body.partnership.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(r.status).toBe(200);
    expect(r.body.partnership.status).toBe('pending');
    expect(r.body.partnership.partner.slug).toBe(TENANT_B.slug);
    expect(r.body.stats).toEqual({
      operations_count: 0,
      total_usd_movido: 0,
      last_operation_at: null,
    });
  });

  it('tenant C intenta ver detalle A↔B → 404', async () => {
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });

    const r = await request(app)
      .get(`/api/red-b2b/partnerships/${inv.body.partnership.id}`)
      .set('Authorization', `Bearer ${tokenC}`);
    expect(r.status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PR-C B4 (issue #462) — SAVEPOINT en audit
//
// Regression: el helper `audit` en partnerships.js no envolvía el INSERT a
// tenant_admin_actions con SAVEPOINT, así que cualquier CHECK violation
// (action no whitelisteada en el constraint) abortaba TODA la tx — invite/
// revoke quedaba rollbackeado pero respondía 201/200 al cliente.
//
// Tests:
//   1. Happy: POST /invite escribe audit row → fila presente.
//   2. Resiliencia: si forzamos un CHECK violation INSERTANDO con un action
//      no permitido directamente (vía pool), verificamos que el comportamiento
//      esperado del SAVEPOINT está correctamente codificado (audit con valor
//      inválido NO debe abortar la tx padre).
// ──────────────────────────────────────────────────────────────────────────
describe('PR-C B4 — SAVEPOINT en partnerships#audit', () => {
  it('POST /invite persiste fila en tenant_admin_actions (happy path audit)', async () => {
    const r = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    expect(r.status).toBe(201);

    const auditQ = await pool.query(
      `SELECT action, after_state FROM tenant_admin_actions
         WHERE tenant_id = $1 AND action = 'cross_tenant_partnership_created'
         ORDER BY created_at DESC LIMIT 1`,
      [tenantAId]
    );
    expect(auditQ.rows.length).toBe(1);
    expect(auditQ.rows[0].action).toBe('cross_tenant_partnership_created');
    // payload contiene partnership_id + target_tenant.
    expect(auditQ.rows[0].after_state).toBeTruthy();
    expect(auditQ.rows[0].after_state.partnership_id).toBe(r.body.partnership.id);
  });

  it('POST /:id/revoke persiste fila audit `cross_tenant_partnership_revoked`', async () => {
    const inv = await request(app)
      .post('/api/red-b2b/partnerships/invite')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ target_tenant_slug: TENANT_B.slug });
    await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/accept`)
      .set('Authorization', `Bearer ${tokenB}`);
    const rev = await request(app)
      .post(`/api/red-b2b/partnerships/${inv.body.partnership.id}/revoke`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ reason: 'test revoke audit' });
    expect(rev.status).toBe(200);

    const auditQ = await pool.query(
      `SELECT action FROM tenant_admin_actions
         WHERE tenant_id = $1 AND action = 'cross_tenant_partnership_revoked'
         ORDER BY created_at DESC LIMIT 1`,
      [tenantAId]
    );
    expect(auditQ.rows.length).toBe(1);
  });

  it('SAVEPOINT aísla CHECK violation: action no whitelisteada no aborta tx padre', async () => {
    // Verificamos el invariante del SAVEPOINT pattern simulando lo que el
    // helper audit hace internamente. Esto es testing del MECANISMO que
    // protege a partnerships#audit (mismo patrón usado en pagos.js y
    // operations.js post-F3).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Operación legítima en la tx padre (algo que persista si todo va bien).
      const probe = await client.query(
        `INSERT INTO tenants (nombre, slug, plan)
         VALUES ('B4 SAVEPOINT Probe', 'b4-savepoint-probe', 'starter')
         ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre
         RETURNING id`
      );
      const probeId = probe.rows[0].id;

      // Simular audit con action inválida envuelto en SAVEPOINT — replica
      // exact lo que hace el helper audit() en partnerships.js.
      await client.query('SAVEPOINT sp_audit');
      try {
        await client.query(
          `INSERT INTO tenant_admin_actions
             (tenant_id, super_admin_user_id, action, before_state, after_state, reason)
           VALUES ($1, $2, 'NOT_A_VALID_ACTION_VALUE_FOR_CHECK', NULL, '{}'::jsonb, NULL)`,
          [tenantAId, userAId]
        );
        await client.query('RELEASE SAVEPOINT sp_audit');
        // Si llegamos acá, el CHECK fue removido — testing assumption rota.
        throw new Error('audit con action inválida DEBIÓ violar CHECK constraint');
      } catch (e) {
        if (e.code === '23514') {
          await client.query('ROLLBACK TO SAVEPOINT sp_audit');
        } else {
          throw e;
        }
      }

      // La tx padre sigue viva — podemos commitear y la operación previa
      // (probe) persiste. Sin SAVEPOINT, este COMMIT fallaría con
      // 'current transaction is aborted'.
      await client.query('COMMIT');

      const verify = await pool.query(
        `SELECT id FROM tenants WHERE id = $1`,
        [probeId]
      );
      expect(verify.rows.length).toBe(1);

      // Cleanup probe.
      await pool.query(`DELETE FROM tenants WHERE id = $1`, [probeId]);
    } finally {
      client.release();
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // PR-E #464: end-to-end regression guard del SAVEPOINT pattern.
  //
  // Los 2 happy-path tests arriba verifican que el audit row SE persiste
  // en flujo normal. El test 3 verifica el MECANISMO del SAVEPOINT
  // aisladamente. Faltaba el escenario integrado: si por cualquier razón
  // el INSERT a tenant_admin_actions falla con CHECK violation (ej:
  // refactor mete un action no whitelisteado, deployment con migration
  // pendiente, etc.), el invite NO debe rebotar — la partnership row
  // tiene que persistir y el handler responder 201.
  //
  // Estrategia: spy sobre db.adminQuery interceptando client.query para
  // throw 23514 (check_violation) específicamente cuando llegue el INSERT
  // a tenant_admin_actions. El helper audit en partnerships.js envuelve
  // ese INSERT en SAVEPOINT + ROLLBACK TO SAVEPOINT, así que el throw
  // queda atrapado y la tx padre sigue viva → COMMIT exitoso del invite.
  // ────────────────────────────────────────────────────────────────────────
  it('SAVEPOINT regression guard: INSERT audit falla → invite NO rollbackea (responde 201 + partnership persiste)', async () => {
    const db = require('../src/config/database');
    const originalAdminQuery = db.adminQuery.bind(db);
    const spy = jest.spyOn(db, 'adminQuery').mockImplementation(async (callback) => {
      return originalAdminQuery(async (client) => {
        const originalQuery = client.query.bind(client);
        // eslint-disable-next-line no-param-reassign
        client.query = function patchedQuery(textOrConfig, ...rest) {
          const text = typeof textOrConfig === 'string'
            ? textOrConfig
            : (textOrConfig && textOrConfig.text) || '';
          if (/INSERT\s+INTO\s+tenant_admin_actions/i.test(text)) {
            const err = new Error(
              'simulated CHECK violation on tenant_admin_actions.action (PR-E SAVEPOINT regression)'
            );
            err.code = '23514';
            return Promise.reject(err);
          }
          return originalQuery(textOrConfig, ...rest);
        };
        return callback(client);
      });
    });

    try {
      const r = await request(app)
        .post('/api/red-b2b/partnerships/invite')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_tenant_slug: TENANT_B.slug });

      // CRÍTICO: el handler responde 201 a pesar de que el INSERT al
      // audit row falló (SAVEPOINT lo aisló).
      expect(r.status).toBe(201);
      expect(r.body.partnership).toBeDefined();
      expect(r.body.partnership.id).toBeDefined();

      // Partnership row efectivamente persistida (la tx padre commiteó).
      const row = await pool.query(
        `SELECT status FROM tenant_partnerships WHERE id = $1`,
        [r.body.partnership.id]
      );
      expect(row.rows.length).toBe(1);
      expect(row.rows[0].status).toBe('pending');

      // Y el audit NO se persistió (el spy lo bloqueó, el SAVEPOINT
      // rollbackeó solo esa porción).
      const auditQ = await pool.query(
        `SELECT id FROM tenant_admin_actions
           WHERE tenant_id = $1 AND action = 'cross_tenant_partnership_created'`,
        [tenantAId]
      );
      expect(auditQ.rows.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
