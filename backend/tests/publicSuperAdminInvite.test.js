/**
 * Tests para /api/public/super-admin-invite (#499) — flow público de aceptar
 * invitación (verify + accept).
 *
 * Cubre:
 *   - GET /:token → 200 si válida
 *   - GET /:token → 404 (ambiguo) si expirada / revocada / aceptada / inexistente
 *   - POST /:token/accept → crea user + devuelve JWT + marca invite aceptada
 *   - POST /:token/accept → rechaza password inválido (policy zod)
 *   - POST /:token/accept → idempotencia: segundo intento devuelve 404
 */

const request = require('supertest');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;

async function insertInvite(overrides = {}) {
  const plaintext = crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(plaintext).digest();
  const {
    email = `invited-${crypto.randomBytes(4).toString('hex')}@test.local`,
    nombre = 'Invited User',
    expiresInMs = 48 * 60 * 60 * 1000,
    accepted = false,
    revoked  = false,
  } = overrides;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInMs);
  const { rows } = await pool.query(
    `INSERT INTO super_admin_invites
       (email, nombre, token_hash, invited_by, invited_at, expires_at, accepted_at, revoked_at)
     VALUES ($1, $2, $3, 1, NOW(), $4, $5, $6)
     RETURNING id`,
    [
      email, nombre, hash, expiresAt,
      accepted ? now : null,
      revoked ? now : null,
    ]
  );
  return { plaintext, id: rows[0].id, email, nombre };
}

beforeAll(async () => {
  pool = await setupTestDb();
  await pool.query(`UPDATE users SET is_super_admin = true WHERE id = 1`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM super_admin_invites`);
  await pool.query(`DELETE FROM tenant_admin_actions WHERE action LIKE 'super_admin_%'`);
  await pool.query(`UPDATE users SET is_super_admin = false WHERE id = 1`);
  await teardownTestDb(pool);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM super_admin_invites`);
});

describe('GET /api/public/super-admin-invite/:token', () => {
  it('200 con email + nombre + invited_by_username si válida', async () => {
    const { plaintext } = await insertInvite({ email: 'valid@test.local', nombre: 'Valid Guy' });
    const r = await request(app).get(`/api/public/super-admin-invite/${plaintext}`);
    expect(r.status).toBe(200);
    expect(r.body.email).toBe('valid@test.local');
    expect(r.body.nombre).toBe('Valid Guy');
    expect(r.body.invited_by_username).toBeDefined();
    // NO devuelve datos sensibles.
    expect(r.body.token).toBeUndefined();
    expect(r.body.expires_at).toBeUndefined();
  });

  it('404 si el token no existe', async () => {
    const r = await request(app).get(`/api/public/super-admin-invite/${'a'.repeat(43)}`);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('invite_invalid_or_expired');
  });

  it('404 si la invite expiró', async () => {
    const { plaintext } = await insertInvite({ expiresInMs: -1000 });
    const r = await request(app).get(`/api/public/super-admin-invite/${plaintext}`);
    expect(r.status).toBe(404);
  });

  it('404 si la invite fue revocada', async () => {
    const { plaintext } = await insertInvite({ revoked: true });
    const r = await request(app).get(`/api/public/super-admin-invite/${plaintext}`);
    expect(r.status).toBe(404);
  });

  it('404 si la invite ya fue aceptada', async () => {
    const { plaintext } = await insertInvite({ accepted: true });
    const r = await request(app).get(`/api/public/super-admin-invite/${plaintext}`);
    expect(r.status).toBe(404);
  });
});

describe('POST /api/public/super-admin-invite/:token/accept', () => {
  it('crea user is_super_admin=true + devuelve JWT + marca aceptada', async () => {
    const { plaintext, id, email } = await insertInvite({
      email: 'newsa@test.local',
      nombre: 'New SA',
    });

    const r = await request(app)
      .post(`/api/public/super-admin-invite/${plaintext}/accept`)
      .send({ password: 'ClaveFuerte1' });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeDefined();
    expect(r.body.user.is_super_admin).toBe(true);
    expect(r.body.user.email).toBe(email);

    // JWT decodable y con claim.
    const decoded = jwt.verify(r.body.token, process.env.JWT_SECRET);
    expect(decoded.is_super_admin).toBe(true);
    expect(decoded.id).toBe(r.body.user.id);

    // Invite marcada aceptada.
    const { rows } = await pool.query(
      `SELECT accepted_at, accepted_user_id FROM super_admin_invites WHERE id = $1`, [id]
    );
    expect(rows[0].accepted_at).not.toBeNull();
    expect(rows[0].accepted_user_id).toBe(r.body.user.id);

    // User creado con tenant_users al tenant 1.
    const { rows: tuRows } = await pool.query(
      `SELECT tenant_id FROM tenant_users WHERE user_id = $1`, [r.body.user.id]
    );
    expect(tuRows[0].tenant_id).toBe(1);
  });

  it('400 si password no cumple policy', async () => {
    const { plaintext } = await insertInvite();
    const r = await request(app)
      .post(`/api/public/super-admin-invite/${plaintext}/accept`)
      .send({ password: 'corta' });
    expect(r.status).toBe(400);
  });

  it('segundo accept del mismo token devuelve 404 (idempotencia)', async () => {
    const { plaintext } = await insertInvite({ email: 'twice@test.local' });

    const r1 = await request(app)
      .post(`/api/public/super-admin-invite/${plaintext}/accept`)
      .send({ password: 'ClaveFuerte1' });
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .post(`/api/public/super-admin-invite/${plaintext}/accept`)
      .send({ password: 'ClaveFuerte1' });
    expect(r2.status).toBe(404);
    expect(r2.body.code).toBe('invite_invalid_or_expired');
  });

  it('404 si el token no existe', async () => {
    const r = await request(app)
      .post(`/api/public/super-admin-invite/${'z'.repeat(43)}/accept`)
      .send({ password: 'ClaveFuerte1' });
    expect(r.status).toBe(404);
  });

  // 2026-07-28 (bug reportado por Lucas — hermano matiashbruno98):
  // Cuando el email invitado ya tiene un user activo (creado antes de la
  // invitación, ej. signup normal al portal cliente), el flow ahora hace
  // UPSERT en vez de rechazar con 409 "email_taken". Efecto:
  //   - Promociona is_super_admin=false → true
  //   - Resetea password_hash + password_changed_at (invalida JWTs stale)
  //   - Preserva email_verified_at si ya estaba, sino lo setea a NOW()
  //   - Preserva tenant_users existentes (ON CONFLICT DO NOTHING)
  //   - Devuelve JWT firmado — el user queda logueado al admin
  // Seguridad: el invite fue enviado al email → prueba de propiedad (mismo
  // trust que forgot-password) + captcha antes + super-admin invitador
  // aprobó explícitamente.
  it('user existente NO-super-admin es PROMOVIDO al aceptar invite (UPSERT)', async () => {
    // 1. Pre-crear user existente (simula que matiashbruno98 ya tenía cuenta
    //    desde antes por un flow previo — signup casual, invite a tenant, etc.)
    const email = 'existing@test.local';
    const { rows: [existingUser] } = await pool.query(
      `INSERT INTO users
         (nombre, username, email, password_hash, role, is_super_admin, email_verified_at)
       VALUES ('Existing User', 'existing_user', $1,
               '$2b$12$dummy.hash.replaced.by.accept.flow.abcdefghij',
               'op', false, NOW() - INTERVAL '30 days')
       RETURNING id, password_hash, email_verified_at`,
      [email]
    );
    // También tiene su propio tenant como owner (simula "Mi empresa SA" del hermano).
    const { rows: [tenant] } = await pool.query(
      `INSERT INTO tenants (nombre, slug, pais)
       VALUES ('User Own Tenant', 'user-own-tenant-' || $1, 'AR')
       RETURNING id`,
      [crypto.randomBytes(4).toString('hex')]
    );
    await pool.query(
      `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES ($1, $2, 'owner')`,
      [tenant.id, existingUser.id]
    );

    // 2. Super-admin lo invita a ser co-super-admin.
    const { plaintext, id: inviteId } = await insertInvite({
      email,
      nombre: 'Existing User (promoted)',
    });

    // 3. User acepta invite — antes rebotaba con 409, ahora hace UPSERT.
    const r = await request(app)
      .post(`/api/public/super-admin-invite/${plaintext}/accept`)
      .send({ password: 'NuevaClave1' });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeDefined();
    expect(r.body.user.id).toBe(existingUser.id);  // MISMO id, no crea otro
    expect(r.body.user.email).toBe(email);
    expect(r.body.user.is_super_admin).toBe(true);

    // 4. DB state: user promovido, password bumpeada, invite aceptada.
    const { rows: [after] } = await pool.query(
      `SELECT is_super_admin, password_hash, password_changed_at, email_verified_at
         FROM users WHERE id = $1`,
      [existingUser.id]
    );
    expect(after.is_super_admin).toBe(true);
    expect(after.password_hash).not.toBe(existingUser.password_hash); // reset
    expect(after.password_changed_at).not.toBeNull(); // bumpeada
    // email_verified_at preservado (era hace 30 días, no lo pisamos con NOW()).
    expect(after.email_verified_at.getTime()).toBe(existingUser.email_verified_at.getTime());

    // 5. tenant_users preservado (SU tenant propio) + agregado el home tenant.
    const { rows: tuRows } = await pool.query(
      `SELECT tenant_id, rol FROM tenant_users WHERE user_id = $1 ORDER BY tenant_id`,
      [existingUser.id]
    );
    expect(tuRows.length).toBe(2);
    expect(tuRows.find(r => r.tenant_id === 1)).toEqual({ tenant_id: 1, rol: 'member' }); // home
    expect(tuRows.find(r => r.tenant_id === tenant.id)).toEqual({ tenant_id: tenant.id, rol: 'owner' }); // preserva propio

    // 6. Invite marcada aceptada apuntando al user existente.
    const { rows: [inviteAfter] } = await pool.query(
      `SELECT accepted_at, accepted_user_id FROM super_admin_invites WHERE id = $1`,
      [inviteId]
    );
    expect(inviteAfter.accepted_at).not.toBeNull();
    expect(inviteAfter.accepted_user_id).toBe(existingUser.id);

    // 7. Audit trail refleja path='promoted_existing' + password_reset=true.
    const { rows: [audit] } = await pool.query(
      `SELECT after_state FROM tenant_admin_actions
        WHERE action = 'super_admin_invite_accepted'
          AND (after_state->>'new_user_id')::int = $1
        ORDER BY id DESC LIMIT 1`,
      [existingUser.id]
    );
    expect(audit.after_state.path).toBe('promoted_existing');
    expect(audit.after_state.password_reset).toBe(true);
  });

  it('audit trail marca path=created para user NUEVO (regresión check del audit shape)', async () => {
    const { plaintext } = await insertInvite({
      email: 'brandnew@test.local',
      nombre: 'Brand New',
    });

    const r = await request(app)
      .post(`/api/public/super-admin-invite/${plaintext}/accept`)
      .send({ password: 'ClaveFuerte1' });
    expect(r.status).toBe(200);

    const { rows: [audit] } = await pool.query(
      `SELECT after_state FROM tenant_admin_actions
        WHERE action = 'super_admin_invite_accepted'
          AND (after_state->>'new_user_id')::int = $1
        ORDER BY id DESC LIMIT 1`,
      [r.body.user.id]
    );
    expect(audit.after_state.path).toBe('created');
    expect(audit.after_state.password_reset).toBe(false);
  });
});
