/**
 * Tests de integración — caps dedicadas del share link (task #229, 2026-08-02).
 *
 * Cubre el gate condicional del PATCH `/api/inventario/share-link`:
 * el middleware exige `inventario.editar` para cualquier mutación, y
 * ADEMÁS `inventario.share_link_desactivar` cuando el body pide
 * `activo: false`. Con esta split, un user con edit acceso puede
 * cambiar whatsapp/mensaje/toggles/reactivar pero NO puede tumbar
 * el link — la acción destructiva queda gated por separado.
 *
 * El rotate lo cubre capabilityGates.test.js (gate a nivel middleware,
 * un solo caso). Aquí probamos las 4 combinaciones del PATCH:
 *   1. Con `inventario.editar` + cambio reversible (whatsapp)       → 200
 *   2. Con `inventario.editar` + `activo: true` (reactivar)         → 200
 *   3. Con `inventario.editar` sin `share_link_desactivar` + activo:false → 403
 *   4. Con `inventario.editar` + `share_link_desactivar` + activo:false → 200
 *
 * Y el edge case:
 *   5. Owner del tenant (bypass) + activo:false → 200 sin necesidad de la cap
 */

const request = require('supertest');
const app     = require('../src/app');
const { setupTestDb, teardownTestDb, createTestUser } = require('./helpers/setup');

let pool;

// Helper: crea user con caps custom explícitas via user_capabilities.
// La tabla tiene `enabled BOOLEAN NOT NULL` — sin default, hay que setearlo
// explícito en el INSERT.
async function grantCaps(userId, caps) {
  for (const cap of caps) {
    await pool.query(
      `INSERT INTO user_capabilities (user_id, capability_slug, tenant_id, enabled)
       VALUES ($1, $2, 1, true)
       ON CONFLICT (tenant_id, user_id, capability_slug) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [userId, cap]
    );
  }
}

// Helper: login del user y devuelve JWT.
async function loginAs(username, password) {
  const r = await request(app).post('/api/auth/login').send({ username, password });
  if (r.status !== 200) {
    throw new Error(`Login falló para ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.token;
}

let editorSinDesactivarToken; // user con inventario.editar pero SIN share_link_desactivar
let editorConDesactivarToken; // user con AMBAS caps
let ownerToken;               // owner del tenant (bypass)

beforeAll(async () => {
  pool = await setupTestDb();

  // Aseguramos share_link limpio para que el test arranque en estado
  // conocido (activo: true, es lo que devuelve getOrCreateShareLink por
  // default al primer GET).
  await pool.query('DELETE FROM share_links WHERE 1=1');

  // ── User 1: editor sin desactivar ──
  const u1 = await createTestUser(pool, {
    nombre:    'Editor Sin Desactivar',
    username:  'editor_no_desact',
    email:     'editor_no_desact@test.local',
    password:  'test_editor_pass_123',
    role:      'op',
    tenantRol: 'member',
    capRol:    'custom',
  });
  // Necesita `inventario.ver` para GET /share-link (usado por los asserts
  // "verificar que el link no cambió") + `inventario.editar` para el PATCH.
  await grantCaps(u1.id, ['inventario.ver', 'inventario.editar']);
  editorSinDesactivarToken = await loginAs('editor_no_desact', 'test_editor_pass_123');

  // ── User 2: editor CON desactivar ──
  const u2 = await createTestUser(pool, {
    nombre:    'Editor Con Desactivar',
    username:  'editor_desact',
    email:     'editor_desact@test.local',
    password:  'test_editor_pass_123',
    role:      'op',
    tenantRol: 'member',
    capRol:    'custom',
  });
  await grantCaps(u2.id, ['inventario.ver', 'inventario.editar', 'inventario.share_link_desactivar']);
  editorConDesactivarToken = await loginAs('editor_desact', 'test_editor_pass_123');

  // ── User 3: owner del tenant (bypass) ──
  // Owner NO necesita capabilities explícitas — el JWT lleva
  // tenant_cap_rol='owner' y el middleware bypassea todos los checks.
  const u3 = await createTestUser(pool, {
    nombre:    'Owner Test',
    username:  'owner_test_sharelink',
    email:     'owner_sl@test.local',
    password:  'test_owner_pass_123',
    role:      'op',
    tenantRol: 'owner',
    capRol:    'owner',
  });
  ownerToken = await loginAs('owner_test_sharelink', 'test_owner_pass_123');
});

afterAll(async () => {
  await teardownTestDb(pool);
});

const authHdr = (t) => ({ Authorization: `Bearer ${t}` });

describe('PATCH /api/inventario/share-link — gate condicional share_link_desactivar', () => {
  it('1. user con inventario.editar puede cambiar whatsapp (campo reversible)', async () => {
    const r = await request(app)
      .patch('/api/inventario/share-link')
      .set(authHdr(editorSinDesactivarToken))
      .send({ whatsapp: '+54 9 11 5555-5555' });
    expect(r.status).toBe(200);
    expect(r.body.whatsapp).toBe('+54 9 11 5555-5555');
    expect(r.body.activo).toBe(true); // sin cambios
  });

  it('2. user con inventario.editar puede reactivar (activo: true)', async () => {
    // Setup: primero lo desactivamos como owner para tener algo que reactivar.
    await request(app).patch('/api/inventario/share-link')
      .set(authHdr(ownerToken))
      .send({ activo: false });

    // Ahora el editor reactiva — no exige share_link_desactivar.
    const r = await request(app)
      .patch('/api/inventario/share-link')
      .set(authHdr(editorSinDesactivarToken))
      .send({ activo: true });
    expect(r.status).toBe(200);
    expect(r.body.activo).toBe(true);
  });

  it('3. user con inventario.editar pero SIN share_link_desactivar recibe 403 al desactivar', async () => {
    const r = await request(app)
      .patch('/api/inventario/share-link')
      .set(authHdr(editorSinDesactivarToken))
      .send({ activo: false });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/permiso.*desactivar/i);

    // El link debe seguir activo — el update no debe haberse ejecutado.
    const check = await request(app)
      .get('/api/inventario/share-link')
      .set(authHdr(editorSinDesactivarToken));
    expect(check.body.activo).toBe(true);
  });

  it('4. user con AMBAS caps puede desactivar', async () => {
    const r = await request(app)
      .patch('/api/inventario/share-link')
      .set(authHdr(editorConDesactivarToken))
      .send({ activo: false });
    expect(r.status).toBe(200);
    expect(r.body.activo).toBe(false);

    // Cleanup — reactivar para no dejar side effect a tests posteriores.
    await request(app).patch('/api/inventario/share-link')
      .set(authHdr(ownerToken))
      .send({ activo: true });
  });

  it('5. owner del tenant puede desactivar sin cap explícita (bypass)', async () => {
    const r = await request(app)
      .patch('/api/inventario/share-link')
      .set(authHdr(ownerToken))
      .send({ activo: false });
    expect(r.status).toBe(200);
    expect(r.body.activo).toBe(false);

    // Cleanup.
    await request(app).patch('/api/inventario/share-link')
      .set(authHdr(ownerToken))
      .send({ activo: true });
  });
});

describe('POST /api/inventario/share-link/rotate — gate share_link_rotate', () => {
  it('user con inventario.editar pero SIN share_link_rotate recibe 403 al rotar', async () => {
    const r = await request(app)
      .post('/api/inventario/share-link/rotate')
      .set(authHdr(editorSinDesactivarToken));
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/permiso/i);
  });

  it('owner del tenant puede rotar sin cap explícita (bypass)', async () => {
    // Snapshot token actual.
    const before = await request(app).get('/api/inventario/share-link').set(authHdr(ownerToken));
    const tokenAntes = before.body.token;

    const r = await request(app)
      .post('/api/inventario/share-link/rotate')
      .set(authHdr(ownerToken));
    expect(r.status).toBe(200);
    expect(r.body.token).not.toBe(tokenAntes);
    expect(r.body.rotated_at).toBeTruthy();
  });
});
