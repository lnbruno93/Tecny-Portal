/**
 * Tests de integración — Release notes (task #141, 2026-07-16).
 *
 * Cubre:
 *   Admin CRUD (super-admin only):
 *     - POST /api/super-admin/release-notes    → 401/403/400/201 (create + validate)
 *     - GET  /api/super-admin/release-notes    → list ordered DESC
 *     - PATCH /api/super-admin/release-notes/:id → partial update
 *     - DELETE /api/super-admin/release-notes/:id → 404 si no existe, ok si sí
 *
 *   Público (cualquier user autenticado):
 *     - GET  /api/release-notes             → 401 sin token, lista con default limit
 *     - GET  /api/release-notes/count-unseen → count depende de last_seen_release_notes_at
 *     - POST /api/release-notes/mark-seen   → limpia el badge (count vuelve a 0)
 *
 * Setup: reutilizamos testadmin (id=1) como super-admin, y creamos un
 * user regular para validar el gate 403 en los endpoints CRUD.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const userAuthCache = require('../src/lib/userAuthCache');

let pool;
let superAdminToken;
let regularUserToken;
let regularUserId;

beforeAll(async () => {
  pool = await setupTestDb();

  // Marcar testadmin (id=1) como super-admin + 2FA (requireSuperAdmin lo exige).
  await pool.query(`UPDATE users SET is_super_admin = true WHERE id = 1`);
  await pool.query(`
    INSERT INTO user_2fa (user_id, secret_encrypted, recovery_codes, enabled_at)
    VALUES (1, 'test-secret-enc', ARRAY['hash1','hash2'], NOW())
    ON CONFLICT (user_id) DO UPDATE SET enabled_at = NOW()
  `);
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

  // User regular (mismo tenant, no super-admin) — para validar el 403.
  const hash = await bcrypt.hash('pass1234', 10);
  const { rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, is_super_admin)
     VALUES ('Regular RN', 'regularrn', 'regrn@test.local', $1, 'admin', false)
     RETURNING id`,
    [hash]
  );
  regularUserId = rows[0].id;
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'admin')`,
    [regularUserId]
  );
  regularUserToken = jwt.sign(
    {
      id: regularUserId, username: 'regularrn', email: 'regrn@test.local',
      role: 'admin', tenant_id: 1, tenant_rol: 'admin',
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  // Aseguramos que testadmin tenga email_verified (requireAuth bloquea POST
  // para users unverified). El seed lo deja verified pero doble-cheque.
  await pool.query(
    `UPDATE users SET email_verified_at = NOW() WHERE id IN (1, $1)`,
    [regularUserId]
  );
  await userAuthCache.invalidateUserAuth(1);
  await userAuthCache.invalidateUserAuth(regularUserId);
});

afterAll(async () => {
  await pool.query(`DELETE FROM release_notes`);
  await pool.query(`UPDATE users SET is_super_admin = false, last_seen_release_notes_at = NULL WHERE id = 1`);
  await pool.query(`DELETE FROM user_2fa WHERE user_id = 1`);
  await userAuthCache.invalidateUserAuth(1);
  await teardownTestDb(pool);
});

beforeEach(async () => {
  // Limpiamos entre tests para asilar counts / listas.
  await pool.query(`DELETE FROM release_notes`);
  await pool.query(`UPDATE users SET last_seen_release_notes_at = NULL WHERE id IN (1, $1)`, [regularUserId]);
});

// ─── Admin CRUD ──────────────────────────────────────────────────────────

describe('Admin CRUD — /api/super-admin/release-notes', () => {
  it('401 sin JWT', async () => {
    const r = await request(app).get('/api/super-admin/release-notes');
    expect(r.status).toBe(401);
  });

  it('403 con JWT válido pero is_super_admin=false', async () => {
    const r = await request(app)
      .get('/api/super-admin/release-notes')
      .set('Authorization', `Bearer ${regularUserToken}`);
    expect(r.status).toBe(403);
  });

  describe('POST — validación', () => {
    const post = (body) => request(app)
      .post('/api/super-admin/release-notes')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(body);

    it('400 sin titulo', async () => {
      const r = await post({ descripcion: 'x', tipo: 'feature' });
      expect(r.status).toBe(400);
      expect(r.body.fields.titulo).toBeDefined();
    });

    it('400 titulo > 60 chars', async () => {
      const r = await post({ titulo: 'x'.repeat(61), descripcion: 'x', tipo: 'feature' });
      expect(r.status).toBe(400);
      expect(r.body.fields.titulo).toMatch(/60/);
    });

    it('400 descripcion > 280 chars', async () => {
      const r = await post({ titulo: 'ok', descripcion: 'x'.repeat(281), tipo: 'feature' });
      expect(r.status).toBe(400);
      expect(r.body.fields.descripcion).toMatch(/280/);
    });

    it('400 tipo inválido', async () => {
      const r = await post({ titulo: 'ok', descripcion: 'x', tipo: 'wat' });
      expect(r.status).toBe(400);
      expect(r.body.fields.tipo).toBeDefined();
    });

    it('400 publicado_en inválido', async () => {
      const r = await post({ titulo: 'ok', descripcion: 'x', tipo: 'feature', publicado_en: 'no-fecha' });
      expect(r.status).toBe(400);
      expect(r.body.fields.publicado_en).toBeDefined();
    });

    it('201 create con tipos válidos (feature/mejora/fix)', async () => {
      for (const tipo of ['feature', 'mejora', 'fix']) {
        const r = await post({ titulo: `t-${tipo}`, descripcion: `d-${tipo}`, tipo });
        expect(r.status).toBe(201);
        expect(r.body.tipo).toBe(tipo);
        expect(r.body.id).toBeDefined();
        expect(r.body.publicado_en).toBeDefined();
      }
    });

    it('201 create con publicado_en explícito', async () => {
      const past = '2026-01-01T12:00:00Z';
      const r = await post({ titulo: 'retro', descripcion: 'antigua', tipo: 'mejora', publicado_en: past });
      expect(r.status).toBe(201);
      expect(new Date(r.body.publicado_en).toISOString()).toBe(new Date(past).toISOString());
    });

    it('trim de titulo/descripcion — deja solo el contenido no whitespace', async () => {
      const r = await post({ titulo: '  hola  ', descripcion: '  desc  ', tipo: 'fix' });
      expect(r.status).toBe(201);
      expect(r.body.titulo).toBe('hola');
      expect(r.body.descripcion).toBe('desc');
    });
  });

  describe('GET — list', () => {
    it('lista vacía inicialmente', async () => {
      const r = await request(app)
        .get('/api/super-admin/release-notes')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(r.status).toBe(200);
      expect(r.body.release_notes).toEqual([]);
    });

    it('devuelve ordenado por publicado_en DESC', async () => {
      const auth = { Authorization: `Bearer ${superAdminToken}` };
      await request(app).post('/api/super-admin/release-notes').set(auth)
        .send({ titulo: 'vieja', descripcion: 'x', tipo: 'fix', publicado_en: '2026-01-01T00:00:00Z' });
      await request(app).post('/api/super-admin/release-notes').set(auth)
        .send({ titulo: 'nueva', descripcion: 'x', tipo: 'feature', publicado_en: '2026-07-15T00:00:00Z' });

      const r = await request(app).get('/api/super-admin/release-notes').set(auth);
      expect(r.body.release_notes).toHaveLength(2);
      expect(r.body.release_notes[0].titulo).toBe('nueva');
      expect(r.body.release_notes[1].titulo).toBe('vieja');
    });
  });

  describe('PATCH — partial update', () => {
    it('actualiza solo los campos enviados', async () => {
      const auth = { Authorization: `Bearer ${superAdminToken}` };
      const c = await request(app).post('/api/super-admin/release-notes').set(auth)
        .send({ titulo: 'orig', descripcion: 'orig desc', tipo: 'feature' });
      const id = c.body.id;

      const r = await request(app).patch(`/api/super-admin/release-notes/${id}`).set(auth)
        .send({ titulo: 'editado' });
      expect(r.status).toBe(200);
      expect(r.body.titulo).toBe('editado');
      expect(r.body.descripcion).toBe('orig desc'); // no tocado
      expect(r.body.tipo).toBe('feature');
    });

    it('400 si tipo inválido en PATCH', async () => {
      const auth = { Authorization: `Bearer ${superAdminToken}` };
      const c = await request(app).post('/api/super-admin/release-notes').set(auth)
        .send({ titulo: 'x', descripcion: 'x', tipo: 'fix' });

      const r = await request(app).patch(`/api/super-admin/release-notes/${c.body.id}`).set(auth)
        .send({ tipo: 'wat' });
      expect(r.status).toBe(400);
    });

    it('400 si body vacío', async () => {
      const auth = { Authorization: `Bearer ${superAdminToken}` };
      const c = await request(app).post('/api/super-admin/release-notes').set(auth)
        .send({ titulo: 'x', descripcion: 'x', tipo: 'fix' });

      const r = await request(app).patch(`/api/super-admin/release-notes/${c.body.id}`).set(auth).send({});
      expect(r.status).toBe(400);
    });

    it('404 si id no existe', async () => {
      const auth = { Authorization: `Bearer ${superAdminToken}` };
      const r = await request(app)
        .patch('/api/super-admin/release-notes/00000000-0000-0000-0000-000000000000')
        .set(auth).send({ titulo: 'x' });
      expect(r.status).toBe(404);
    });
  });

  describe('DELETE — hard delete', () => {
    it('borra y devuelve ok', async () => {
      const auth = { Authorization: `Bearer ${superAdminToken}` };
      const c = await request(app).post('/api/super-admin/release-notes').set(auth)
        .send({ titulo: 'to-delete', descripcion: 'x', tipo: 'fix' });

      const r = await request(app).delete(`/api/super-admin/release-notes/${c.body.id}`).set(auth);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);

      const list = await request(app).get('/api/super-admin/release-notes').set(auth);
      expect(list.body.release_notes).toHaveLength(0);
    });

    it('404 si id no existe', async () => {
      const auth = { Authorization: `Bearer ${superAdminToken}` };
      const r = await request(app)
        .delete('/api/super-admin/release-notes/00000000-0000-0000-0000-000000000000')
        .set(auth);
      expect(r.status).toBe(404);
    });
  });
});

// ─── Público ─────────────────────────────────────────────────────────────

describe('Público — /api/release-notes', () => {
  const authRegular = () => ({ Authorization: `Bearer ${regularUserToken}` });

  it('401 sin token', async () => {
    const r = await request(app).get('/api/release-notes');
    expect(r.status).toBe(401);
  });

  it('devuelve lista (ordenada DESC, mismo shape que admin GET pero sin timestamps internos)', async () => {
    // Seed via admin API
    const authAdmin = { Authorization: `Bearer ${superAdminToken}` };
    await request(app).post('/api/super-admin/release-notes').set(authAdmin)
      .send({ titulo: 'primera', descripcion: 'd1', tipo: 'feature', publicado_en: '2026-01-01T00:00:00Z' });
    await request(app).post('/api/super-admin/release-notes').set(authAdmin)
      .send({ titulo: 'segunda', descripcion: 'd2', tipo: 'fix',     publicado_en: '2026-06-01T00:00:00Z' });

    const r = await request(app).get('/api/release-notes').set(authRegular());
    expect(r.status).toBe(200);
    expect(r.body.release_notes).toHaveLength(2);
    expect(r.body.release_notes[0].titulo).toBe('segunda'); // más reciente
    expect(r.body.release_notes[0]).toHaveProperty('id');
    expect(r.body.release_notes[0]).toHaveProperty('tipo');
    expect(r.body.release_notes[0]).toHaveProperty('publicado_en');
    // el shape público NO expone created_at/updated_at
    expect(r.body.release_notes[0]).not.toHaveProperty('created_at');
    expect(r.body.release_notes[0]).not.toHaveProperty('updated_at');
  });

  it('respeta ?limit=N (default 50, cap 200)', async () => {
    const authAdmin = { Authorization: `Bearer ${superAdminToken}` };
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/super-admin/release-notes').set(authAdmin)
        .send({ titulo: `n${i}`, descripcion: 'x', tipo: 'feature' });
    }
    const r = await request(app).get('/api/release-notes?limit=2').set(authRegular());
    expect(r.body.release_notes).toHaveLength(2);
  });
});

describe('Público — count-unseen + mark-seen', () => {
  const authRegular = () => ({ Authorization: `Bearer ${regularUserToken}` });
  const authAdmin   = () => ({ Authorization: `Bearer ${superAdminToken}` });

  it('user con last_seen NULL ve TODAS las notas como unseen', async () => {
    await request(app).post('/api/super-admin/release-notes').set(authAdmin())
      .send({ titulo: 'a', descripcion: 'x', tipo: 'feature' });
    await request(app).post('/api/super-admin/release-notes').set(authAdmin())
      .send({ titulo: 'b', descripcion: 'x', tipo: 'fix' });

    const r = await request(app).get('/api/release-notes/count-unseen').set(authRegular());
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
  });

  it('mark-seen resetea el count a 0', async () => {
    await request(app).post('/api/super-admin/release-notes').set(authAdmin())
      .send({ titulo: 'a', descripcion: 'x', tipo: 'feature' });

    const marked = await request(app).post('/api/release-notes/mark-seen').set(authRegular());
    expect(marked.status).toBe(200);
    expect(marked.body.ok).toBe(true);

    const count = await request(app).get('/api/release-notes/count-unseen').set(authRegular());
    expect(count.body.count).toBe(0);
  });

  it('nota nueva DESPUÉS de mark-seen vuelve a contar', async () => {
    // Nota vieja + mark-seen → count = 0
    await request(app).post('/api/super-admin/release-notes').set(authAdmin())
      .send({ titulo: 'vieja', descripcion: 'x', tipo: 'feature', publicado_en: '2026-01-01T00:00:00Z' });
    await request(app).post('/api/release-notes/mark-seen').set(authRegular());
    const c1 = await request(app).get('/api/release-notes/count-unseen').set(authRegular());
    expect(c1.body.count).toBe(0);

    // Nota nueva (publicado_en futuro respecto a last_seen) → count = 1
    await request(app).post('/api/super-admin/release-notes').set(authAdmin())
      .send({ titulo: 'nueva', descripcion: 'x', tipo: 'fix', publicado_en: '2030-01-01T00:00:00Z' });
    const c2 = await request(app).get('/api/release-notes/count-unseen').set(authRegular());
    expect(c2.body.count).toBe(1);
  });

  it('last_seen es POR-USER — un user ve unseen aunque otro haya marcado', async () => {
    await request(app).post('/api/super-admin/release-notes').set(authAdmin())
      .send({ titulo: 'a', descripcion: 'x', tipo: 'feature' });

    // Super-admin (user 1) marca como visto
    await request(app).post('/api/release-notes/mark-seen').set(authAdmin());

    // El user regular sigue viendo unseen = 1
    const r = await request(app).get('/api/release-notes/count-unseen').set(authRegular());
    expect(r.body.count).toBe(1);
  });
});
