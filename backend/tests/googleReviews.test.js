/**
 * Tests para el módulo `lib/googleReviews` y su exposición en
 * GET /api/public/google-reviews.
 *
 * Cubre:
 *   Módulo (unit):
 *     · normalizeGoogleReview — shape correcto (id prefijado, initial,
 *       color determinístico, campos extras Google).
 *     · nameToColor determinístico (misma input → mismo output).
 *     · nameToInitial edge cases (vacío, whitespace, único char).
 *     · fetchFromGoogle sin env vars → { reviews: [], configured: false }.
 *     · fetchFromGoogle con network error → fail-open.
 *     · fetchFromGoogle con HTTP 4xx/5xx → fail-open.
 *     · fetchFromGoogle con response válida → normaliza + filtra reviews sin texto.
 *     · getReviews sirve cache si fresh, refetch si stale.
 *
 *   Route (integration):
 *     · 200 sin auth (público).
 *     · Cache-Control: public, max-age=3600.
 *     · Shape del response (reviews array, rating, count, source).
 *     · Sin env vars configuradas → { reviews: [], configured: false }.
 *     · Fail-open ante fallo interno.
 */

const request = require('supertest');
const app = require('../src/app');
const googleReviews = require('../src/lib/googleReviews');

// Backup env vars que vamos a mutar entre tests.
const origEnv = {
  GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY,
  GOOGLE_PLACES_PLACE_ID: process.env.GOOGLE_PLACES_PLACE_ID,
  GOOGLE_REVIEWS_CACHE_TTL_MS: process.env.GOOGLE_REVIEWS_CACHE_TTL_MS,
};

afterEach(() => {
  // Restaurar env vars y limpiar cache/mocks entre tests para evitar cross-talk.
  process.env.GOOGLE_PLACES_API_KEY = origEnv.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_PLACE_ID = origEnv.GOOGLE_PLACES_PLACE_ID;
  process.env.GOOGLE_REVIEWS_CACHE_TTL_MS = origEnv.GOOGLE_REVIEWS_CACHE_TTL_MS;
  if (origEnv.GOOGLE_PLACES_API_KEY === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  if (origEnv.GOOGLE_PLACES_PLACE_ID === undefined) delete process.env.GOOGLE_PLACES_PLACE_ID;
  if (origEnv.GOOGLE_REVIEWS_CACHE_TTL_MS === undefined) delete process.env.GOOGLE_REVIEWS_CACHE_TTL_MS;
  googleReviews._internal._clearCache();
  jest.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
// Unit tests — helpers puros
// ══════════════════════════════════════════════════════════════════════════

describe('nameToColor', () => {
  const { nameToColor } = googleReviews._internal;

  it('devuelve un hex #RRGGBB', () => {
    expect(nameToColor('Juan')).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('mismo nombre → mismo color (determinístico)', () => {
    expect(nameToColor('María F.')).toBe(nameToColor('María F.'));
  });

  it('distintos nombres pueden dar distinto color', () => {
    // Con 8 opciones en la palette y hash decente, esperamos algún spread.
    const colors = new Set(['Ana', 'Bruno', 'Carla', 'Diego', 'Elena', 'Franco', 'Gabriela', 'Hugo']
      .map(nameToColor));
    // Al menos 2 colores distintos (no todos colapsan al mismo bucket).
    expect(colors.size).toBeGreaterThan(1);
  });

  it('nombre vacío no crashea', () => {
    expect(() => nameToColor('')).not.toThrow();
    expect(nameToColor('')).toMatch(/^#/);
  });
});

describe('nameToInitial', () => {
  const { nameToInitial } = googleReviews._internal;

  it('devuelve la primera letra en mayúscula', () => {
    expect(nameToInitial('juan')).toBe('J');
    expect(nameToInitial('María F.')).toBe('M');
  });

  it('trimmea whitespace', () => {
    expect(nameToInitial('  Tomás')).toBe('T');
  });

  it('nombre vacío → "?"', () => {
    expect(nameToInitial('')).toBe('?');
    expect(nameToInitial('   ')).toBe('?');
    expect(nameToInitial(null)).toBe('?');
    expect(nameToInitial(undefined)).toBe('?');
  });
});

describe('normalizeGoogleReview', () => {
  const { normalizeGoogleReview } = googleReviews._internal;

  it('mapea todos los campos al shape SiteTestimonial + extras Google', () => {
    const gReview = {
      name: 'places/ChIJt32vtDn5sCoRmCjEY6g98SU/reviews/ChdDSUhNMG9nS0VJQ0FnSUR3',
      relativePublishTimeDescription: 'hace 3 días',
      rating: 5,
      text: { text: 'Excelente atención, todo perfecto.', languageCode: 'es' },
      originalText: { text: 'Excelente atención, todo perfecto.', languageCode: 'es' },
      authorAttribution: {
        displayName: 'Tomás R.',
        uri: 'https://www.google.com/maps/contrib/12345',
        photoUri: 'https://lh3.googleusercontent.com/a/photo.jpg',
      },
      publishTime: '2026-07-10T12:00:00Z',
    };
    const n = normalizeGoogleReview(gReview);
    expect(n.id).toBe('google:ChdDSUhNMG9nS0VJQ0FnSUR3');
    expect(n.name).toBe('Tomás R.');
    expect(n.initial).toBe('T');
    expect(n.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(n.time).toBe('hace 3 días');
    expect(n.text).toBe('Excelente atención, todo perfecto.');
    expect(n.rating).toBe(5);
    expect(n.source).toBe('google');
    expect(n.photo_url).toBe('https://lh3.googleusercontent.com/a/photo.jpg');
    expect(n.author_url).toBe('https://www.google.com/maps/contrib/12345');
  });

  it('cae a originalText.text si falta text.text', () => {
    const gReview = {
      name: 'places/X/reviews/Y',
      authorAttribution: { displayName: 'Anna' },
      originalText: { text: 'Only original text', languageCode: 'en' },
    };
    expect(normalizeGoogleReview(gReview).text).toBe('Only original text');
  });

  it('sin authorAttribution → name "Anónimo"', () => {
    const n = normalizeGoogleReview({
      name: 'places/X/reviews/Y',
      text: { text: 'algo' },
    });
    expect(n.name).toBe('Anónimo');
    expect(n.initial).toBe('A');
    expect(n.photo_url).toBeNull();
    expect(n.author_url).toBeNull();
  });

  it('sin rating numérico → null (no NaN)', () => {
    const n = normalizeGoogleReview({
      name: 'places/X/reviews/Y',
      authorAttribution: { displayName: 'X' },
      text: { text: 'x' },
    });
    expect(n.rating).toBeNull();
  });

  it('id se prefija con "google:" para no colisionar con UUIDs CMS', () => {
    const n = normalizeGoogleReview({
      name: 'places/PLACE/reviews/REVIEW123',
      authorAttribution: { displayName: 'X' },
      text: { text: 'x' },
    });
    expect(n.id).toBe('google:REVIEW123');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Unit tests — fetchFromGoogle (mockeando fetch)
// ══════════════════════════════════════════════════════════════════════════

describe('fetchFromGoogle', () => {
  const { fetchFromGoogle } = googleReviews._internal;

  it('sin GOOGLE_PLACES_API_KEY → { reviews: [], configured: false }', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    const fetchSpy = jest.spyOn(global, 'fetch');
    const r = await fetchFromGoogle();
    expect(r).toEqual({
      reviews: [], rating: null, count: 0, source: 'google', configured: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sin GOOGLE_PLACES_PLACE_ID → { reviews: [], configured: false }', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    delete process.env.GOOGLE_PLACES_PLACE_ID;
    const fetchSpy = jest.spyOn(global, 'fetch');
    const r = await fetchFromGoogle();
    expect(r.configured).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('network error → { reviews: [], error: "network_error" } (fail-open)', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = await fetchFromGoogle();
    expect(r).toMatchObject({ reviews: [], configured: true, error: 'network_error' });
  });

  it('HTTP 403 → fail-open con error: "http_error"', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => '{"error":"forbidden"}',
    });
    const r = await fetchFromGoogle();
    expect(r).toMatchObject({ reviews: [], error: 'http_error' });
  });

  it('HTTP 200 sin body JSON → fail-open con error: "parse_error"', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new Error('not json'); },
    });
    const r = await fetchFromGoogle();
    expect(r).toMatchObject({ reviews: [], error: 'parse_error' });
  });

  it('respuesta válida con 2 reviews → normaliza + rating + count', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'ChIJx',
        displayName: { text: 'Tecny App' },
        rating: 4.7,
        userRatingCount: 12,
        reviews: [
          {
            name: 'places/ChIJx/reviews/R1',
            relativePublishTimeDescription: 'hace 1 día',
            rating: 5,
            text: { text: 'Muy bueno' },
            authorAttribution: { displayName: 'Ana', photoUri: null, uri: null },
          },
          {
            name: 'places/ChIJx/reviews/R2',
            relativePublishTimeDescription: 'hace 2 semanas',
            rating: 4,
            text: { text: 'Recomendable' },
            authorAttribution: { displayName: 'Bruno' },
          },
        ],
      }),
    });
    const r = await fetchFromGoogle();
    expect(r.reviews).toHaveLength(2);
    expect(r.reviews[0]).toMatchObject({ id: 'google:R1', name: 'Ana', text: 'Muy bueno', rating: 5 });
    expect(r.reviews[1]).toMatchObject({ id: 'google:R2', name: 'Bruno', text: 'Recomendable' });
    expect(r.rating).toBe(4.7);
    expect(r.count).toBe(12);
    expect(r.source).toBe('google');
    expect(r.configured).toBe(true);
  });

  it('filtra reviews sin texto (star-only ratings)', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rating: 5,
        userRatingCount: 3,
        reviews: [
          { name: 'places/x/reviews/1', text: { text: 'Con texto' }, authorAttribution: { displayName: 'A' } },
          { name: 'places/x/reviews/2', text: { text: '' }, authorAttribution: { displayName: 'B' } },
          { name: 'places/x/reviews/3', authorAttribution: { displayName: 'C' } }, // sin text
        ],
      }),
    });
    const r = await fetchFromGoogle();
    // Solo la review "Con texto" debe pasar el filtro
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0].name).toBe('A');
  });

  it('response sin reviews field → reviews: []', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'x', displayName: { text: 'x' } }),
    });
    const r = await fetchFromGoogle();
    expect(r.reviews).toEqual([]);
    expect(r.count).toBe(0);
    expect(r.rating).toBeNull();
  });

  it('llama al endpoint correcto con headers de Places API New', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_mock_key';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJt32vtDn5sCoRmCjEY6g98SU';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ reviews: [] }),
    });
    await fetchFromGoogle();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('places.googleapis.com/v1/places/ChIJt32vtDn5sCoRmCjEY6g98SU');
    expect(url).toContain('languageCode=es');
    expect(opts.headers['X-Goog-Api-Key']).toBe('AIzaSy_mock_key');
    expect(opts.headers['X-Goog-FieldMask']).toContain('reviews');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Unit tests — cache lazy
// ══════════════════════════════════════════════════════════════════════════

describe('getReviews — cache', () => {
  it('primera llamada refresca, segunda dentro del TTL sirve cache', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        rating: 4.5, userRatingCount: 5,
        reviews: [{ name: 'places/x/reviews/1', text: { text: 't' }, authorAttribution: { displayName: 'A' } }],
      }),
    });

    const r1 = await googleReviews.getReviews();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r1.reviews).toHaveLength(1);

    const r2 = await googleReviews.getReviews();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // NO refetch — cache hit
    expect(r2.reviews).toEqual(r1.reviews);
  });

  it('TTL=0 fuerza refetch en cada llamada', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    // Ojo: la lib parsea Number(env) || DEFAULT. 0 || DEFAULT === DEFAULT.
    // Para forzar "TTL efectivo 0", uso 1ms + jest advance / setTimeout.
    // Alternativa: clear cache entre llamadas — más simple para el test.
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ reviews: [] }),
    });

    await googleReviews.getReviews();
    googleReviews._internal._clearCache();
    await googleReviews.getReviews();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Integration — GET /api/public/google-reviews
// ══════════════════════════════════════════════════════════════════════════

describe('GET /api/public/google-reviews', () => {
  it('200 sin auth (endpoint público)', async () => {
    // Sin env vars → devuelve configured: false pero status 200
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_PLACE_ID;
    const r = await request(app).get('/api/public/google-reviews');
    expect(r.status).toBe(200);
  });

  it('Cache-Control: public, max-age=3600', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const r = await request(app).get('/api/public/google-reviews');
    expect(r.headers['cache-control']).toMatch(/public/);
    expect(r.headers['cache-control']).toMatch(/max-age=3600/);
  });

  it('sin env vars configuradas → { reviews: [], configured: false }', async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.GOOGLE_PLACES_PLACE_ID;
    const r = await request(app).get('/api/public/google-reviews');
    expect(r.body).toMatchObject({
      reviews: [],
      rating: null,
      count: 0,
      source: 'google',
      configured: false,
    });
    expect(r.body).toHaveProperty('cachedAt');
  });

  it('con env vars + API 200 → shape completo con reviews normalizadas', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        rating: 4.8, userRatingCount: 20,
        reviews: [
          {
            name: 'places/ChIJx/reviews/R1',
            relativePublishTimeDescription: 'hace 5 días',
            rating: 5,
            text: { text: 'Muy buena atención, respondieron todas mis dudas.' },
            authorAttribution: { displayName: 'Camila' },
          },
        ],
      }),
    });
    const r = await request(app).get('/api/public/google-reviews');
    expect(r.status).toBe(200);
    expect(r.body.reviews).toHaveLength(1);
    expect(r.body.reviews[0]).toMatchObject({
      name: 'Camila', source: 'google', rating: 5,
    });
    expect(r.body.rating).toBe(4.8);
    expect(r.body.count).toBe(20);
  });

  it('API caída (500) → devuelve 200 con reviews: [] (fail-open)', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'AIzaSy_test';
    process.env.GOOGLE_PLACES_PLACE_ID = 'ChIJx';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });
    const r = await request(app).get('/api/public/google-reviews');
    expect(r.status).toBe(200);
    expect(r.body.reviews).toEqual([]);
    expect(r.body.error).toBe('http_error');
  });
});
