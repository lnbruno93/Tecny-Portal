/**
 * Tests integration para CMS Landing Fase 1 — sección Contacto editable
 * desde admin.
 *
 * Cubre:
 *   · GET /api/public/site-config sin auth → 200 con shape esperado.
 *   · Cache-Control header presente.
 *   · Fase-safety: response incluye placeholders `testimonials: []` y
 *     `footer: null` para que la landing pueda extenderse sin breaking.
 *   · PATCH /api/super-admin/site-config requiere super-admin.
 *   · PATCH parcial actualiza solo los campos enviados.
 *   · PATCH refleja los cambios en GET público inmediatamente (sin cache
 *     entre el PATCH y el GET dentro del test).
 *   · Validaciones Zod: email malo → 400, WhatsApp con letras → 400,
 *     Instagram handle con @ → 400.
 *   · String vacío se normaliza a null en DB.
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { setupTestDb, teardownTestDb, TEST_USER } = require('./helpers/setup');
const userAuthCache = require('../src/lib/userAuthCache');

let pool, superAdminToken;
const auth = () => ({ Authorization: `Bearer ${superAdminToken}` });

beforeAll(async () => {
  pool = await setupTestDb();
  // Marcar user id=1 como super-admin con 2FA (patrón de superAdmin.test.js).
  await pool.query('UPDATE users SET is_super_admin = true WHERE id = 1');
  await pool.query(`
    INSERT INTO user_2fa (user_id, secret_encrypted, recovery_codes, enabled_at)
    VALUES (1, 'test-secret-enc', ARRAY['hash1','hash2'], NOW())
    ON CONFLICT (user_id) DO UPDATE SET enabled_at = NOW()
  `);
  await userAuthCache.invalidateUserAuth(1);
  // Re-seed de la row singleton (el TRUNCATE del setup la vació — hay que
  // volver a poblarla como hace la migration).
  await pool.query(`
    INSERT INTO site_landing_config (
      id, contact_email, contact_whatsapp, contact_whatsapp_display,
      contact_address, contact_instagram_handle, contact_instagram_url
    ) VALUES (
      1, 'hola@tecnyapp.com', '5491126165007', '+54 9 11 2616-5007',
      'Buenos Aires, Argentina', 'tecny.app', 'https://instagram.com/tecny.app'
    ) ON CONFLICT (id) DO UPDATE SET
      contact_email = EXCLUDED.contact_email,
      contact_whatsapp = EXCLUDED.contact_whatsapp,
      contact_whatsapp_display = EXCLUDED.contact_whatsapp_display,
      contact_address = EXCLUDED.contact_address,
      contact_instagram_handle = EXCLUDED.contact_instagram_handle,
      contact_instagram_url = EXCLUDED.contact_instagram_url
  `);

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

describe('GET /api/public/site-config', () => {
  it('devuelve 200 sin auth (es público)', async () => {
    const r = await request(app).get('/api/public/site-config');
    expect(r.status).toBe(200);
  });

  it('tiene shape { contact, testimonials, footer } — fase-safe', async () => {
    const r = await request(app).get('/api/public/site-config');
    expect(r.body).toHaveProperty('contact');
    expect(r.body).toHaveProperty('testimonials');
    expect(r.body).toHaveProperty('footer');
    // Sub-shape de contacto.
    expect(r.body.contact).toEqual(expect.objectContaining({
      email:              expect.any(String),
      whatsapp:           expect.any(String),
      whatsapp_display:   expect.any(String),
      address:            expect.any(String),
      instagram_handle:   expect.any(String),
      instagram_url:      expect.any(String),
    }));
    // Placeholders para fases futuras — la landing puede referenciar sin crashear.
    expect(r.body.testimonials).toEqual([]);
    expect(r.body.footer).toBeNull();
  });

  it('trae los valores seed de la migration por default', async () => {
    const r = await request(app).get('/api/public/site-config');
    expect(r.body.contact.email).toBe('hola@tecnyapp.com');
    expect(r.body.contact.instagram_handle).toBe('tecny.app');
  });

  it('setea Cache-Control: public, max-age=300', async () => {
    const r = await request(app).get('/api/public/site-config');
    expect(r.headers['cache-control']).toMatch(/public.*max-age=300/);
  });
});

describe('PATCH /api/super-admin/site-config', () => {
  it('rechaza sin auth → 401', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').send({
      contact_email: 'lucas@tecnyapp.com',
    });
    expect(r.status).toBe(401);
  });

  it('actualiza contact_email + refleja en GET público', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ contact_email: 'nuevo@tecnyapp.com' });
    expect(r.status).toBe(200);
    expect(r.body.contact_email).toBe('nuevo@tecnyapp.com');

    // GET público refleja el cambio.
    const pub = await request(app).get('/api/public/site-config');
    expect(pub.body.contact.email).toBe('nuevo@tecnyapp.com');
  });

  it('actualiza multiple campos en un PATCH', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({
        contact_whatsapp: '5491199887766',
        contact_whatsapp_display: '+54 9 11 9988-7766',
        contact_address: 'Nueva dirección Tecny',
      });
    expect(r.status).toBe(200);
    expect(r.body.contact_whatsapp).toBe('5491199887766');
    expect(r.body.contact_whatsapp_display).toBe('+54 9 11 9988-7766');
    expect(r.body.contact_address).toBe('Nueva dirección Tecny');
  });

  it('string vacío se normaliza a null en DB', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ contact_address: '' });
    expect(r.status).toBe(200);
    expect(r.body.contact_address).toBeNull();
  });

  it('rechaza email inválido → 400', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ contact_email: 'no-es-email' });
    expect(r.status).toBe(400);
  });

  it('rechaza whatsapp con letras → 400', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ contact_whatsapp: '5491ABC7766' });
    expect(r.status).toBe(400);
  });

  it('rechaza Instagram handle con @ → 400', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ contact_instagram_handle: '@tecny.app' });
    expect(r.status).toBe(400);
  });

  it('rechaza URL de Instagram inválida → 400', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ contact_instagram_url: 'not-a-url' });
    expect(r.status).toBe(400);
  });

  it('rechaza body {} — al menos un campo requerido → 400', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({});
    expect(r.status).toBe(400);
  });
});
