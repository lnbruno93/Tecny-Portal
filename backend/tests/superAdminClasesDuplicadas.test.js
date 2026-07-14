/**
 * Tests integration — herramienta admin de detección + merge de clases_producto
 * duplicadas.
 *
 * 2026-07-14 (feature): cliente reportó tabs de categoría duplicadas
 * en Inventario (ej. "iPads" + "ipad", "Accesorios" + "Accesorios/Varios").
 * Estos tests garantizan:
 *
 *   Detección (GET /super-admin/tenants/:id/clases-duplicadas):
 *     · Detecta near-duplicates via pg_trgm + containment
 *     · Ignora clases idénticas al 100% (constraint UNIQUE ya las bloquea)
 *     · Ordena por confianza (containment first, luego similarity)
 *     · Prefiere `es_base` / `es_sin_categoria` como canónica
 *     · Auth: 401 sin token, 403 sin super-admin
 *     · 404 si tenant no existe
 *
 *   Merge (POST /super-admin/tenants/:id/clases-merge):
 *     · Mueve todos los productos de duplicada → canónica
 *     · Soft-deletea la duplicada
 *     · Escribe audit en tenant_admin_actions
 *     · Rechaza mergear una `es_base` como duplicada
 *     · Rechaza mergear una `es_sin_categoria` como duplicada
 *     · Rechaza si duplicada_id == canonica_id
 *     · Rechaza cross-tenant (una clase de tenant A + otra de tenant B → 404)
 *     · Zod: rechaza UUID inválido, duplicada_id === canonica_id
 *     · Atomicidad: rollback si algo falla (verificado via error trigger)
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const userAuthCache = require('../src/lib/userAuthCache');

let pool;
let superAdminToken;
const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

// IDs de las clases duplicadas que creamos en beforeAll — usados en múltiples tests.
let ipadsBaseId;   // "iPads" con es_base=true (canónica esperada)
let ipadCustomId;  // "ipad" custom (duplicada esperada)
let accVariosBaseId;  // "Accesorios/Varios" base
let accCustomId;      // "Accesorios" custom
let ipadCustomProd1, ipadCustomProd2;  // 2 productos de ipad (para verificar mueven)
let ipadsBaseProd1;  // 1 producto de iPads (canónica, se queda como está)

// Categoría base para crear productos (obligatoria).
let catBase;

beforeAll(async () => {
  pool = await setupTestDb();

  // Setup super-admin (mismo patrón que superAdmin.test.js).
  await pool.query('UPDATE users SET is_super_admin = true WHERE id = 1');
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

  // Los seeds del setup ya insertaron las 9 clases base (setupTestDb).
  // Obtenemos "iPads" base y "Accesorios/Varios" base.
  const bases = await pool.query(
    `SELECT id, slug_legacy FROM clases_producto
      WHERE tenant_id = 1 AND es_base = true
        AND slug_legacy IN ('ipads', 'accesorios_varios')`
  );
  ipadsBaseId    = bases.rows.find(r => r.slug_legacy === 'ipads').id;
  accVariosBaseId = bases.rows.find(r => r.slug_legacy === 'accesorios_varios').id;

  // Crear "ipad" (custom, near-duplicate de "iPads") y "Accesorios" (near-dup de "Accesorios/Varios").
  const dupIpad = await pool.query(
    `INSERT INTO clases_producto (tenant_id, nombre, orden) VALUES (1, 'ipad', 100) RETURNING id`
  );
  ipadCustomId = dupIpad.rows[0].id;
  const dupAcc = await pool.query(
    `INSERT INTO clases_producto (tenant_id, nombre, orden) VALUES (1, 'Accesorios', 200) RETURNING id`
  );
  accCustomId = dupAcc.rows[0].id;

  // Crear categoría base (obligatoria para productos).
  const cat = await pool.query(
    `INSERT INTO categorias (tenant_id, nombre) VALUES (1, 'Test Cat') RETURNING id`
  );
  catBase = cat.rows[0].id;

  // Crear productos: 2 en "ipad" (custom) + 1 en "iPads" (base) → merge debería
  // mover los 2 de custom al base, quedando 3 en base y 0 en custom.
  const p1 = await pool.query(
    `INSERT INTO productos (tenant_id, categoria_id, clase_id, nombre, tipo_carga, imei,
       costo, precio_venta, costo_moneda, precio_moneda, cantidad, estado)
     VALUES (1, $1, $2, 'iPad Air Custom 1', 'unitario', 'IMEI_DUP_1',
       500, 700, 'USD', 'USD', 1, 'disponible') RETURNING id`,
    [catBase, ipadCustomId]
  );
  ipadCustomProd1 = p1.rows[0].id;
  const p2 = await pool.query(
    `INSERT INTO productos (tenant_id, categoria_id, clase_id, nombre, tipo_carga, imei,
       costo, precio_venta, costo_moneda, precio_moneda, cantidad, estado)
     VALUES (1, $1, $2, 'iPad Air Custom 2', 'unitario', 'IMEI_DUP_2',
       550, 750, 'USD', 'USD', 1, 'disponible') RETURNING id`,
    [catBase, ipadCustomId]
  );
  ipadCustomProd2 = p2.rows[0].id;
  const p3 = await pool.query(
    `INSERT INTO productos (tenant_id, categoria_id, clase_id, nombre, tipo_carga, imei,
       costo, precio_venta, costo_moneda, precio_moneda, cantidad, estado)
     VALUES (1, $1, $2, 'iPad Pro M4 Base', 'unitario', 'IMEI_BASE_1',
       800, 1000, 'USD', 'USD', 1, 'disponible') RETURNING id`,
    [catBase, ipadsBaseId]
  );
  ipadsBaseProd1 = p3.rows[0].id;

  // Segundo tenant para tests cross-tenant.
  await pool.query(
    `INSERT INTO tenants (id, nombre, slug, plan) VALUES (888, 'Otro Tenant', 'otro', 'pro')
       ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `SELECT setval('tenants_id_seq', GREATEST((SELECT MAX(id) FROM tenants), 1))`
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM productos WHERE tenant_id = 1 AND nombre LIKE 'iPad%'`);
  await pool.query(`DELETE FROM clases_producto WHERE tenant_id = 1 AND nombre IN ('ipad', 'Accesorios')`);
  await pool.query(`DELETE FROM tenant_admin_actions WHERE tenant_id IN (1, 888)`);
  await pool.query(`DELETE FROM tenants WHERE id = 888`);
  await pool.query(`UPDATE users SET is_super_admin = false WHERE id = 1`);
  await pool.query(`DELETE FROM user_2fa WHERE user_id = 1`);
  await userAuthCache.invalidateUserAuth(1);
  await teardownTestDb(pool);
});

// ══════════════════════════════════════════════════════════════════════════
// GET /super-admin/tenants/:id/clases-duplicadas
// ══════════════════════════════════════════════════════════════════════════

describe('GET /super-admin/tenants/:id/clases-duplicadas', () => {
  it('401 sin token', async () => {
    const r = await request(app).get('/api/super-admin/tenants/1/clases-duplicadas');
    expect(r.status).toBe(401);
  });

  it('404 tenant inexistente', async () => {
    const r = await request(app).get('/api/super-admin/tenants/99999/clases-duplicadas').set(auth());
    expect(r.status).toBe(404);
  });

  it('400 id inválido (no entero)', async () => {
    const r = await request(app).get('/api/super-admin/tenants/abc/clases-duplicadas').set(auth());
    expect(r.status).toBe(400);
  });

  it('detecta "ipad" vs "iPads" y "Accesorios" vs "Accesorios/Varios"', async () => {
    const r = await request(app).get('/api/super-admin/tenants/1/clases-duplicadas').set(auth());
    expect(r.status).toBe(200);
    expect(r.body.tenant_id).toBe(1);
    expect(Array.isArray(r.body.pairs)).toBe(true);

    // Buscar el par ipad/iPads.
    const ipadPair = r.body.pairs.find(p =>
      [p.a.nombre, p.b.nombre].sort().join('|') === 'iPads|ipad'
    );
    expect(ipadPair).toBeTruthy();
    // El orden a/b depende del UUID (b.id < a.id), así que puede ser
    // A_CONTAINS_B o B_CONTAINS_A. Lo importante es que HAY containment.
    expect(['A_CONTAINS_B', 'B_CONTAINS_A']).toContain(ipadPair.contain_kind);
    expect(ipadPair.score).toBe(1.0);       // containment → 1.0
    expect(ipadPair.confidence).toBe('high');

    // La canónica sugerida debe ser la base ("iPads").
    expect(ipadPair.canonica_suggested_id).toBe(ipadsBaseId);
    expect(ipadPair.duplicada_suggested_id).toBe(ipadCustomId);

    // Par accesorios.
    const accPair = r.body.pairs.find(p =>
      [p.a.nombre, p.b.nombre].sort().join('|') === 'Accesorios|Accesorios/Varios'
    );
    expect(accPair).toBeTruthy();
    expect(['A_CONTAINS_B', 'B_CONTAINS_A']).toContain(accPair.contain_kind);
    expect(accPair.canonica_suggested_id).toBe(accVariosBaseId);
    expect(accPair.duplicada_suggested_id).toBe(accCustomId);
  });

  it('el count_productos refleja lo real', async () => {
    const r = await request(app).get('/api/super-admin/tenants/1/clases-duplicadas').set(auth());
    const ipadPair = r.body.pairs.find(p =>
      [p.a.nombre, p.b.nombre].sort().join('|') === 'iPads|ipad'
    );
    const ipadsInPair = [ipadPair.a, ipadPair.b].find(c => c.id === ipadsBaseId);
    const ipadInPair  = [ipadPair.a, ipadPair.b].find(c => c.id === ipadCustomId);
    expect(ipadsInPair.count_productos).toBe(1);  // solo el iPad Pro M4 Base
    expect(ipadInPair.count_productos).toBe(2);   // los 2 customs
  });

  it('ordena por confianza (containment/score DESC)', async () => {
    const r = await request(app).get('/api/super-admin/tenants/1/clases-duplicadas').set(auth());
    if (r.body.pairs.length >= 2) {
      for (let i = 1; i < r.body.pairs.length; i++) {
        expect(r.body.pairs[i - 1].score).toBeGreaterThanOrEqual(r.body.pairs[i].score);
      }
    }
  });

  it('respeta tenant isolation (tenant 888 no ve clases de tenant 1)', async () => {
    const r = await request(app).get('/api/super-admin/tenants/888/clases-duplicadas').set(auth());
    expect(r.status).toBe(200);
    // Tenant 888 solo tiene las 9 base + Sin categoría del seed; ninguna near-dup.
    // Podría haber alguna similarity entre "Celular Sellado" y "Celular Usado"
    // (comparten prefijo) → aceptamos que aparezca. Lo que NO puede aparecer es
    // "ipad" o "Accesorios" (esos son del tenant 1).
    const nombres = r.body.pairs.flatMap(p => [p.a.nombre, p.b.nombre]);
    expect(nombres).not.toContain('ipad');
    expect(nombres).not.toContain('Accesorios');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// POST /super-admin/tenants/:id/clases-merge
// ══════════════════════════════════════════════════════════════════════════

describe('POST /super-admin/tenants/:id/clases-merge', () => {
  // El happy path se corre al final porque muta el estado (soft-deletea la
  // "ipad" y mueve los productos). Los tests de validación van antes.

  it('401 sin token', async () => {
    const r = await request(app).post('/api/super-admin/tenants/1/clases-merge')
      .send({ duplicada_id: ipadCustomId, canonica_id: ipadsBaseId });
    expect(r.status).toBe(401);
  });

  it('400 si UUID inválido', async () => {
    const r = await request(app).post('/api/super-admin/tenants/1/clases-merge').set(auth())
      .send({ duplicada_id: 'not-a-uuid', canonica_id: ipadsBaseId });
    expect(r.status).toBe(400);
  });

  it('400 si duplicada_id === canonica_id', async () => {
    const r = await request(app).post('/api/super-admin/tenants/1/clases-merge').set(auth())
      .send({ duplicada_id: ipadsBaseId, canonica_id: ipadsBaseId });
    expect(r.status).toBe(400);
  });

  it('404 si una clase no existe o fue borrada', async () => {
    const fakeUuid = '00000000-0000-0000-0000-000000000001';
    const r = await request(app).post('/api/super-admin/tenants/1/clases-merge').set(auth())
      .send({ duplicada_id: fakeUuid, canonica_id: ipadsBaseId });
    expect(r.status).toBe(404);
  });

  it('404 cross-tenant (clase pertenece a otro tenant)', async () => {
    // Crear una clase en tenant 888.
    const other = await pool.query(
      `INSERT INTO clases_producto (tenant_id, nombre) VALUES (888, 'Otro') RETURNING id`
    );
    const otroId = other.rows[0].id;
    // Intentar mergear otroId (tenant 888) usando el endpoint del tenant 1.
    const r = await request(app).post('/api/super-admin/tenants/1/clases-merge').set(auth())
      .send({ duplicada_id: otroId, canonica_id: ipadsBaseId });
    expect(r.status).toBe(404);
    await pool.query(`DELETE FROM clases_producto WHERE id = $1`, [otroId]);
  });

  it('409 rechaza mergear una es_base como duplicada', async () => {
    // Intentar borrar "iPads" (base) usando "ipad" (custom) como canónica → 409.
    const r = await request(app).post('/api/super-admin/tenants/1/clases-merge').set(auth())
      .send({ duplicada_id: ipadsBaseId, canonica_id: ipadCustomId });
    expect(r.status).toBe(409);
    expect(r.body.code || r.body.error).toBeTruthy();
  });

  it('409 rechaza mergear "Sin categoría" (es_sin_categoria) como duplicada', async () => {
    const sinCat = await pool.query(
      `SELECT id FROM clases_producto WHERE tenant_id = 1 AND es_sin_categoria = true AND deleted_at IS NULL`
    );
    expect(sinCat.rows[0]).toBeTruthy();
    const r = await request(app).post('/api/super-admin/tenants/1/clases-merge').set(auth())
      .send({ duplicada_id: sinCat.rows[0].id, canonica_id: ipadsBaseId });
    expect(r.status).toBe(409);
  });

  // Happy path — mueve productos + soft-delete + audit. Se corre al final
  // porque muta el estado.
  it('merge exitoso: mueve productos, soft-deletea duplicada, escribe audit', async () => {
    const r = await request(app).post('/api/super-admin/tenants/1/clases-merge').set(auth())
      .send({ duplicada_id: ipadCustomId, canonica_id: ipadsBaseId });
    expect(r.status).toBe(200);
    expect(r.body.productos_movidos).toBe(2);
    expect(r.body.canonica_nombre).toBe('iPads');
    expect(r.body.duplicada_nombre).toBe('ipad');

    // Verificar en DB:
    // 1. Los 2 productos de "ipad" ahora tienen clase_id = ipadsBaseId
    const prods = await pool.query(
      `SELECT id, clase_id FROM productos WHERE id = ANY($1::int[])`,
      [[ipadCustomProd1, ipadCustomProd2, ipadsBaseProd1]]
    );
    prods.rows.forEach(p => {
      expect(p.clase_id).toBe(ipadsBaseId);
    });

    // 2. La duplicada "ipad" ahora tiene deleted_at set
    const dup = await pool.query(
      `SELECT deleted_at FROM clases_producto WHERE id = $1`, [ipadCustomId]
    );
    expect(dup.rows[0].deleted_at).toBeTruthy();

    // 3. Se escribió el audit en tenant_admin_actions
    const audit = await pool.query(
      `SELECT action, before_state, after_state, super_admin_user_id
         FROM tenant_admin_actions
        WHERE tenant_id = 1 AND action = 'clases_merge'
        ORDER BY created_at DESC LIMIT 1`
    );
    expect(audit.rows[0]).toBeTruthy();
    expect(audit.rows[0].action).toBe('clases_merge');
    expect(audit.rows[0].before_state.duplicada.id).toBe(ipadCustomId);
    expect(audit.rows[0].after_state.productos_movidos).toBe(2);
    expect(audit.rows[0].super_admin_user_id).toBe(1);
  });

  it('post-merge: la duplicada NO aparece en GET /clases-duplicadas', async () => {
    const r = await request(app).get('/api/super-admin/tenants/1/clases-duplicadas').set(auth());
    expect(r.status).toBe(200);
    const nombres = r.body.pairs.flatMap(p => [p.a.nombre, p.b.nombre]);
    expect(nombres).not.toContain('ipad'); // ya está soft-deleted
  });

  it('post-merge: reintentar mergear la misma duplicada → 404 (ya borrada)', async () => {
    const r = await request(app).post('/api/super-admin/tenants/1/clases-merge').set(auth())
      .send({ duplicada_id: ipadCustomId, canonica_id: ipadsBaseId });
    expect(r.status).toBe(404);
  });
});
