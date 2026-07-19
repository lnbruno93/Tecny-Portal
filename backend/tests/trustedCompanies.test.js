/**
 * Tests integration para CMS Landing Fase 4 — "Empresas que confiaron en Tecny".
 *
 * 2026-07-18 (feature).
 *
 * Cubre:
 *   · GET /api/public/trusted-companies sin auth → 200 con array.
 *   · GET /api/public/trusted-companies/:id/logo sirve el blob con Cache-Control 24h.
 *   · POST /api/super-admin/trusted-companies requiere super-admin.
 *   · POST valida shape (nombre, logo_mime, tamaño de logo_data).
 *   · POST rechaza nombre duplicado (409), MIME no soportado (400),
 *     logo pesado (400), límite 40 empresas (422).
 *   · PATCH nombre + position.
 *   · DELETE soft-borra + no aparece en GET público.
 *
 * Storage: los tests corren con STORAGE_DRIVER=db (default), así que fileStore
 * guarda base64 directo en la columna logo_data. No mockeamos R2 (no aplica).
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const userAuthCache = require('../src/lib/userAuthCache');

let pool, superAdminToken;
const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

// 1x1 PNG negro (67 bytes decoded) — el body base64 más pequeño que califica
// como PNG válido. Suficiente para tests: schema exige mime image/*, pero no
// valida contenido real del binario.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAApJREFUCNdjYAAAAAIAAeIhvDMAAAAASUVORK5CYII=';

beforeAll(async () => {
  pool = await setupTestDb();
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
});

afterAll(async () => { await teardownTestDb(pool); });

// Cleanup entre suites: la tabla es global (no per-tenant), fácil resetear.
beforeEach(async () => {
  await pool.query('DELETE FROM site_landing_companies');
});

describe('GET /api/public/trusted-companies', () => {
  it('devuelve 200 sin auth (público)', async () => {
    const r = await request(app).get('/api/public/trusted-companies');
    expect(r.status).toBe(200);
  });

  it('shape { companies: [] } — safe fallback si tabla vacía', async () => {
    const r = await request(app).get('/api/public/trusted-companies');
    expect(r.body).toEqual({ companies: [] });
  });

  it('Cache-Control: public, max-age=300', async () => {
    const r = await request(app).get('/api/public/trusted-companies');
    expect(r.headers['cache-control']).toMatch(/public.*max-age=300/);
  });

  it('lista solo empresas activas (deleted_at IS NULL), ordenadas por position', async () => {
    // Seed directo: 3 empresas — 1 con deleted_at, 2 activas con posiciones invertidas.
    await pool.query(`
      INSERT INTO site_landing_companies (nombre, logo_data, logo_tipo, position, deleted_at)
      VALUES
        ('Zeta', 'x', 'image/png', 0, NULL),
        ('Alpha', 'x', 'image/png', 1, NULL),
        ('Borrada', 'x', 'image/png', 2, NOW())
    `);
    const r = await request(app).get('/api/public/trusted-companies');
    expect(r.body.companies).toHaveLength(2);
    expect(r.body.companies.map(c => c.nombre)).toEqual(['Zeta', 'Alpha']);
  });
});

describe('POST /api/super-admin/trusted-companies', () => {
  it('401 sin token', async () => {
    const r = await request(app).post('/api/super-admin/trusted-companies').send({
      nombre: 'ACME', logo_data: PNG_1x1, logo_mime: 'image/png',
    });
    expect(r.status).toBe(401);
  });

  it('201 con nombre + logo_data + logo_mime válidos', async () => {
    const r = await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'ACME Corp',
      logo_data: PNG_1x1,
      logo_mime: 'image/png',
      logo_nombre: 'acme.png',
    });
    expect(r.status).toBe(201);
    expect(r.body).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}/i),
      nombre: 'ACME Corp',
      logo_nombre: 'acme.png',
      logo_tipo: 'image/png',
      position: 0,
    }));
  });

  it('position auto-incrementa (MAX + 1)', async () => {
    await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'Primera', logo_data: PNG_1x1, logo_mime: 'image/png',
    });
    const r = await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'Segunda', logo_data: PNG_1x1, logo_mime: 'image/png',
    });
    expect(r.body.position).toBe(1);
  });

  it('400 con nombre vacío', async () => {
    const r = await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: '', logo_data: PNG_1x1, logo_mime: 'image/png',
    });
    expect(r.status).toBe(400);
  });

  it('400 con MIME no soportado', async () => {
    const r = await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'ACME', logo_data: PNG_1x1, logo_mime: 'application/pdf',
    });
    expect(r.status).toBe(400);
  });

  it('rechaza logo_data muy pesado (>5.6MB base64) — 400 del schema o 413 del bodyparser', async () => {
    // 6MB base64 sobre el cap de 5.6M en el schema Zod. Puede rebotar antes
    // en el bodyParser de Express (413 Payload Too Large) si el JSON completo
    // supera el limit del app.json({limit: ...}). Ambos códigos son válidos:
    // el request queda rechazado y nunca se persiste — la defensa está.
    const bigBase64 = 'a'.repeat(6_000_000);
    const r = await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'ACME', logo_data: bigBase64, logo_mime: 'image/png',
    });
    expect([400, 413]).toContain(r.status);
  });

  it('409 con nombre duplicado (case-insensitive)', async () => {
    await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'ACME', logo_data: PNG_1x1, logo_mime: 'image/png',
    });
    const r = await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'acme', logo_data: PNG_1x1, logo_mime: 'image/png',
    });
    expect(r.status).toBe(409);
  });

  it('422 cuando se alcanza el límite de 40 empresas', async () => {
    // Seed directo 40 empresas para no gastar el TTL del test.
    const values = Array.from({ length: 40 }, (_, i) =>
      `('E${i}', 'x', 'image/png', ${i})`
    ).join(', ');
    await pool.query(
      `INSERT INTO site_landing_companies (nombre, logo_data, logo_tipo, position) VALUES ${values}`
    );

    const r = await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'La 41', logo_data: PNG_1x1, logo_mime: 'image/png',
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/L[íi]mite de 40/i);
  });

  it('acepta image/svg+xml (SVG)', async () => {
    // SVG mínimo válido base64.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    const r = await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'SVG Co', logo_data: svg, logo_mime: 'image/svg+xml',
    });
    expect(r.status).toBe(201);
    expect(r.body.logo_tipo).toBe('image/svg+xml');
  });
});

describe('PATCH /api/super-admin/trusted-companies/:id', () => {
  async function seedOne(nombre = 'Original') {
    const r = await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre, logo_data: PNG_1x1, logo_mime: 'image/png',
    });
    return r.body;
  }

  it('cambia nombre', async () => {
    const created = await seedOne();
    const r = await request(app).patch(`/api/super-admin/trusted-companies/${created.id}`).set(auth())
      .send({ nombre: 'Renombrada' });
    expect(r.status).toBe(200);
    expect(r.body.nombre).toBe('Renombrada');
  });

  it('cambia position (para reorder)', async () => {
    const created = await seedOne();
    const r = await request(app).patch(`/api/super-admin/trusted-companies/${created.id}`).set(auth())
      .send({ position: 5 });
    expect(r.status).toBe(200);
    expect(r.body.position).toBe(5);
  });

  it('400 con body {} (al menos un campo requerido)', async () => {
    const created = await seedOne();
    const r = await request(app).patch(`/api/super-admin/trusted-companies/${created.id}`).set(auth())
      .send({});
    expect(r.status).toBe(400);
  });

  it('400 con id inválido (no-UUID)', async () => {
    const r = await request(app).patch('/api/super-admin/trusted-companies/not-a-uuid').set(auth())
      .send({ nombre: 'X' });
    expect(r.status).toBe(400);
  });

  it('404 con id inexistente', async () => {
    const r = await request(app).patch('/api/super-admin/trusted-companies/00000000-0000-0000-0000-000000000000').set(auth())
      .send({ nombre: 'X' });
    expect(r.status).toBe(404);
  });

  it('409 al renombrar a un nombre ya en uso', async () => {
    const a = await seedOne('AA');
    await seedOne('BB');
    const r = await request(app).patch(`/api/super-admin/trusted-companies/${a.id}`).set(auth())
      .send({ nombre: 'BB' });
    expect(r.status).toBe(409);
  });
});

describe('DELETE /api/super-admin/trusted-companies/:id', () => {
  it('soft-borra y no aparece en GET público', async () => {
    const created = (await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'Delete me', logo_data: PNG_1x1, logo_mime: 'image/png',
    })).body;

    const del = await request(app).delete(`/api/super-admin/trusted-companies/${created.id}`).set(auth());
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const pub = await request(app).get('/api/public/trusted-companies');
    expect(pub.body.companies).toHaveLength(0);

    // La row sigue con deleted_at seteado.
    const { rows } = await pool.query(
      'SELECT deleted_at FROM site_landing_companies WHERE id = $1', [created.id]
    );
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('404 si id inexistente', async () => {
    const r = await request(app).delete('/api/super-admin/trusted-companies/00000000-0000-0000-0000-000000000000').set(auth());
    expect(r.status).toBe(404);
  });

  it('400 si id inválido', async () => {
    const r = await request(app).delete('/api/super-admin/trusted-companies/not-uuid').set(auth());
    expect(r.status).toBe(400);
  });
});

describe('GET /api/public/trusted-companies/:id/logo', () => {
  it('sirve el blob PNG con Cache-Control 24h', async () => {
    const created = (await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'LogoCo', logo_data: PNG_1x1, logo_mime: 'image/png',
    })).body;

    const expectedSize = Buffer.from(PNG_1x1, 'base64').length;

    const r = await request(app).get(`/api/public/trusted-companies/${created.id}/logo`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/image\/png/);
    expect(r.headers['cache-control']).toMatch(/max-age=86400.*immutable|immutable.*max-age=86400/);
    // 2026-07-19 hotfix: CORP cross-origin permite que la landing tecnyapp.com
    // (dominio distinto del backend Railway) haga <img src="...logo">. Sin
    // este header el browser lo rechaza silenciosamente pese al status 200.
    expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
    // Content-Length coincide con los bytes reales decoded del base64 subido.
    expect(Number(r.headers['content-length'])).toBe(expectedSize);
    expect(r.body.length).toBe(expectedSize);
  });

  it('404 si id no existe', async () => {
    const r = await request(app).get('/api/public/trusted-companies/00000000-0000-0000-0000-000000000000/logo');
    expect(r.status).toBe(404);
  });

  it('400 si id inválido', async () => {
    const r = await request(app).get('/api/public/trusted-companies/not-uuid/logo');
    expect(r.status).toBe(400);
  });

  it('404 después del soft-delete', async () => {
    const created = (await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'Voy a morir', logo_data: PNG_1x1, logo_mime: 'image/png',
    })).body;

    await request(app).delete(`/api/super-admin/trusted-companies/${created.id}`).set(auth());

    const r = await request(app).get(`/api/public/trusted-companies/${created.id}/logo`);
    expect(r.status).toBe(404);
  });
});

describe('GET /api/super-admin/trusted-companies (admin list)', () => {
  it('401 sin token', async () => {
    const r = await request(app).get('/api/super-admin/trusted-companies');
    expect(r.status).toBe(401);
  });

  it('shape { companies: [...], limit: 40 }', async () => {
    const r = await request(app).get('/api/super-admin/trusted-companies').set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({
      companies: expect.any(Array),
      limit: 40,
    }));
  });

  it('trae metadata completa por empresa (sin logo_data para no bloatear)', async () => {
    await request(app).post('/api/super-admin/trusted-companies').set(auth()).send({
      nombre: 'Meta', logo_data: PNG_1x1, logo_mime: 'image/png', logo_nombre: 'meta.png',
    });
    const r = await request(app).get('/api/super-admin/trusted-companies').set(auth());
    expect(r.body.companies).toHaveLength(1);
    expect(r.body.companies[0]).toEqual(expect.objectContaining({
      nombre: 'Meta',
      logo_nombre: 'meta.png',
      logo_tipo: 'image/png',
      logo_size: expect.any(Number),
      position: 0,
      created_at: expect.any(String),
    }));
    // No enviamos base64 en el list.
    expect(r.body.companies[0]).not.toHaveProperty('logo_data');
    expect(r.body.companies[0]).not.toHaveProperty('logo_key');
  });
});
