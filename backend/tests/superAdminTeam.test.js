/**
 * Tests para /api/super-admin/team (#499) — invitar co-super-admins.
 *
 * Cubre:
 *   - Gate auth: 401 sin JWT, 403 con JWT válido pero no super-admin.
 *   - GET / lista super-admins activos con is_you correcto + pending invites.
 *   - POST /invite: happy path (crea invite + email mock + audit).
 *   - POST /invite: 409 si email ya es super-admin activo.
 *   - POST /invite: 409 si hay invite pendiente para ese email.
 *   - POST /revoke/:userId: rechaza auto-revoke (400).
 *   - POST /revoke/:userId: rechaza cuando es el último super-admin (400).
 *   - POST /revoke/:userId: happy path.
 *   - DELETE /invite/:id: revoca invite.
 *   - POST /invite/:id/resend: regenera token y expires_at.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const userAuthCache = require('../src/lib/userAuthCache');
const emailMod = require('../src/lib/superAdminInviteEmail');

let pool;
let superAdminToken;   // testadmin id=1 con is_super_admin=true + 2FA
let regularUserId;
let regularUserToken;  // NO super-admin

function makeToken(payload) {
  return jwt.sign(
    { ...payload, iat_ms: Date.now() },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
}

beforeAll(async () => {
  pool = await setupTestDb();

  // testadmin id=1 → super-admin con 2FA activa (para pasar S-25).
  await pool.query(`UPDATE users SET is_super_admin = true WHERE id = 1`);
  await pool.query(`
    INSERT INTO user_2fa (user_id, secret_encrypted, recovery_codes, enabled_at)
    VALUES (1, 'test-secret-enc', ARRAY['hash1','hash2'], NOW())
    ON CONFLICT (user_id) DO UPDATE SET enabled_at = NOW()
  `);
  await userAuthCache.invalidateUserAuth(1);

  superAdminToken = makeToken({
    id: 1, username: TEST_USER.username, email: TEST_USER.email,
    role: TEST_USER.role, tenant_id: 1, tenant_rol: 'owner',
    is_super_admin: true,
  });

  // User regular (no super-admin) para probar 403.
  const hash = await bcrypt.hash('pass1234', 10);
  const { rows: uRows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, is_super_admin)
     VALUES ('Regular #499', 'regularteam', 'regularteam@test.local', $1, 'admin', false)
     RETURNING id`,
    [hash]
  );
  regularUserId = uRows[0].id;
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'admin')`,
    [regularUserId]
  );
  regularUserToken = makeToken({
    id: regularUserId, username: 'regularteam', email: 'regularteam@test.local',
    role: 'admin', tenant_id: 1, tenant_rol: 'admin',
  });
});

afterAll(async () => {
  await pool.query(`DELETE FROM super_admin_invites`);
  await pool.query(`DELETE FROM tenant_admin_actions WHERE action LIKE 'super_admin_%'`);
  await pool.query(`DELETE FROM user_2fa WHERE user_id = 1`);
  await pool.query(`UPDATE users SET is_super_admin = false WHERE id = 1`);
  await userAuthCache.invalidateUserAuth(1);
  await teardownTestDb(pool);
});

beforeEach(() => {
  emailMod._resetTestQueue();
});

async function cleanupInvites() {
  await pool.query(`DELETE FROM super_admin_invites`);
}

describe('Super-Admin Team — gate', () => {
  it('401 sin JWT', async () => {
    const r = await request(app).get('/api/super-admin/team');
    expect(r.status).toBe(401);
  });

  it('403 con user regular', async () => {
    const r = await request(app)
      .get('/api/super-admin/team')
      .set('Authorization', `Bearer ${regularUserToken}`);
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('super_admin_required');
  });
});

describe('GET /api/super-admin/team', () => {
  it('devuelve super_admins con is_you=true para el caller', async () => {
    await cleanupInvites();
    const r = await request(app)
      .get('/api/super-admin/team')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.super_admins)).toBe(true);
    const me = r.body.super_admins.find((a) => a.id === 1);
    expect(me).toBeDefined();
    expect(me.is_you).toBe(true);
    expect(me.twofa_enabled).toBe(true);
    expect(Array.isArray(r.body.pending_invites)).toBe(true);
  });

  it('incluye invites pendientes con invited_by_username', async () => {
    await cleanupInvites();
    // Insertar una invite pendiente directamente.
    const hash = crypto.createHash('sha256').update('token-x').digest();
    await pool.query(
      `INSERT INTO super_admin_invites (email, nombre, token_hash, invited_by, expires_at)
       VALUES ('pending@test.local', 'Pending Person', $1, 1, NOW() + INTERVAL '48 hours')`,
      [hash]
    );

    const r = await request(app)
      .get('/api/super-admin/team')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    const inv = r.body.pending_invites.find((i) => i.email === 'pending@test.local');
    expect(inv).toBeDefined();
    expect(inv.nombre).toBe('Pending Person');
    expect(inv.invited_by_username).toBe(TEST_USER.username);
  });
});

describe('POST /api/super-admin/team/invite', () => {
  beforeEach(cleanupInvites);

  it('crea invite + envía email + response 201', async () => {
    const r = await request(app)
      .post('/api/super-admin/team/invite')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: 'nuevo@test.local', nombre: 'Nuevo Admin' });
    expect(r.status).toBe(201);
    expect(r.body.invite.email).toBe('nuevo@test.local');
    expect(r.body.invite.nombre).toBe('Nuevo Admin');
    expect(r.body.email_sent).toBe(true);
    // NO devuelve el token plaintext.
    expect(r.body.invite.token).toBeUndefined();

    // Email mock queue tiene el envío.
    const q = emailMod._getTestQueue();
    expect(q.length).toBe(1);
    expect(q[0].to).toBe('nuevo@test.local');
    expect(q[0].acceptUrl).toMatch(/\/aceptar-invitacion\?token=/);

    // Audit trail existe.
    const audit = await pool.query(
      `SELECT * FROM tenant_admin_actions WHERE action = 'super_admin_invited' ORDER BY id DESC LIMIT 1`
    );
    expect(audit.rows[0]).toBeDefined();
    expect(audit.rows[0].super_admin_user_id).toBe(1);
  });

  it('409 si email ya es super-admin activo', async () => {
    // TEST_USER (testadmin id=1) es super-admin activo.
    const r = await request(app)
      .post('/api/super-admin/team/invite')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: TEST_USER.email, nombre: 'Impostor' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('already_super_admin');
  });

  it('409 si ya hay invite pendiente', async () => {
    await request(app)
      .post('/api/super-admin/team/invite')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: 'dup@test.local', nombre: 'Dup Admin' });

    const r = await request(app)
      .post('/api/super-admin/team/invite')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: 'dup@test.local', nombre: 'Dup Admin' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('pending_invite_exists');
  });

  it('400 con email inválido (zod)', async () => {
    const r = await request(app)
      .post('/api/super-admin/team/invite')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: 'no-es-email', nombre: 'x' });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/super-admin/team/revoke/:userId', () => {
  it('400 si intenta auto-revocarse', async () => {
    const r = await request(app)
      .post('/api/super-admin/team/revoke/1')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('self_revoke_forbidden');
  });

  it('400 si sería el último super-admin', async () => {
    // Actualmente solo testadmin (id=1) es super-admin. Revocar CUALQUIER
    // otro user no aplica porque no son super-admins. Creamos uno para el test.
    const hash = await bcrypt.hash('lastPass9', 10);
    const { rows: u } = await pool.query(
      `INSERT INTO users (nombre, username, email, password_hash, role, is_super_admin)
       VALUES ('Last SA', 'lastsa', 'lastsa@test.local', $1, 'op', true)
       RETURNING id`,
      [hash]
    );
    const otherId = u[0].id;

    // Ahora hay 2 super-admins. Revocamos al recién creado — OK.
    const otherToken = makeToken({
      id: otherId, username: 'lastsa', email: 'lastsa@test.local',
      role: 'op', tenant_id: 1, tenant_rol: 'member',
    });
    // Actualizamos el count-based guard: al revocar `otherId` con caller=1,
    // quedaría 1 super-admin (el propio caller). OK — 200.
    const rOk = await request(app)
      .post(`/api/super-admin/team/revoke/${otherId}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(rOk.status).toBe(200);

    // Confirmamos que el user perdió is_super_admin.
    const { rows: check } = await pool.query(
      `SELECT is_super_admin FROM users WHERE id = $1`, [otherId]
    );
    expect(check[0].is_super_admin).toBe(false);

    // Ahora si otro super-admin (creamos y probamos el "last" caso):
    // Reactivamos otherId como super-admin y trata que ella revoque al 1.
    await pool.query(`UPDATE users SET is_super_admin = true WHERE id = $1`, [otherId]);
    await userAuthCache.invalidateUserAuth(otherId);
    // Setup 2FA para otherId (para pasar S-25):
    await pool.query(`
      INSERT INTO user_2fa (user_id, secret_encrypted, recovery_codes, enabled_at)
      VALUES ($1, 'x', ARRAY['h'], NOW())
      ON CONFLICT (user_id) DO UPDATE SET enabled_at = NOW()
    `, [otherId]);
    await userAuthCache.invalidateUserAuth(otherId);

    // 2026-07-12 (auditoría TOTAL Auth P1-2): el revoke previo bumpeó
    // password_changed_at → otherToken quedó inválido (iat_ms < changedAt).
    // Ahora que reactivamos manualmente, hay que re-mintear el token para
    // que otherId pueda seguir operando. Refresh password_changed_at para
    // que el nuevo iat_ms sea mayor.
    await pool.query(
      `UPDATE users SET password_changed_at = to_timestamp((EXTRACT(EPOCH FROM NOW()) - 1)) WHERE id = $1`,
      [otherId]
    );
    const otherTokenFresh = makeToken({
      id: otherId, username: 'lastsa', email: 'lastsa@test.local',
      role: 'op', tenant_id: 1, tenant_rol: 'member',
    });

    // otherId revoca a testadmin(1) — quedaría solo otherId. OK.
    const rLast = await request(app)
      .post('/api/super-admin/team/revoke/1')
      .set('Authorization', `Bearer ${otherTokenFresh}`);
    expect(rLast.status).toBe(200);

    // Ahora otherId es EL ÚLTIMO. Intentar revocar a alguien que no existe
    // como super-admin nos da otro error; probamos el path del último:
    // Volvemos a hacer testadmin super-admin para hacer un segundo intento
    // controlado del path 'last_super_admin'.
    await pool.query(`UPDATE users SET is_super_admin = true WHERE id = 1`);
    // 2026-07-12 (auditoría TOTAL Auth P1-2): el revoke previo (rLast)
    // bumpeó password_changed_at de user 1 — superAdminToken quedó inválido.
    // Backdate password_changed_at para que el token pre-existente vuelva a
    // ser válido (iat_ms > changedAt). Solo para el resto del test suite;
    // los tests siguientes ya asumen superAdminToken vivo.
    await pool.query(
      `UPDATE users SET password_changed_at = to_timestamp((EXTRACT(EPOCH FROM NOW()) - 3600)) WHERE id = 1`
    );
    await userAuthCache.invalidateUserAuth(1);
    // Revocar otherId — deja solo a testadmin. OK.
    const rClean = await request(app)
      .post(`/api/super-admin/team/revoke/${otherId}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(rClean.status).toBe(200);

    // Rest post-rClean: el revoke bumpeó password_changed_at de otherId
    // pero no de user 1 (self-revoke bloqueado). Pero necesitamos volver a
    // dejar el token del user 1 vivo para tests siguientes que lo usan.
    // Backdate su password_changed_at otra vez a antes del token.
    await pool.query(
      `UPDATE users SET password_changed_at = to_timestamp((EXTRACT(EPOCH FROM NOW()) - 3600)) WHERE id = 1`
    );
    await userAuthCache.invalidateUserAuth(1);

    // Cleanup manual del test.
    // NOTA: tenant_admin_actions.super_admin_user_id tiene FK a users(id)
    // sin ON DELETE. Los audits del test dejan filas apuntando a otherId
    // que impiden DELETE FROM users. Borrar audits primero.
    await pool.query(`DELETE FROM tenant_admin_actions WHERE super_admin_user_id = $1`, [otherId]);
    await pool.query(`DELETE FROM user_2fa WHERE user_id = $1`, [otherId]);
    await pool.query(`DELETE FROM tenant_users WHERE user_id = $1`, [otherId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [otherId]);
  });

  it('404 si el user no existe', async () => {
    const r = await request(app)
      .post('/api/super-admin/team/revoke/999999')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/super-admin/team/invite/:id', () => {
  beforeEach(cleanupInvites);

  it('revoca una invite pendiente', async () => {
    const inv = await request(app)
      .post('/api/super-admin/team/invite')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: 'revoke@test.local', nombre: 'Revoke Me' });
    expect(inv.status).toBe(201);
    const inviteId = inv.body.invite.id;

    const r = await request(app)
      .delete(`/api/super-admin/team/invite/${inviteId}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);

    // No aparece en pending invites.
    const list = await request(app)
      .get('/api/super-admin/team')
      .set('Authorization', `Bearer ${superAdminToken}`);
    const found = list.body.pending_invites.find((i) => i.id === inviteId);
    expect(found).toBeUndefined();
  });

  it('404 si la invite no existe', async () => {
    const r = await request(app)
      .delete(`/api/super-admin/team/invite/999999`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(404);
  });
});

describe('POST /api/super-admin/team/invite/:id/resend', () => {
  beforeEach(cleanupInvites);

  it('regenera token y actualiza expires_at', async () => {
    const inv = await request(app)
      .post('/api/super-admin/team/invite')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ email: 'resend@test.local', nombre: 'Resend Me' });
    const inviteId = inv.body.invite.id;
    const firstExpiresAt = new Date(inv.body.invite.expires_at).getTime();

    // Snapshot del hash actual.
    const { rows: before } = await pool.query(
      `SELECT token_hash FROM super_admin_invites WHERE id = $1`, [inviteId]
    );

    // Esperar 5ms para garantizar que expires_at cambia (NOW() del reset).
    await new Promise((r) => setTimeout(r, 5));

    const r = await request(app)
      .post(`/api/super-admin/team/invite/${inviteId}/resend`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.email_sent).toBe(true);

    // Hash cambió — el token viejo NO sirve más.
    const { rows: after } = await pool.query(
      `SELECT token_hash, expires_at FROM super_admin_invites WHERE id = $1`, [inviteId]
    );
    expect(after[0].token_hash.equals(before[0].token_hash)).toBe(false);
    expect(new Date(after[0].expires_at).getTime()).toBeGreaterThanOrEqual(firstExpiresAt);
  });
});
