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
      contact_address, contact_instagram_handle, contact_instagram_url,
      testimonials
    ) VALUES (
      1, 'hola@tecnyapp.com', '5491126165007', '+54 9 11 2616-5007',
      'Buenos Aires, Argentina', 'tecny.app', 'https://instagram.com/tecny.app',
      '[]'::jsonb
    ) ON CONFLICT (id) DO UPDATE SET
      contact_email = EXCLUDED.contact_email,
      contact_whatsapp = EXCLUDED.contact_whatsapp,
      contact_whatsapp_display = EXCLUDED.contact_whatsapp_display,
      contact_address = EXCLUDED.contact_address,
      contact_instagram_handle = EXCLUDED.contact_instagram_handle,
      contact_instagram_url = EXCLUDED.contact_instagram_url,
      testimonials = EXCLUDED.testimonials
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

// 2026-07-13 (CMS Landing Fase 2): reseñas editables.
describe('PATCH /api/super-admin/site-config — testimonials (Fase 2)', () => {
  it('crea un testimonial nuevo → server genera id UUID', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({
        testimonials: [
          { name: 'Tomás R.', initial: 'T', color: '#4285F4', time: 'hace 3 días', text: 'Excelente atención, todo perfecto.' },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.testimonials).toHaveLength(1);
    expect(r.body.testimonials[0]).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}/i),
      name: 'Tomás R.',
      initial: 'T',
      color: '#4285F4',
      time: 'hace 3 días',
    }));

    // GET público refleja el cambio.
    const pub = await request(app).get('/api/public/site-config');
    expect(pub.body.testimonials).toHaveLength(1);
    expect(pub.body.testimonials[0].name).toBe('Tomás R.');
  });

  it('preserva id de testimonial existente al editar', async () => {
    // Primer PATCH: crear
    const create = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({
        testimonials: [
          { name: 'Original', initial: 'O', color: '#EA4335', time: 'hace 1 mes', text: 'Muy buena experiencia con Tecny.' },
        ],
      });
    const originalId = create.body.testimonials[0].id;

    // Segundo PATCH: editar el mismo (con id preservado)
    const edit = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({
        testimonials: [
          { id: originalId, name: 'Editado', initial: 'E', color: '#EA4335', time: 'hace 1 mes', text: 'Texto actualizado del testimonio.' },
        ],
      });
    expect(edit.status).toBe(200);
    expect(edit.body.testimonials[0].id).toBe(originalId);
    expect(edit.body.testimonials[0].name).toBe('Editado');
  });

  it('reemplaza todo el array (semántica PUT sobre el campo)', async () => {
    // Setup: 2 items (nombres min 2 chars por schema)
    await request(app).patch('/api/super-admin/site-config').set(auth()).send({
      testimonials: [
        { name: 'AA', initial: 'A', color: '#000000', time: 'hoy', text: 'Testimonio A del cliente.' },
        { name: 'BB', initial: 'B', color: '#FFFFFF', time: 'ayer', text: 'Testimonio B del cliente.' },
      ],
    });
    // Reemplazar con solo 1
    const r = await request(app).patch('/api/super-admin/site-config').set(auth()).send({
      testimonials: [
        { name: 'CC', initial: 'C', color: '#123456', time: 'antes', text: 'Testimonio C — reemplazó a los previos.' },
      ],
    });
    expect(r.body.testimonials).toHaveLength(1);
    expect(r.body.testimonials[0].name).toBe('CC');
  });

  it('permite array vacío (borra todos)', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ testimonials: [] });
    expect(r.status).toBe(200);
    expect(r.body.testimonials).toEqual([]);
  });

  it('rechaza testimonial con color inválido → 400', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({
        testimonials: [
          { name: 'X', initial: 'X', color: 'rojo', time: 'hoy', text: 'Texto suficiente para pasar.' },
        ],
      });
    expect(r.status).toBe(400);
  });

  it('rechaza testimonial con text muy corto → 400', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({
        testimonials: [
          { name: 'X', initial: 'X', color: '#000000', time: 'hoy', text: 'corto' },
        ],
      });
    expect(r.status).toBe(400);
  });

  it('rechaza más de 50 testimonials → 400', async () => {
    const arr = Array.from({ length: 51 }, (_, i) => ({
      name: `Test ${i}`, initial: 'T', color: '#000000',
      time: 'hoy', text: 'Testimonio de prueba con texto suficiente.',
    }));
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ testimonials: arr });
    expect(r.status).toBe(400);
  });
});

// 2026-07-13: Toggle google_reviews_enabled — admin control para pausar la
// integración con Google Business Profile sin redeploy.
describe('google_reviews_enabled toggle', () => {
  // Backup del cache in-memory de googleReviews entre tests (evita cross-talk
  // con otros tests que setean el mock del fetch).
  const googleReviews = require('../src/lib/googleReviews');
  afterEach(() => { googleReviews._internal._clearCache(); jest.restoreAllMocks(); });

  it('default true en la row seed (migration aplicada)', async () => {
    const { rows } = await pool.query(
      `SELECT google_reviews_enabled FROM site_landing_config WHERE id = 1`
    );
    expect(rows[0].google_reviews_enabled).toBe(true);
  });

  it('PATCH google_reviews_enabled=false actualiza la row', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ google_reviews_enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.google_reviews_enabled).toBe(false);

    // Verificar en DB directamente.
    const { rows } = await pool.query(
      `SELECT google_reviews_enabled FROM site_landing_config WHERE id = 1`
    );
    expect(rows[0].google_reviews_enabled).toBe(false);

    // Cleanup: dejar en true para no cross-contaminar.
    await pool.query(
      `UPDATE site_landing_config SET google_reviews_enabled = true WHERE id = 1`
    );
  });

  it('PATCH google_reviews_enabled con string → 400 (Zod rechaza)', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ google_reviews_enabled: 'true' });
    expect(r.status).toBe(400);
  });

  describe('GET /api/public/google-reviews respeta el flag', () => {
    beforeAll(() => {
      // Setup env vars para que googleReviews intente el fetch. El mock del
      // fetch controla la respuesta.
      process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test_toggle';
      process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    });
    afterAll(() => {
      delete process.env.GOOGLE_PLACES_API_KEY;
      delete process.env.GOOGLE_PLACES_PLACE_ID;
    });

    it('flag=false → devuelve empty con disabled:true (NO llama a Google)', async () => {
      // Setear flag a false.
      await pool.query(
        `UPDATE site_landing_config SET google_reviews_enabled = false WHERE id = 1`
      );
      const fetchSpy = jest.spyOn(global, 'fetch');

      const r = await request(app).get('/api/public/google-reviews');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        reviews: [], count: 0, disabled: true, configured: true, source: 'google',
      });
      expect(fetchSpy).not.toHaveBeenCalled();

      // Cleanup.
      await pool.query(
        `UPDATE site_landing_config SET google_reviews_enabled = true WHERE id = 1`
      );
    });

    it('flag=true → llama a Google normalmente', async () => {
      // Confirmar que default está en true (viene del test anterior o seed).
      await pool.query(
        `UPDATE site_landing_config SET google_reviews_enabled = true WHERE id = 1`
      );
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          rating: 4.9, userRatingCount: 3,
          reviews: [{ name: 'places/x/reviews/1', text: { text: 'genial' },
                      authorAttribution: { displayName: 'X' } }],
        }),
      });

      const r = await request(app).get('/api/public/google-reviews');
      expect(r.status).toBe(200);
      expect(r.body.disabled).toBeUndefined();
      expect(r.body.reviews).toHaveLength(1);
      expect(r.body.count).toBe(3);
    });
  });

  describe('GET /api/super-admin/google-reviews-status', () => {
    beforeAll(() => {
      process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test_status';
      process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJt32vtDn5sCoRmCjEY6g98SU';
    });
    afterAll(() => {
      delete process.env.GOOGLE_PLACES_API_KEY;
      delete process.env.GOOGLE_PLACES_PLACE_ID;
    });

    it('requiere super-admin auth → 401 sin token', async () => {
      const r = await request(app).get('/api/super-admin/google-reviews-status');
      expect(r.status).toBe(401);
    });

    it('devuelve shape { enabled, configured, count, rating, cached_at, place_id }', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          rating: 4.7, userRatingCount: 12,
          reviews: [
            { name: 'places/x/reviews/1', text: { text: 'a' }, authorAttribution: { displayName: 'A' } },
            { name: 'places/x/reviews/2', text: { text: 'b' }, authorAttribution: { displayName: 'B' } },
          ],
        }),
      });

      const r = await request(app).get('/api/super-admin/google-reviews-status').set(auth());
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        enabled: true,
        configured: true,
        count: 12,
        rating: 4.7,
        reviews_visible: 2,
        place_id: 'ChIJt32vtDn5sCoRmCjEY6g98SU',
      });
      expect(r.body.cached_at).toBeTruthy();
    });

    it('refleja enabled=false cuando el flag está apagado', async () => {
      await pool.query(
        `UPDATE site_landing_config SET google_reviews_enabled = false WHERE id = 1`
      );
      jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ reviews: [] }),
      });

      const r = await request(app).get('/api/super-admin/google-reviews-status').set(auth());
      expect(r.status).toBe(200);
      expect(r.body.enabled).toBe(false);

      // Cleanup.
      await pool.query(
        `UPDATE site_landing_config SET google_reviews_enabled = true WHERE id = 1`
      );
    });
  });
});
