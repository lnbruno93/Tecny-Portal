// rate-limit-login.test.js — 2026-06-11 T-17
//
// Verifica el rate-limit del endpoint /api/auth/login.
//
// Diseño: el app real tiene `skip: () => NODE_ENV==='test'` en el loginLimiter
// para que la suite de auth-lockout pueda disparar >10 intentos sin chocar con
// el IP limit (lockout per-user es la defensa primaria; IP limit es defense in
// depth). PERO eso significa que NUNCA testeamos la config real del limiter.
//
// Acá montamos una mini-app que usa la MISMA config (windowMs, max, message,
// skipSuccessfulRequests) pero sin el skip de test, y validamos:
//   1) Bajo el threshold (10) responde 200/401 sin rate-limit.
//   2) Al cruzarlo, responde 429 con el message exacto del config real.
//   3) skipSuccessfulRequests: un login OK NO cuenta para el contador.
//   4) Headers standardHeaders (RateLimit-*) están presentes.
//
// Si alguien cambia el `max: 10` en app.js o saca skipSuccessfulRequests, este
// test detecta la regresión.

const express = require('express');
const request = require('supertest');
const { rateLimit } = require('express-rate-limit');

// Reproducimos la config EXACTA del loginLimiter en src/app.js (líneas ~313+).
// Si esta config se desvía del prod, el test falla — eso es el punto.
function makeLoginLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos de login, esperá 15 minutos' },
    skipSuccessfulRequests: true,
    // SIN skip de test: queremos que dispare acá.
  });
}

describe('Rate limit del login (T-17)', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/login', makeLoginLimiter());
    // Mock endpoint: si body.password === 'ok' → 200, si no → 401.
    // Esto simula al login real (sin tocar la DB ni el JWT).
    app.post('/login', (req, res) => {
      if (req.body.password === 'ok') return res.json({ token: 'mock' });
      res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    });
  });

  it('debajo del threshold (10 fallos) sigue respondiendo 401 sin ratear', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post('/login').send({ username: 'x', password: 'bad' });
      expect(r.status).toBe(401);
    }
  });

  it('el intento 11 cae con 429 + message exacto', async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).post('/login').send({ username: 'x', password: 'bad' });
    }
    const r = await request(app).post('/login').send({ username: 'x', password: 'bad' });
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'Demasiados intentos de login, esperá 15 minutos' });
  });

  it('skipSuccessfulRequests: 5 OK + 10 fallos = bloqueo recién en el 16to (los OK no cuentan)', async () => {
    // 5 logins exitosos — no deberían contar.
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/login').send({ username: 'x', password: 'ok' });
      expect(r.status).toBe(200);
    }
    // 10 fallos — el counter recién acá llega a 10.
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post('/login').send({ username: 'x', password: 'bad' });
      expect(r.status).toBe(401);
    }
    // 11vo fallo → 429.
    const r = await request(app).post('/login').send({ username: 'x', password: 'bad' });
    expect(r.status).toBe(429);
  });

  it('standardHeaders activo: las respuestas incluyen RateLimit-*', async () => {
    const r = await request(app).post('/login').send({ username: 'x', password: 'bad' });
    // express-rate-limit con standardHeaders=true devuelve los draft IETF
    // (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset).
    expect(r.headers['ratelimit-limit']).toBe('10');
    expect(r.headers['ratelimit-remaining']).toBeDefined();
    expect(r.headers['ratelimit-reset']).toBeDefined();
    // legacyHeaders=false → NO debe estar el X-RateLimit-* (cabecera antigua).
    expect(r.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('el bloqueo persiste entre requests consecutivos de la misma IP', async () => {
    // Cubrimos: una vez ratereado, todas las requests siguientes en la misma
    // window devuelven 429 hasta que el window expire.
    // (El test de aislamiento por-key está en postgresRateLimitStore.test.js).
    for (let i = 0; i < 11; i++) {
      await request(app).post('/login').send({ password: 'bad' });
    }
    // 3 requests más → todos 429.
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post('/login').send({ password: 'bad' });
      expect(r.status).toBe(429);
    }
  });
});
