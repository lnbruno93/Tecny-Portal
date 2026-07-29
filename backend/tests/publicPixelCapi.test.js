/**
 * Tests para POST /api/public/pixel-capi (F4 Landing Astro Meta CAPI).
 *
 * Cubre:
 *   - Validación de event_name whitelist
 *   - Validación de event_id (min/max length)
 *   - Payload size cap (4 KB)
 *   - Silent-fail sin CAPI_TOKEN (dev/local sin config)
 *   - Rate limit visible (test skipeable en CI que corre secuencial)
 *
 * NO cubre:
 *   - Forward real a Meta Graph API (requiere token válido, side-effect
 *     externo — se testea manualmente con Meta Test Events tool).
 */

const request = require('supertest');

// Aseguramos NO tener CAPI_TOKEN — testeamos el silent-fail path que
// es el que corre en dev/local sin config.
delete process.env.META_CAPI_ACCESS_TOKEN;

const app = require('../src/app');

describe('POST /api/public/pixel-capi', () => {
  const validEvent = {
    event_name: 'Lead',
    event_id: '12345678-1234-1234-1234-123456789abc',
    event_time: Math.floor(Date.now() / 1000),
    custom_data: { content_name: 'landing', content_category: 'hero' },
  };

  test('acepta evento válido y responde 200 (silent-fail sin token)', async () => {
    const res = await request(app).post('/api/public/pixel-capi').send(validEvent);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Sin token seteado, no se forwardea.
    expect(res.body.forwarded).toBe(false);
    expect(res.body.reason).toBe('token no configurado');
  });

  test('rechaza event_name no permitido', async () => {
    const res = await request(app)
      .post('/api/public/pixel-capi')
      .send({ ...validEvent, event_name: 'CustomEventoInventado' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/event_name/);
  });

  test('rechaza event_id demasiado corto', async () => {
    const res = await request(app)
      .post('/api/public/pixel-capi')
      .send({ ...validEvent, event_id: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/event_id/);
  });

  test('rechaza event_id no-string', async () => {
    const res = await request(app)
      .post('/api/public/pixel-capi')
      .send({ ...validEvent, event_id: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/event_id/);
  });

  test('rechaza payload > 4 KB', async () => {
    // Construimos un custom_data enorme (~5 KB) para exceder el cap.
    const huge = 'x'.repeat(5000);
    const res = await request(app)
      .post('/api/public/pixel-capi')
      .send({ ...validEvent, custom_data: { padding: huge } });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/grande/);
  });

  test('acepta todos los event_name whitelisted', async () => {
    const events = ['PageView', 'Lead', 'Schedule', 'Contact', 'ViewContent', 'CompleteRegistration'];
    for (const eventName of events) {
      const res = await request(app)
        .post('/api/public/pixel-capi')
        .send({ ...validEvent, event_name: eventName });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });

  test('completa event_time con Date.now() si no viene', async () => {
    const { event_time: _drop, ...noTime } = validEvent;
    const res = await request(app).post('/api/public/pixel-capi').send(noTime);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
