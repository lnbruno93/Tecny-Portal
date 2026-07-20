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

  it('tiene shape { contact, testimonials, hero, cta, faq, footer } — fase-safe', async () => {
    const r = await request(app).get('/api/public/site-config');
    expect(r.body).toHaveProperty('contact');
    expect(r.body).toHaveProperty('testimonials');
    // 2026-07-13 Fase 3: hero + cta + faq.
    expect(r.body).toHaveProperty('hero');
    expect(r.body).toHaveProperty('cta');
    expect(r.body).toHaveProperty('faq');
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
    // Sub-shape de hero + cta (todos null en el seed — landing usa fallback).
    expect(r.body.hero).toEqual({ headline: null, subheadline: null, blurb: null });
    expect(r.body.cta).toEqual({ headline: null, body: null });
    // Placeholders para fases futuras — la landing puede referenciar sin crashear.
    expect(r.body.testimonials).toEqual([]);
    expect(r.body.faq).toEqual([]);
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

// 2026-07-13 (CMS Landing Fase 3): Hero + CTA + FAQ editables desde admin.
describe('CMS Fase 3 — hero + cta + faq', () => {
  it('PATCH hero_headline se guarda y refleja en GET público', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ hero_headline: 'Ordená tu revendedora hoy' });
    expect(r.status).toBe(200);
    expect(r.body.hero_headline).toBe('Ordená tu revendedora hoy');

    const pub = await request(app).get('/api/public/site-config');
    expect(pub.body.hero.headline).toBe('Ordená tu revendedora hoy');
  });

  it('PATCH hero_blurb con string vacío → null (normalización)', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ hero_blurb: '' });
    expect(r.status).toBe(200);
    expect(r.body.hero_blurb).toBeNull();
  });

  it('PATCH cta_headline y cta_body se persisten juntos', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ cta_headline: 'Empezá gratis hoy', cta_body: 'Sin tarjeta requerida.' });
    expect(r.status).toBe(200);
    expect(r.body.cta_headline).toBe('Empezá gratis hoy');
    expect(r.body.cta_body).toBe('Sin tarjeta requerida.');

    const pub = await request(app).get('/api/public/site-config');
    expect(pub.body.cta).toEqual({ headline: 'Empezá gratis hoy', body: 'Sin tarjeta requerida.' });
  });

  it('rechaza hero_headline > 100 chars → 400', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ hero_headline: 'x'.repeat(101) });
    expect(r.status).toBe(400);
  });

  it('rechaza cta_headline > 80 chars → 400', async () => {
    const r = await request(app).patch('/api/super-admin/site-config').set(auth())
      .send({ cta_headline: 'x'.repeat(81) });
    expect(r.status).toBe(400);
  });

  describe('FAQ (JSONB array)', () => {
    it('crea FAQ nuevo → server genera UUIDs', async () => {
      const r = await request(app).patch('/api/super-admin/site-config').set(auth())
        .send({
          faq: [
            { question: '¿Es difícil de usar?', answer: 'Para nada — 15 min de onboarding.' },
            { question: '¿Cuánto sale?', answer: 'Desde USD 39/mes.' },
          ],
        });
      expect(r.status).toBe(200);
      expect(r.body.faq).toHaveLength(2);
      expect(r.body.faq[0]).toEqual(expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}/i),
        question: '¿Es difícil de usar?',
      }));
    });

    it('preserva id de FAQ existente al editar', async () => {
      const create = await request(app).patch('/api/super-admin/site-config').set(auth())
        .send({ faq: [{ question: '¿Pregunta original?', answer: 'Respuesta original válida.' }] });
      const origId = create.body.faq[0].id;

      const edit = await request(app).patch('/api/super-admin/site-config').set(auth())
        .send({ faq: [{ id: origId, question: '¿Pregunta editada?', answer: 'Respuesta editada válida.' }] });
      expect(edit.body.faq[0].id).toBe(origId);
      expect(edit.body.faq[0].question).toBe('¿Pregunta editada?');
    });

    it('permite array vacío (borra todos)', async () => {
      const r = await request(app).patch('/api/super-admin/site-config').set(auth())
        .send({ faq: [] });
      expect(r.status).toBe(200);
      expect(r.body.faq).toEqual([]);
    });

    it('rechaza FAQ con answer < 3 chars → 400', async () => {
      const r = await request(app).patch('/api/super-admin/site-config').set(auth())
        .send({ faq: [{ question: '¿Sí?', answer: 'no' }] });
      expect(r.status).toBe(400);
    });

    it('rechaza más de 20 preguntas → 400', async () => {
      const arr = Array.from({ length: 21 }, (_, i) => ({
        question: `¿Pregunta ${i}?`, answer: 'Respuesta suficientemente larga.',
      }));
      const r = await request(app).patch('/api/super-admin/site-config').set(auth())
        .send({ faq: arr });
      expect(r.status).toBe(400);
    });
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

// ── Sprint 3 M4a: content JSONB trigger ────────────────────────────────
//
// La migration 20260720000001_site_landing_content_jsonb agrega la columna
// `content JSONB` + un trigger BEFORE INSERT/UPDATE que la mantiene
// sincronizada con las columnas legacy. Esta suite verifica la invariante
// "content == columnas" ante los distintos writes que el sistema puede
// producir.
//
// Se testea acá (no en unit tests) porque necesita PG real — el trigger
// vive en la DB. Un mock de pg no lo cubriría.

describe('Sprint 3 M4a — trigger site_landing_config_sync_content', () => {
  // Helper: espera a que la row singleton tenga content JSONB alineado con
  // las columnas legacy. Es sync porque el trigger corre en el mismo statement.
  async function readContent() {
    const { rows } = await pool.query(
      `SELECT content, contact_email, contact_whatsapp, contact_whatsapp_display,
              contact_address, contact_instagram_handle, contact_instagram_url,
              hero_headline, hero_subheadline, hero_blurb,
              cta_headline, cta_body,
              testimonials, faq, google_reviews_enabled
         FROM site_landing_config WHERE id = 1`,
    );
    return rows[0];
  }

  it('content JSONB tiene todas las secciones esperadas', async () => {
    const row = await readContent();
    // Contract del content JSONB definido en la migration. Estas keys deben
    // existir siempre — landing/admin no tolera cambios accidentales.
    expect(row.content).toHaveProperty('contact');
    expect(row.content).toHaveProperty('hero');
    expect(row.content).toHaveProperty('cta');
    expect(row.content).toHaveProperty('testimonials');
    expect(row.content).toHaveProperty('faq');
    expect(row.content).toHaveProperty('features');
  });

  it('content.contact matchea las columnas contact_*', async () => {
    const row = await readContent();
    expect(row.content.contact).toEqual({
      email: row.contact_email,
      whatsapp: row.contact_whatsapp,
      whatsapp_display: row.contact_whatsapp_display,
      address: row.contact_address,
      instagram_handle: row.contact_instagram_handle,
      instagram_url: row.contact_instagram_url,
    });
  });

  it('UPDATE de una columna hero_* sincroniza content.hero automáticamente', async () => {
    await pool.query(
      `UPDATE site_landing_config SET hero_headline = $1 WHERE id = 1`,
      ['Test headline sync'],
    );
    const row = await readContent();
    expect(row.content.hero.headline).toBe('Test headline sync');
    expect(row.hero_headline).toBe('Test headline sync');
    // Cleanup.
    await pool.query(
      `UPDATE site_landing_config SET hero_headline = NULL WHERE id = 1`,
    );
  });

  it('UPDATE de testimonials (JSONB) sincroniza content.testimonials', async () => {
    const testimonials = [
      { id: 't1', name: 'Test User', initial: 'T', color: 'blue', time: 'hace 1 mes', text: 'ok' },
    ];
    await pool.query(
      `UPDATE site_landing_config SET testimonials = $1::jsonb WHERE id = 1`,
      [JSON.stringify(testimonials)],
    );
    const row = await readContent();
    expect(row.content.testimonials).toEqual(testimonials);
    // Cleanup.
    await pool.query(
      `UPDATE site_landing_config SET testimonials = '[]'::jsonb WHERE id = 1`,
    );
  });

  it('UPDATE de google_reviews_enabled sincroniza content.features', async () => {
    await pool.query(
      `UPDATE site_landing_config SET google_reviews_enabled = false WHERE id = 1`,
    );
    const row = await readContent();
    expect(row.content.features.google_reviews_enabled).toBe(false);
    // Cleanup.
    await pool.query(
      `UPDATE site_landing_config SET google_reviews_enabled = true WHERE id = 1`,
    );
  });

  it('el PATCH endpoint del admin dispara el sync (invariante end-to-end)', async () => {
    // Simula lo que la UI del admin hace: PATCH con hero + testimonials +
    // toggle google reviews. Después leemos la row y verificamos que content
    // JSONB refleja los cambios sin que el endpoint escriba a `content`.
    const payload = {
      hero_headline: 'Headline via PATCH',
      cta_body: 'CTA body via PATCH',
      testimonials: [
        // Color debe ser #RRGGBB + text mínimo 10 chars — matchea el Zod
        // schema del PATCH (`testimonialItemSchema` en schemas/superAdmin.js).
        { name: 'Cliente Real', initial: 'C', color: '#22c55e', time: 'hace 3 días', text: 'testimonio real de prueba' },
      ],
      google_reviews_enabled: false,
    };
    const r = await request(app)
      .patch('/api/super-admin/site-config')
      .set(auth())
      .send(payload);
    expect(r.status).toBe(200);

    const row = await readContent();
    expect(row.content.hero.headline).toBe('Headline via PATCH');
    expect(row.content.cta.body).toBe('CTA body via PATCH');
    expect(row.content.features.google_reviews_enabled).toBe(false);
    expect(row.content.testimonials).toHaveLength(1);
    expect(row.content.testimonials[0].name).toBe('Cliente Real');
    // El id fue generado server-side (crypto.randomUUID) — verificamos que
    // aparece en el JSONB con el mismo valor que en la columna.
    expect(row.content.testimonials[0].id).toBe(row.testimonials[0].id);

    // Cleanup — restaurar el estado inicial.
    await pool.query(`
      UPDATE site_landing_config
         SET hero_headline = NULL,
             cta_body = NULL,
             testimonials = '[]'::jsonb,
             google_reviews_enabled = true
       WHERE id = 1
    `);
  });

  it('columnas NULL se serializan como null en content JSONB (no como "null" string)', async () => {
    // Todos los campos hero_* + cta_* arrancan NULL. Verificamos que el
    // JSONB los expone como null JSON, no como string "null" o missing.
    await pool.query(`
      UPDATE site_landing_config
         SET hero_headline = NULL, hero_subheadline = NULL, hero_blurb = NULL,
             cta_headline = NULL, cta_body = NULL
       WHERE id = 1
    `);
    const row = await readContent();
    expect(row.content.hero).toEqual({ headline: null, subheadline: null, blurb: null });
    expect(row.content.cta).toEqual({ headline: null, body: null });
  });
});

// ── Sprint 3 M4b: reads desde content JSONB ────────────────────────────
//
// M4a agregó `content` JSONB con trigger que la sincroniza desde cols.
// M4b hace el flip: los reads (GET público + GET super-admin +
// google-reviews flag) leen desde `content` en vez de las cols.
//
// El shape del RESPONSE no cambia (compat con landing y admin). Este
// bloque de tests prueba que los reads efectivamente vienen del JSONB —
// no de las cols — creando una divergencia intencional entre ambos.

describe('Sprint 3 M4b — reads from content JSONB', () => {
  // Helper: fuerza una divergencia entre `content` y las cols. Como el
  // trigger BEFORE UPDATE sincroniza automáticamente en cada write,
  // usamos ALTER TABLE ... DISABLE TRIGGER para que el UPDATE se
  // aplique sin re-sincronizar. Después de asertar el read, re-enable +
  // fire una UPDATE no-op para restaurar la invariante.
  //
  // Ojo: es un patrón invasivo (toca el schema) pero es aislado al test
  // y se revierte antes del beforeEach del siguiente test — no ensucia.
  async function withDivergentContent(contentOverrides, fn) {
    await pool.query(`ALTER TABLE site_landing_config DISABLE TRIGGER site_landing_config_sync_content_trg`);
    try {
      await pool.query(
        `UPDATE site_landing_config SET content = content || $1::jsonb WHERE id = 1`,
        [JSON.stringify(contentOverrides)],
      );
      await fn();
    } finally {
      await pool.query(`ALTER TABLE site_landing_config ENABLE TRIGGER site_landing_config_sync_content_trg`);
      // Re-sync content desde las cols (no-op UPDATE dispara el trigger).
      await pool.query(`UPDATE site_landing_config SET id = id WHERE id = 1`);
    }
  }

  it('GET /api/public/site-config lee contact desde content (no de las cols)', async () => {
    await withDivergentContent(
      {
        contact: {
          email: 'jsonb@only.test',
          whatsapp: '9999999999',
          whatsapp_display: '+99 9 9999-9999',
          address: 'Solo en JSONB',
          instagram_handle: 'only.jsonb',
          instagram_url: 'https://instagram.com/only.jsonb',
        },
      },
      async () => {
        const r = await request(app).get('/api/public/site-config');
        expect(r.status).toBe(200);
        // El endpoint debe devolver los valores DEL JSONB, no de las cols
        // (que tienen los valores originales del seed).
        expect(r.body.contact.email).toBe('jsonb@only.test');
        expect(r.body.contact.address).toBe('Solo en JSONB');
      },
    );
  });

  it('GET /api/public/site-config lee hero + cta + faq desde content', async () => {
    await withDivergentContent(
      {
        hero: { headline: 'H de JSONB', subheadline: null, blurb: 'B de JSONB' },
        cta: { headline: 'CTA de JSONB', body: 'body de JSONB' },
        faq: [{ id: '11111111-1111-4111-8111-111111111111', question: 'Q JSONB', answer: 'A JSONB' }],
      },
      async () => {
        const r = await request(app).get('/api/public/site-config');
        expect(r.status).toBe(200);
        expect(r.body.hero.headline).toBe('H de JSONB');
        expect(r.body.cta.headline).toBe('CTA de JSONB');
        expect(r.body.faq).toHaveLength(1);
        expect(r.body.faq[0].question).toBe('Q JSONB');
      },
    );
  });

  it('GET /api/public/google-reviews respeta el flag desde content.features', async () => {
    await withDivergentContent(
      { features: { google_reviews_enabled: false } },
      async () => {
        // Con el flag false, el endpoint devuelve reviews vacías + disabled=true
        // (misma semantica que el test original de google-reviews toggle).
        jest.spyOn(global, 'fetch').mockResolvedValueOnce({
          ok: true,
          json: async () => ({ reviews: [{ author_name: 'no-va' }] }),
        });
        const r = await request(app).get('/api/public/google-reviews');
        expect(r.status).toBe(200);
        expect(r.body.disabled).toBe(true);
        expect(r.body.reviews).toEqual([]);
      },
    );
  });

  it('GET /api/super-admin/site-config devuelve shape flat desde content', async () => {
    await withDivergentContent(
      {
        contact: { email: 'admin-flat@jsonb.test' },
        hero: { headline: 'Hero from JSONB via admin GET' },
      },
      async () => {
        const r = await request(app)
          .get('/api/super-admin/site-config')
          .set(auth());
        expect(r.status).toBe(200);
        // Contract: shape flat (mismos nombres de fields que antes) — la
        // admin UI no cambia. La source detrás sí (content JSONB).
        expect(r.body.contact_email).toBe('admin-flat@jsonb.test');
        expect(r.body.hero_headline).toBe('Hero from JSONB via admin GET');
      },
    );
  });

  it('PATCH endpoint returns response shape flat desde content', async () => {
    // Verifica que el RETURNING del PATCH también usa content (no cols).
    // Sin divergence acá porque el PATCH inmediatamente re-sync por el
    // trigger — solo probamos que el shape de la response es correcto.
    const r = await request(app)
      .patch('/api/super-admin/site-config')
      .set(auth())
      .send({ hero_headline: 'PATCH → returning', cta_headline: 'PATCH cta' });
    expect(r.status).toBe(200);
    expect(r.body.hero_headline).toBe('PATCH → returning');
    expect(r.body.cta_headline).toBe('PATCH cta');
    // Cleanup.
    await pool.query(
      `UPDATE site_landing_config SET hero_headline = NULL, cta_headline = NULL WHERE id = 1`,
    );
  });
});
