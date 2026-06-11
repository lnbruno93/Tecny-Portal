/**
 * Tests del sistema de feature flags (M-08 GRAN auditoría 2026-06-10).
 *
 * Cubre:
 *  - GET /api/feature-flags devuelve { flags: { name: bool, ... } }.
 *  - GET /api/feature-flags/admin requiere admin (403 si no).
 *  - POST/PATCH/DELETE solo para admin.
 *  - Naming convention: regex /^[a-z][a-z0-9_]*$/, max 64 chars.
 *  - 404 al actualizar/borrar un flag inexistente.
 *  - 409 al crear un duplicado.
 *  - Strict mode rechaza claves extra (defensa prototype pollution).
 *  - Audit log persistido tras create/update/delete.
 */
const request = require('supertest');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const bcrypt = require('bcrypt');

let pool;
let adminToken;
let userToken;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  pool = await setupTestDb();
  // El TEST_USER del setup es admin. Logueamos para obtener su token.
  const r = await request(app).post('/api/auth/login')
    .send({ username: TEST_USER.username, password: TEST_USER.password });
  adminToken = r.body.token;

  // Creamos un user NO admin para probar los 403 admin-only. Los roles
  // válidos en el schema son 'admin' y 'op' — usamos 'op'.
  const hash = await bcrypt.hash('userpass123', 10);
  await pool.query(
    `INSERT INTO users (nombre, username, password_hash, role)
     VALUES ('Test User', 'testuser', $1, 'op')`,
    [hash]
  );
  const r2 = await request(app).post('/api/auth/login')
    .send({ username: 'testuser', password: 'userpass123' });
  userToken = r2.body.token;
});

afterAll(async () => {
  // Cleanup feature_flags creados durante los tests para no contaminar runs
  // sucesivos (el setupTestDb no trunca esta tabla porque se introdujo después).
  try {
    await pool.query("DELETE FROM feature_flags WHERE name <> 'demo_flag'");
  } catch { /* tabla puede no existir si la migración falló */ }
  await teardownTestDb(pool);
});

describe('GET /api/feature-flags (público con sesión)', () => {
  it('devuelve { flags: {...} } con el demo_flag del seed', async () => {
    const res = await request(app).get('/api/feature-flags').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('flags');
    expect(typeof res.body.flags).toBe('object');
    // El seed inicial tiene `demo_flag: false`.
    expect(res.body.flags).toHaveProperty('demo_flag', false);
  });

  it('accesible a un user no-admin (solo requiere sesión)', async () => {
    const res = await request(app).get('/api/feature-flags').set(auth(userToken));
    expect(res.status).toBe(200);
    expect(res.body.flags).toBeDefined();
  });

  it('sin auth → 401', async () => {
    const res = await request(app).get('/api/feature-flags');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/feature-flags/admin', () => {
  it('admin: devuelve array completo con metadata, ordenado por name', async () => {
    const res = await request(app).get('/api/feature-flags/admin').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const demo = res.body.find(f => f.name === 'demo_flag');
    expect(demo).toBeTruthy();
    expect(demo).toHaveProperty('enabled', false);
    expect(demo).toHaveProperty('description');
    expect(demo).toHaveProperty('created_at');
    expect(demo).toHaveProperty('updated_at');
  });

  it('user no-admin → 403 con mensaje claro', async () => {
    const res = await request(app).get('/api/feature-flags/admin').set(auth(userToken));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });
});

describe('POST /api/feature-flags (admin)', () => {
  it('crea un flag válido y devuelve 201 + row', async () => {
    const res = await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'new_checkout_flow', enabled: true, description: 'Habilita el flujo nuevo' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'new_checkout_flow',
      enabled: true,
      description: 'Habilita el flujo nuevo',
    });
    expect(res.body.created_at).toBeDefined();
  });

  it('default enabled=false si no se manda', async () => {
    const res = await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'flag_sin_enabled' });
    expect(res.status).toBe(201);
    expect(res.body.enabled).toBe(false);
  });

  it('user no-admin → 403', async () => {
    const res = await request(app).post('/api/feature-flags').set(auth(userToken))
      .send({ name: 'should_not_create' });
    expect(res.status).toBe(403);
  });

  it('rechaza naming inválido (mayúsculas)', async () => {
    const res = await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'BadName' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Datos inválidos/i);
  });

  it('rechaza naming inválido (guion medio)', async () => {
    const res = await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'bad-name' });
    expect(res.status).toBe(400);
  });

  it('rechaza naming inválido (empieza con número)', async () => {
    const res = await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: '1_bad' });
    expect(res.status).toBe(400);
  });

  it('rechaza name > 64 chars', async () => {
    const res = await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'a'.repeat(65) });
    expect(res.status).toBe(400);
  });

  it('rechaza description > 500 chars', async () => {
    const res = await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'flag_desc_too_long', description: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });

  it('rechaza claves extra (.strict() defensa prototype pollution)', async () => {
    const res = await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'flag_clave_extra', enabled: false, evil_key: 'x' });
    expect(res.status).toBe(400);
  });

  it('duplicado → 409 con mensaje específico', async () => {
    await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'dup_flag' });
    const res = await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'dup_flag' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ya existe/i);
  });
});

describe('PATCH /api/feature-flags/:name (admin)', () => {
  beforeAll(async () => {
    // Seed un flag para los tests de update
    await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'patch_target', enabled: false, description: 'inicial' });
  });

  it('actualiza enabled', async () => {
    const res = await request(app).patch('/api/feature-flags/patch_target').set(auth(adminToken))
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.description).toBe('inicial'); // preservado
  });

  it('actualiza description', async () => {
    const res = await request(app).patch('/api/feature-flags/patch_target').set(auth(adminToken))
      .send({ description: 'actualizada' });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('actualizada');
  });

  it('actualiza ambos', async () => {
    const res = await request(app).patch('/api/feature-flags/patch_target').set(auth(adminToken))
      .send({ enabled: false, description: 'final' });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.description).toBe('final');
  });

  it('body vacío → 400 (refine: al menos uno)', async () => {
    const res = await request(app).patch('/api/feature-flags/patch_target').set(auth(adminToken))
      .send({});
    expect(res.status).toBe(400);
  });

  it('flag inexistente → 404', async () => {
    const res = await request(app).patch('/api/feature-flags/no_existe_jamas').set(auth(adminToken))
      .send({ enabled: true });
    expect(res.status).toBe(404);
  });

  it('user no-admin → 403', async () => {
    const res = await request(app).patch('/api/feature-flags/patch_target').set(auth(userToken))
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });

  it('name del path inválido → 400', async () => {
    // Caracteres prohibidos en el path — el guard del NAME_REGEX rebota antes
    // de hacer la query a la DB.
    const res = await request(app).patch('/api/feature-flags/Bad-Name').set(auth(adminToken))
      .send({ enabled: true });
    expect(res.status).toBe(400);
  });

  it('rechaza claves extra en el body (.strict())', async () => {
    const res = await request(app).patch('/api/feature-flags/patch_target').set(auth(adminToken))
      .send({ enabled: true, evil_key: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/feature-flags/:name (admin)', () => {
  it('borra hard y devuelve 204', async () => {
    await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'to_delete' });
    const res = await request(app).delete('/api/feature-flags/to_delete').set(auth(adminToken));
    expect(res.status).toBe(204);

    // Confirma que ya no aparece en el listado admin.
    const list = await request(app).get('/api/feature-flags/admin').set(auth(adminToken));
    expect(list.body.find(f => f.name === 'to_delete')).toBeUndefined();
  });

  it('inexistente → 404', async () => {
    const res = await request(app).delete('/api/feature-flags/never_existed').set(auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('user no-admin → 403', async () => {
    await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'protected_flag' });
    const res = await request(app).delete('/api/feature-flags/protected_flag').set(auth(userToken));
    expect(res.status).toBe(403);
  });
});

describe('Audit trail', () => {
  it('create + update + delete dejan filas en audit_logs', async () => {
    const name = 'audit_target';
    await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name, enabled: false });
    await request(app).patch(`/api/feature-flags/${name}`).set(auth(adminToken))
      .send({ enabled: true });
    await request(app).delete(`/api/feature-flags/${name}`).set(auth(adminToken));

    const { rows } = await pool.query(
      `SELECT accion FROM audit_logs WHERE tabla = 'feature_flags'
         AND (datos_antes->>'name' = $1 OR datos_despues->>'name' = $1)
        ORDER BY id`,
      [name]
    );
    const acciones = rows.map(r => r.accion);
    expect(acciones).toContain('INSERT');
    expect(acciones).toContain('UPDATE');
    expect(acciones).toContain('DELETE');
  });
});

describe('Consistencia entre GET / y GET /admin', () => {
  it('después de PATCH enabled=true, GET / refleja el cambio', async () => {
    // El cache está desactivado en NODE_ENV=test (ver lib/cacheTtl.js), así
    // que la próxima GET es consistente con el último write. Verificamos
    // que efectivamente sea así.
    await request(app).post('/api/feature-flags').set(auth(adminToken))
      .send({ name: 'cache_consistency' });
    await request(app).patch('/api/feature-flags/cache_consistency').set(auth(adminToken))
      .send({ enabled: true });

    const res = await request(app).get('/api/feature-flags').set(auth(adminToken));
    expect(res.body.flags.cache_consistency).toBe(true);
  });
});
