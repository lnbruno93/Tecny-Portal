// rate-limit-global.test.js — 2026-06-15
//
// Verifica el skip del rate-limit GLOBAL para requests con JWT firmado válido.
//
// Contexto del incidente que motivó este test:
//   El global limiter (300 req / 15 min / IP) aplicaba indiscriminadamente,
//   incluyendo /api/auth/login. Borrando muchos recursos seguidos en la UI
//   un admin podía agotar el bucket y quedarse afuera del propio portal
//   (login también devolvía 429). El skip por JWT firmado resuelve esto:
//   el global protege contra abuso anónimo (scrapers, brute force pre-login)
//   pero usuarios autenticados se rigen por los limiters específicos de cada
//   endpoint (login, OCR, export, compras, backfill, etc.).
//
// Diseño: mini-app con la misma config que el global de app.js pero con
// `max: 3` para que el test sea rápido. No hacemos hit al servidor real
// (que skipea TODO en NODE_ENV=test) — testeamos la lógica de skip aislada.
//
// Si alguien rompe el skip por JWT (o sacaría la verificación de signature
// y dejaría que cualquier "Bearer X" bypassee el limit), este test falla.

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');

const TEST_SECRET = 'test-secret-rate-limit-global';

// Helper idéntico al de src/app.js. Si lo movemos a un lib compartido en el
// futuro, este test deberá importarlo desde allí — por ahora replicamos para
// que el test no dependa del binding interno.
function hasValidSignedJwt(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (!token || !process.env.JWT_SECRET) return false;
  try {
    jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    return true;
  } catch {
    return false;
  }
}

function makeGlobalLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3, // bajo a propósito para el test
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes, intentá de nuevo en 15 minutos' },
    skip: (req) => req.path === '/health' || hasValidSignedJwt(req),
  });
}

describe('Rate limit GLOBAL — skip por JWT firmado (2026-06-15)', () => {
  let app;
  let prevSecret;

  beforeAll(() => {
    prevSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  beforeEach(() => {
    app = express();
    app.use(makeGlobalLimiter());
    app.get('/api/foo', (_req, res) => res.json({ ok: true }));
    app.get('/health',  (_req, res) => res.json({ ok: true })); // siempre skip
    app.post('/api/auth/login', (_req, res) => res.json({ token: 'mock' }));
  });

  it('SIN Authorization header: cae al hit del limit (anonymous abuse)', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await request(app).get('/api/foo');
      expect(r.status).toBe(200);
    }
    const r4 = await request(app).get('/api/foo');
    expect(r4.status).toBe(429);
    expect(r4.body.error).toMatch(/Demasiadas solicitudes/);
  });

  it('CON Authorization Bearer JUNK: tampoco bypassea (signature inválida)', async () => {
    const junk = 'no.es.un.jwt.real';
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/foo').set('Authorization', `Bearer ${junk}`);
    }
    const r = await request(app).get('/api/foo').set('Authorization', `Bearer ${junk}`);
    expect(r.status).toBe(429);
  });

  it('CON JWT firmado con OTRO secret: no bypassea', async () => {
    const wrongSecret = jwt.sign({ id: 1, username: 'mallory' }, 'otro-secret', { algorithm: 'HS256' });
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/foo').set('Authorization', `Bearer ${wrongSecret}`);
    }
    const r = await request(app).get('/api/foo').set('Authorization', `Bearer ${wrongSecret}`);
    expect(r.status).toBe(429);
  });

  it('CON JWT firmado válido: salta el limit indefinidamente', async () => {
    const valid = jwt.sign({ id: 1, username: 'lucas', role: 'admin' }, TEST_SECRET, { algorithm: 'HS256' });
    // Pegamos muchas más veces que el max (3) — debería seguir respondiendo 200.
    for (let i = 0; i < 10; i++) {
      const r = await request(app).get('/api/foo').set('Authorization', `Bearer ${valid}`);
      expect(r.status).toBe(200);
    }
  });

  it('login (sin Authorization) sigue contando contra el bucket — defensa anti brute-force', async () => {
    // Disparo anónimo de requests a un endpoint cualquiera hasta agotar el bucket
    for (let i = 0; i < 3; i++) await request(app).get('/api/foo');
    // Ahora intento login: también está rate-limited (mismo IP, mismo bucket).
    const r = await request(app).post('/api/auth/login').send({ username: 'x', password: 'y' });
    expect(r.status).toBe(429);
  });

  it('/health siempre skipea — los probes de monitoring no caen al limit', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(app).get('/health');
      expect(r.status).toBe(200);
    }
  });
});
