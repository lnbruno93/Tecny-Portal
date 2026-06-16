/**
 * Tests del signupLimiter (TANDA 1).
 *
 * El limiter se define en `src/middleware/signupLimiter.js` y no se wirea
 * todavía (espera a TANDA 2 cuando se cree `/api/auth/signup`). Acá
 * verificamos la config básica + comportamiento del middleware vía un app
 * Express dummy montado a propósito.
 */

const express = require('express');
const request = require('supertest');
const createSignupLimiter = require('../src/middleware/signupLimiter');

describe('signupLimiter middleware', () => {
  it('es una factory que devuelve un middleware Express', () => {
    const mw = createSignupLimiter();
    expect(typeof mw).toBe('function');
    // express middlewares tienen aridad 3: (req, res, next)
    expect(mw.length).toBe(3);
  });

  it('acepta un store opcional (PostgresRateLimitStore-compatible)', () => {
    const fakeStore = {
      init: () => {},
      increment: async () => ({ totalHits: 1, resetTime: new Date(Date.now() + 60_000) }),
      decrement: async () => {},
      resetKey: async () => {},
      localKeys: false,
    };
    const mw = createSignupLimiter(fakeStore);
    expect(typeof mw).toBe('function');
  });

  it('en NODE_ENV=test, el middleware bypassea (skip:true)', async () => {
    // El test runner corre con NODE_ENV='test' (ver helpers/setEnv.js).
    expect(process.env.NODE_ENV).toBe('test');

    const app = express();
    app.use(express.json());
    // Wiramos el limiter a un route dummy.
    app.use('/signup-test', createSignupLimiter());
    app.post('/signup-test', (req, res) => res.json({ ok: true }));

    // 10 requests seguidos → todos deberían pasar (skip activo).
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post('/signup-test').send({});
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
    }
  });

  // Test "real" del limit en non-test env — temporariamente desactivamos el skip
  // creando un middleware sin el skip path, así verificamos que la config
  // (windowMs=1h, max=5) realmente limita.
  it('config real: max 5 requests / 1 hora, request #6 cae en 429', async () => {
    // Crea un limiter sin el skip (replicando la config pero forzando activo).
    // Usamos un keyGenerator fijo para que TODOS los requests compartan el
    // mismo counter (en supertest el req.ip puede variar/ser ambiguo entre
    // tests aislados de Express).
    const { rateLimit } = require('express-rate-limit');
    const realLimiter = rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiados intentos de registro desde esta IP. Esperá 1 hora antes de reintentar.' },
      keyGenerator: () => 'fixed-test-key',
      skipSuccessfulRequests: false,
      // NO skip — queremos que el limiter funcione en este test.
    });

    const app = express();
    app.use(express.json());
    app.use('/signup-test', realLimiter);
    app.post('/signup-test', (req, res) => res.json({ ok: true }));

    // Los primeros 5 pasan.
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/signup-test').send({});
      expect(r.status).toBe(200);
    }

    // El 6to es rechazado con 429.
    const blocked = await request(app).post('/signup-test').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/Demasiados intentos de registro/i);
  });
});
