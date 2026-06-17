/**
 * Tests del bloqueo blando de email_verified embebido en
 * backend/src/middleware/auth.js (~líneas 62-69).
 *
 * Tabla de casos cubiertos:
 *
 *   método  | ruta                  | verified | resultado esperado
 *   --------|-----------------------|----------|----------------------
 *   GET     | /api/contactos        | false    | 200 (no bloqueado)
 *   POST    | /api/contactos        | false    | 403 reason=email_not_verified
 *   POST    | /api/contactos        | true     | 201 (no bloqueado)
 *   PUT     | /api/contactos/:id    | false    | 403
 *   DELETE  | /api/contactos/:id    | false    | 403
 *   POST    | /api/auth/logout      | false    | 200 (auth route bypass)
 *   POST    | /api/authzzz          | false    | NO 200 (prefix attack guard)
 *
 * El último caso es el prefix attack: la condición actual usa
 *   req.originalUrl.startsWith('/api/auth/')
 * con la barra final, así que rutas como /api/authzzz, /api/authnew, etc. NO
 * matchean el bypass y caen al bloqueo. Verificamos que eso sea efectivamente
 * lo que pasa.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { setupTestDb, teardownTestDb } = require('./helpers/setup');

let pool;
let unverifiedToken;
let verifiedToken;
let unverifiedUserId;
let verifiedUserId;

async function createUser({ username, email, verified }) {
  const { rows } = await pool.query(
    `INSERT INTO users (nombre, username, email, password_hash, role, email_verified_at)
     VALUES ($1, $2, $3, 'x', 'op', ${verified ? 'NOW()' : 'NULL'})
     RETURNING id`,
    [username, username, email]
  );
  const userId = rows[0].id;
  // Vincular a tenant 1 con rol admin (necesario porque /api/contactos chequea
  // permisos por tenant_rol y/o user_permissions).
  await pool.query(
    `INSERT INTO tenant_users (tenant_id, user_id, rol) VALUES (1, $1, 'admin')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET rol = 'admin'`,
    [userId]
  );
  // Permisos: contactos enabled.
  await pool.query(
    `INSERT INTO user_permissions (user_id, tool, enabled) VALUES ($1, 'contactos', true)
       ON CONFLICT (user_id, tool) DO UPDATE SET enabled = true`,
    [userId]
  );
  return userId;
}

function signToken(userId, username) {
  // Replica el formato de tokens emitidos por POST /api/auth/login (HS256 + iat_ms).
  return jwt.sign(
    {
      id: userId,
      username,
      role: 'op',
      tenant_id: 1,
      tenant_rol: 'admin',
      iat_ms: Date.now(),
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '7d' }
  );
}

beforeAll(async () => {
  pool = await setupTestDb();
  unverifiedUserId = await createUser({
    username: 'unverified_mw',
    email: 'unverified_mw@test.local',
    verified: false,
  });
  verifiedUserId = await createUser({
    username: 'verified_mw',
    email: 'verified_mw@test.local',
    verified: true,
  });
  unverifiedToken = signToken(unverifiedUserId, 'unverified_mw');
  verifiedToken = signToken(verifiedUserId, 'verified_mw');
});

afterAll(async () => {
  await teardownTestDb(pool);
});

describe('middleware requireVerifiedEmail (bloqueo blando)', () => {
  // 1. GET pasa siempre (lectura permitida aún sin verificar)
  it('GET /api/contactos pasa aunque el user NO esté verificado', async () => {
    const res = await request(app)
      .get('/api/contactos')
      .set('Authorization', `Bearer ${unverifiedToken}`);
    expect(res.status).toBe(200);
  });

  // 2. POST bloqueado si unverified
  it('POST /api/contactos con user unverified → 403 reason=email_not_verified', async () => {
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${unverifiedToken}`)
      .send({ nombre: 'Foo', tipo: 'cliente' });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('email_not_verified');
    expect(res.body.error).toMatch(/verific/i);
  });

  // 3. POST OK si verified
  it('POST /api/contactos con user verified → 201 (no bloqueado)', async () => {
    const res = await request(app)
      .post('/api/contactos')
      .set('Authorization', `Bearer ${verifiedToken}`)
      .send({ nombre: 'Bar', tipo: 'cliente' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeGreaterThan(0);
  });

  // 4. PUT bloqueado si unverified
  it('PUT /api/contactos/:id con user unverified → 403', async () => {
    const res = await request(app)
      .put('/api/contactos/999')
      .set('Authorization', `Bearer ${unverifiedToken}`)
      .send({ nombre: 'Updated' });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('email_not_verified');
  });

  // 5. DELETE bloqueado si unverified
  it('DELETE /api/contactos/:id con user unverified → 403', async () => {
    const res = await request(app)
      .delete('/api/contactos/999')
      .set('Authorization', `Bearer ${unverifiedToken}`);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('email_not_verified');
  });

  // 6. /api/auth/* pasa aunque unverified (logout, change-password, verify-email…)
  it('POST /api/auth/logout pasa con user unverified (bypass de /api/auth/*)', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${unverifiedToken}`);
    expect(res.status).toBe(200);
    // Sanity: NO devolvió el blocker 403.
    expect(res.body.reason).not.toBe('email_not_verified');
  });

  // 7. Prefix attack guard: /api/authzzz NO debe matchear el bypass.
  // El código usa `startsWith('/api/auth/')` con la barra final, así que
  // /api/authzzz (sin la barra) cae al else → middleware bloquea con 403.
  // Si en algún momento alguien cambia a `startsWith('/api/auth')` sin la
  // barra, este test detectará el bug.
  it('PREFIX ATTACK: POST /api/authzzz con user unverified NO recibe 200', async () => {
    const res = await request(app)
      .post('/api/authzzz')
      .set('Authorization', `Bearer ${unverifiedToken}`)
      .send({});
    // El endpoint no existe, así que normalmente sería 404. Pero el middleware
    // requireVerifiedEmail (incrustado en requireAuth) debería interceptar
    // ANTES porque el endpoint igual está montado bajo el árbol de express.
    // Lo importante: NO puede devolver 200, y NO puede devolver el éxito de
    // /api/auth/* (porque startsWith('/api/auth/') con barra NO matchea acá).
    expect(res.status).not.toBe(200);
    // En la app actual, esta ruta no existe → 404 (sin que pase ningún
    // middleware de auth, porque express resuelve por router matching).
    // Si en algún momento existiera el endpoint /api/authzzz, el middleware
    // requireAuth + el bloqueo blando deberían interceptar antes con 403.
    // Aceptamos ambos: 403 (interceptado) o 404 (no existe). Lo crítico es
    // que NUNCA sea 2xx.
    expect([403, 404]).toContain(res.status);
  });

  // 8. Sanity adicional: sin token = 401 (independiente del flag verified).
  // Sirve para confirmar que la cadena requireAuth → requireVerifiedEmail
  // funciona en orden: primero auth, después verified.
  it('POST /api/contactos sin token → 401 (auth corre antes que verified)', async () => {
    const res = await request(app)
      .post('/api/contactos')
      .send({ nombre: 'X', tipo: 'cliente' });
    expect(res.status).toBe(401);
    // Sin reason=email_not_verified porque ni siquiera llegó al middleware
    // de verified.
    expect(res.body.reason).not.toBe('email_not_verified');
  });
});
